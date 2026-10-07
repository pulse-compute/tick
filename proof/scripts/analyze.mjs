#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PHASES = new Set(['baseline', 'idle', 'redeploy', 'burst']);
const REQUIRED = ['baseline', 'idle', 'redeploy'];
const fail = (message) => { throw new TypeError(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.trim().length > 0;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const localMetadata = (value) => ['local', 'unknown'].includes(value.trim().toLowerCase());

function validateManifest(manifest) {
  if (!object(manifest) || manifest.schema !== 'tick.proof.manifest.v1') fail('Invalid manifest schema');
  if (!['live', 'synthetic'].includes(manifest.mode) || !string(manifest.experiment)) fail('Invalid manifest mode or experiment');
  if (!string(manifest.receiverServiceId)) fail('Invalid manifest receiverServiceId');
  for (const name of ['intervalMs', 'maxGapMs', 'probeTimeoutMs']) {
    if (!integer(manifest[name], 1)) fail(`Invalid manifest ${name}`);
  }
  if (manifest.maxGapMs < manifest.intervalMs) fail('maxGapMs must be at least intervalMs');
  for (const name of ['collectionComplete', 'healthcheckConfigVerified']) {
    if (typeof manifest[name] !== 'boolean') fail(`Manifest ${name} must be boolean`);
  }
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) fail('Manifest phases must be a nonempty array');
  const names = new Set();
  for (const phase of manifest.phases) {
    if (!object(phase) || !PHASES.has(phase.name) || names.has(phase.name)) fail('Invalid or duplicate phase name');
    names.add(phase.name);
    if (!integer(phase.startMs) || !integer(phase.endMs) || phase.endMs <= phase.startMs) fail(`Invalid ${phase.name} time window`);
    if (phase.noExternalTraffic !== undefined && typeof phase.noExternalTraffic !== 'boolean') fail('Invalid noExternalTraffic attestation');
    if (phase.name === 'redeploy') {
      if (!Array.isArray(phase.expectedVersions) || phase.expectedVersions.length !== 2 ||
          !phase.expectedVersions.every(string) || phase.expectedVersions[0] === phase.expectedVersions[1]) {
        fail('redeploy requires two distinct expectedVersions in old/new order');
      }
    }
  }
  const sorted = [...manifest.phases].sort((a, b) => a.startMs - b.startMs);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].startMs < sorted[index - 1].endMs) fail('Phase windows must not overlap');
  }
}

function validateRecord(record, index) {
  const prefix = `Invalid event at index ${index}`;
  if (!object(record) || record.schema !== 'tick.probe.v1' || record.event !== 'arrival') fail(prefix);
  if (!['healthcheck', 'manual'].includes(record.source) || record.responseStatus !== 200) fail(prefix);
  for (const name of ['experiment', 'requestId', 'receiverPop', 'serviceVersion', 'serviceId']) {
    if (!string(record[name])) fail(`${prefix}: ${name}`);
  }
  if (!integer(record.receivedAtMs) || !nonnegative(record.handlerElapsedMs) ||
      (record.responseDelayMs !== undefined && !nonnegative(record.responseDelayMs))) fail(`${prefix}: timing`);
}

function counts(records, key) {
  const result = new Map();
  for (const record of records) result.set(record[key], (result.get(record[key]) ?? 0) + 1);
  return Object.fromEntries([...result].sort(([a], [b]) => a.localeCompare(b)));
}

function distribution(values) {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return { count: sorted.length, min: sorted[0], p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) };
}

