import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../scripts/analyze.mjs';

function fixture() {
  const manifest = {
    schema: 'tick.proof.manifest.v1', mode: 'live', experiment: 'test', receiverServiceId: 'receiver-service',
    intervalMs: 1000, maxGapMs: 1500, probeTimeoutMs: 500,
    collectionComplete: true, healthcheckConfigVerified: true,
    phases: [
      { name: 'baseline', startMs: 0, endMs: 3000 },
      { name: 'idle', startMs: 3000, endMs: 6000, noExternalTraffic: true },
      { name: 'redeploy', startMs: 6000, endMs: 9000, expectedVersions: ['1', '2'] },
      { name: 'burst', startMs: 9000, endMs: 10000 },
    ],
  };
  const records = Array.from({ length: 9 }, (_, index) => ({
    schema: 'tick.probe.v1', event: 'arrival', experiment: 'test', source: 'healthcheck',
    requestId: `request-${index}`, receivedAtMs: index * 1000 + 100,
    receiverPop: index % 2 ? 'IAD' : 'LAX', serviceVersion: index < 7 ? '1' : '2', serviceId: 'receiver-service',
    responseStatus: 200, handlerElapsedMs: 1,
  }));
  return { manifest, records };
}

test('complete native evidence passes only the bounded continuity experiment', () => {
  const { manifest, records } = fixture();
  const result = analyze(records.reverse(), manifest);
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.insufficient, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.phases[0].healthcheck.maxGapIncludingBoundariesMs, 1000);
  assert.deepEqual(result.phases[0].healthcheck.receiverPops, { IAD: 1, LAX: 2 });
  assert.equal(result.phases[2].expectedTransitionObserved, true);
  assert.ok(result.limitations.some((line) => line.includes('not the emitting')));
});

test('synthetic records and manual requests cannot prove live native continuity', () => {
  const { manifest, records } = fixture();
  assert.equal(analyze(records, { ...manifest, mode: 'synthetic' }).verdict, 'inconclusive');
  const manual = records.map((record) => ({ ...record, source: 'manual' }));
  const result = analyze(manual, manifest);
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.phases[0].healthcheck.arrivals, 0);
  assert.equal(result.phases[0].manual.arrivals, 3);
});

test('collection, probe setup and idle traffic attestations are independently required', () => {
  for (const property of ['collectionComplete', 'healthcheckConfigVerified']) {
    const { manifest, records } = fixture();
    manifest[property] = false;
    assert.equal(analyze(records, manifest).verdict, 'inconclusive', property);
  }
  const { manifest, records } = fixture();
  delete manifest.phases[1].noExternalTraffic;
  assert.equal(analyze(records, manifest).verdict, 'inconclusive');
});

test('phase boundary gaps count even with several closely clustered arrivals', () => {
  const { manifest, records } = fixture();
  records[0].receivedAtMs = 10;
  records[1].receivedAtMs = 20;
  records[2].receivedAtMs = 30;
  const result = analyze(records, manifest);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.phases[0].healthcheck.excessiveGaps, [{ startMs: 30, endMs: 3000, gapMs: 2970 }]);
  records[0].receivedAtMs = 2600;
  records[1].receivedAtMs = 2700;
  records[2].receivedAtMs = 2800;
  assert.equal(analyze(records, manifest).phases[0].healthcheck.excessiveGaps[0].startMs, 0);
});

test('deduplicates repeated log delivery without removing distinct same-window arrivals', () => {
  const { manifest, records } = fixture();
  records.push({ ...records[0] });
  records.push({ ...records[0], requestId: 'concurrent', receivedAtMs: 101 });
  const result = analyze(records, manifest);
  assert.equal(result.input.duplicateLogRecords, 1);
  assert.equal(result.phases[0].healthcheck.arrivals, 4);
  assert.equal(result.phases[0].healthcheck.arrivalsPerInterval.additionalArrivals, 1);
  assert.equal(result.phases[0].healthcheck.arrivalsPerInterval.maxArrivalsInWindow, 2);
  records.push({ ...records[0], receivedAtMs: 102 });
  assert.throws(() => analyze(records, manifest), /Conflicting/);
});

test('uses half-open windows and ignores other experiments for continuity', () => {
  const { manifest, records } = fixture();
  records.push({ ...records[0], requestId: 'outside', receivedAtMs: 10000 });
  records.push({ ...records[0], requestId: 'other', experiment: 'different' });
  records.push({ ...records[0], requestId: 'at-boundary', receivedAtMs: 3000 });
  const result = analyze(records, manifest);
  assert.equal(result.input.outsidePhaseWindows, 1);
  assert.equal(result.input.ignoredOtherExperiment, 1);
  assert.equal(result.phases[0].healthcheck.arrivals, 3);
  assert.equal(result.phases[1].healthcheck.arrivals, 4);
});