function summarize(records, phase, manifest) {
  const times = records.map((record) => record.receivedAtMs);
  const interarrival = times.slice(1).map((time, index) => time - times[index]);
  const boundaries = [phase.startMs, ...times, phase.endMs];
  const gaps = boundaries.slice(1).map((endMs, index) => ({ startMs: boundaries[index], endMs, gapMs: endMs - boundaries[index] }));
  const windows = new Map();
  for (const time of times) {
    const index = Math.floor((time - phase.startMs) / manifest.intervalMs);
    windows.set(index, (windows.get(index) ?? 0) + 1);
  }
  const windowCounts = [...windows.values()];
  return {
    arrivals: records.length,
    firstArrivalMs: times[0] ?? null,
    lastArrivalMs: times.at(-1) ?? null,
    receiverPops: counts(records, 'receiverPop'),
    serviceVersions: counts(records, 'serviceVersion'),
    interarrivalMs: distribution(interarrival),
    maxGapIncludingBoundariesMs: gaps.reduce((maximum, gap) => Math.max(maximum, gap.gapMs), 0),
    excessiveGaps: gaps.filter((gap) => gap.gapMs > manifest.maxGapMs),
    handlerElapsedMs: distribution(records.map((record) => record.handlerElapsedMs)),
    configuredResponseDelayMs: distribution(records.map((record) => record.responseDelayMs ?? 0)),
    handlerBudgetExceeded: records.filter((record) => record.handlerElapsedMs >= manifest.probeTimeoutMs).length,
    arrivalsPerInterval: {
      occupiedWindows: windows.size,
      windowsWithMultipleArrivals: windowCounts.filter((count) => count > 1).length,
      additionalArrivals: windowCounts.reduce((sum, count) => sum + count - 1, 0),
      maxArrivalsInWindow: windowCounts.reduce((maximum, count) => Math.max(maximum, count), 0),
    },
  };
}

/** Analyze authenticated arrival logs; this is evidence accounting, not a scheduler guarantee. */
export function analyze(records, manifest) {
  validateManifest(manifest);
  if (!Array.isArray(records)) fail('Events must be an array');
  const unique = new Map();
  let ignoredOtherExperiment = 0;
  let duplicateLogRecords = 0;
  records.forEach((record, index) => {
    validateRecord(record, index);
    if (record.experiment !== manifest.experiment) { ignoredOtherExperiment++; return; }
    if (record.serviceId !== manifest.receiverServiceId) fail('Event serviceId does not match manifest receiverServiceId');
    const previous = unique.get(record.requestId);
    if (previous) {
      const keys = ['source', 'receivedAtMs', 'receiverPop', 'serviceVersion', 'serviceId', 'handlerElapsedMs', 'responseDelayMs'];
      if (keys.some((key) => previous[key] !== record[key])) fail('Conflicting events share a requestId');
      duplicateLogRecords++;
    } else unique.set(record.requestId, record);
  });
  const arrivals = [...unique.values()].sort((a, b) => a.receivedAtMs - b.receivedAtMs || a.requestId.localeCompare(b.requestId));
  const insufficient = [];
  const violations = [];
  if (manifest.mode !== 'live') insufficient.push('Synthetic evidence cannot establish live trigger continuity');
  if (manifest.mode === 'live' && localMetadata(manifest.receiverServiceId)) insufficient.push('Live receiverServiceId must identify a deployed service');
  if (manifest.mode === 'live' && arrivals.some((record) => record.source === 'healthcheck' &&
      ['receiverPop', 'serviceVersion', 'serviceId'].some((key) => localMetadata(record[key])))) {
    insufficient.push('Local or unknown native metadata cannot establish live continuity');
  }
  if (!manifest.collectionComplete) insufficient.push('Collection is not attested complete');
  if (!manifest.healthcheckConfigVerified) insufficient.push('Native healthcheck configuration is not attested verified');
  for (const name of REQUIRED) {
    if (!manifest.phases.some((phase) => phase.name === name)) insufficient.push(`Missing ${name} phase`);
  }
  const phases = manifest.phases.map((phase) => {
    const inWindow = arrivals.filter((record) => record.receivedAtMs >= phase.startMs && record.receivedAtMs < phase.endMs);
    const native = inWindow.filter((record) => record.source === 'healthcheck');
    const manual = inWindow.filter((record) => record.source === 'manual');
    const healthcheck = summarize(native, phase, manifest);
    const report = { name: phase.name, startMs: phase.startMs, endMs: phase.endMs, healthcheck, manual: summarize(manual, phase, manifest) };
    if (phase.name === 'burst') return report;
    if (phase.endMs - phase.startMs < 3 * manifest.intervalMs) insufficient.push(`${phase.name}: observe at least three intervals`);
    if (native.length < 3) insufficient.push(`${phase.name}: fewer than three unique healthcheck arrivals`);
    if (healthcheck.excessiveGaps.length) violations.push(`${phase.name}: maximum arrival gap exceeded`);
    if (healthcheck.handlerBudgetExceeded) violations.push(`${phase.name}: handler time reached or exceeded probe timeout budget`);
    if (phase.name === 'idle') {
      report.noExternalTrafficAttested = phase.noExternalTraffic === true;
      if (!report.noExternalTrafficAttested) insufficient.push('idle: no-external-traffic attestation is missing');
      if (manual.length) violations.push('idle: manual arrivals contradict no-external-traffic attestation');
    }
    if (phase.name === 'redeploy') {
      const [oldVersion, newVersion] = phase.expectedVersions;
      const oldArrival = native.find((record) => record.serviceVersion === oldVersion);
      const newAfterOld = oldArrival && native.some((record) => record.serviceVersion === newVersion && record.receivedAtMs > oldArrival.receivedAtMs);
      report.expectedVersions = phase.expectedVersions;
      report.expectedTransitionObserved = Boolean(newAfterOld);
      if (!newAfterOld) violations.push('redeploy: expected old-to-new version transition was not observed');
      if (native.some((record) => !phase.expectedVersions.includes(record.serviceVersion))) violations.push('redeploy: unexpected service version observed');
    }
    return report;
  });
  return {
    schema: 'tick.proof.analysis.v1',
    experiment: manifest.experiment,
    receiverServiceId: manifest.receiverServiceId,
    mode: manifest.mode,
    verdict: insufficient.length ? 'inconclusive' : violations.length ? 'fail' : 'pass',
    scope: 'Observed authenticated native-route arrival continuity during the declared experiment only',
    insufficient,
    violations,
    input: {
      records: records.length,
      uniqueArrivals: arrivals.length,
      duplicateLogRecords,
      ignoredOtherExperiment,
      outsidePhaseWindows: arrivals.filter((record) => !manifest.phases.some((phase) => record.receivedAtMs >= phase.startMs && record.receivedAtMs < phase.endMs)).length,
    },
    phases,
    limitations: [
      'Three intervals is a minimum evidence check, not a reliability estimate; operators must choose meaningful observation durations.',
      'Healthcheck source denotes the native endpoint route; attribution relies on secret custody and verified probe configuration.',
      'receiverPop identifies the receiving Compute POP, not the emitting healthcheck POP; native fanout remains unproved.',
      'handlerElapsedMs includes configured delay but excludes response handoff and network latency; this does not prove end-to-end probe timing.',
      'Additional arrivals per interval measure trigger multiplicity, not duplicate job execution; manual burst traffic is reported separately.',
      'Attestations and log completeness are supplied by the operator; exactly-once execution and future scheduler reliability are not established.',
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--events', '--manifest'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || options.has(args[index])) {
      fail('Usage: analyze.mjs --events events.ndjson --manifest manifest.json');
    }
    options.set(args[index], args[index + 1]);
  }
  if (options.size !== 2) fail('Usage: analyze.mjs --events events.ndjson --manifest manifest.json');
  const [rawEvents, rawManifest] = await Promise.all([readFile(options.get('--events'), 'utf8'), readFile(options.get('--manifest'), 'utf8')]);
  let manifest;
  try { manifest = JSON.parse(rawManifest); } catch { fail('Manifest is not valid JSON'); }
  const records = [];
  for (const [index, line] of rawEvents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { fail(`Invalid NDJSON at line ${index + 1}`); }
  }
  process.stdout.write(`${JSON.stringify(analyze(records, manifest), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Do not print input payloads, tokens, or filesystem paths from lower-level errors.
    process.stderr.write(`${error instanceof TypeError ? error.message : 'Unable to read proof input files'}\n`);
    process.exitCode = 1;
  });
}