test('manual burst is separate and cannot cause a continuity pass or native multiplicity', () => {
  const { manifest, records } = fixture();
  for (let index = 0; index < 20; index++) records.push({ ...records[0], requestId: `burst-${index}`, source: 'manual', receivedAtMs: 9100 });
  const result = analyze(records, manifest);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.phases[3].manual.arrivals, 20);
  assert.equal(result.phases[3].healthcheck.arrivals, 0);
  records.push({ ...records[0], requestId: 'idle-manual', source: 'manual', receivedAtMs: 3500 });
  assert.equal(analyze(records, manifest).verdict, 'fail');
});

test('redeploy requires expected versions in temporal order but permits rollout overlap', () => {
  const { manifest, records } = fixture();
  records[7].serviceVersion = '1';
  records[8].serviceVersion = '1';
  assert.equal(analyze(records, manifest).verdict, 'fail');
  records[7].serviceVersion = '2';
  assert.equal(analyze(records, manifest).verdict, 'pass');
  records[8].serviceVersion = 'unexpected';
  assert.equal(analyze(records, manifest).verdict, 'fail');
});

test('cannot combine two receiver services to satisfy a deployment transition', () => {
  const { manifest, records } = fixture();
  records[7].serviceId = 'different-receiver';
  assert.throws(() => analyze(records, manifest), /serviceId does not match/);
  const otherExperiment = { ...records[7], experiment: 'different-experiment' };
  records[7].serviceId = manifest.receiverServiceId;
  assert.equal(analyze([...records, otherExperiment], manifest).verdict, 'pass');
});

test('local and unknown metadata cannot establish live evidence', () => {
  for (const key of ['receiverPop', 'serviceVersion', 'serviceId']) {
    for (const sentinel of ['local', 'unknown', ' UNKNOWN ']) {
      const { manifest, records } = fixture();
      if (key === 'serviceId') {
        manifest.receiverServiceId = sentinel;
        for (const record of records) record.serviceId = sentinel;
      } else records[0][key] = sentinel;
      assert.equal(analyze(records, manifest).verdict, 'inconclusive', `${key}: ${sentinel}`);
    }
  }
  const { manifest, records } = fixture();
  records.push({ ...records[0], requestId: 'local-outside-phase', receivedAtMs: 11000, receiverPop: 'local' });
  assert.equal(analyze(records, manifest).verdict, 'inconclusive');
});

test('reports in-handler timing without double counting configured hold', () => {
  const { manifest, records } = fixture();
  records[0].handlerElapsedMs = 499;
  records[0].responseDelayMs = 400;
  assert.equal(analyze(records, manifest).verdict, 'pass');
  records[0].handlerElapsedMs = 500;
  const result = analyze(records, manifest);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.phases[0].healthcheck.handlerElapsedMs.max, 500);
  assert.equal(result.phases[0].healthcheck.configuredResponseDelayMs.max, 400);
});

test('missing, empty or too short phases are inconclusive', () => {
  const { manifest, records } = fixture();
  assert.equal(analyze([], manifest).verdict, 'inconclusive');
  manifest.phases = manifest.phases.filter((phase) => phase.name !== 'idle');
  assert.equal(analyze(records, manifest).verdict, 'inconclusive');
  manifest.phases[0].endMs = 2000;
  assert.equal(analyze(records, manifest).verdict, 'inconclusive');
});

test('rejects malformed evidence and invalid or overlapping manifests', () => {
  const { manifest, records } = fixture();
  for (const replacement of [{ startMs: 3000 }, { endMs: -1 }, { endMs: 3001 }, { startMs: NaN }]) {
    const changed = structuredClone(manifest);
    Object.assign(changed.phases[0], replacement);
    assert.throws(() => analyze(records, changed));
  }
  for (const replacement of [{ intervalMs: 0 }, { maxGapMs: 1 }, { probeTimeoutMs: Infinity }, { collectionComplete: 'true' }, { receiverServiceId: '' }]) {
    assert.throws(() => analyze(records, { ...manifest, ...replacement }));
  }
  for (const replacement of [{ responseStatus: 403 }, { receivedAtMs: -1 }, { handlerElapsedMs: NaN }, { source: 'claimed-native' }, { requestId: '' }, { serviceId: undefined }]) {
    assert.throws(() => analyze([{ ...records[0], ...replacement }], manifest));
  }
});

test('CLI reads NDJSON, emits report JSON and avoids echoing malformed input secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tick-analyzer-'));
  const script = fileURLToPath(new URL('../scripts/analyze.mjs', import.meta.url));
  try {
    const { manifest, records } = fixture();
    const eventsPath = join(directory, 'events.ndjson');
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(eventsPath, records.map((record) => JSON.stringify(record)).join('\n'));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const args = [script, '--events', eventsPath, '--manifest', manifestPath];
    assert.equal(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })).verdict, 'pass');
    await writeFile(eventsPath, '{secret-token-do-not-echo');
    const failed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Invalid NDJSON at line 1/);
    assert.doesNotMatch(failed.stderr, /secret-token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
