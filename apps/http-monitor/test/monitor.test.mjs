import assert from 'node:assert/strict';
import test from 'node:test';
import { createCooperativeController } from '@pulse-compute/tick/cancellation';
import { createMonitorApp } from '../build/app.js';
import { createMonitorJob, validObservation } from '../build/monitor.js';
import { createHttpProbe, createS3Observations, createPulseProbe, observationKey } from '../build/resources.js';
import { signRequest } from '../build/sigv4.js';
import { atomicHttp } from '../../../test/helpers/atomic-http.mjs';

const endpoint = 'https://observations.s3.us-east-1.amazonaws.com';
const run = (slot = 0) => ({ id: JSON.stringify(['tick.run.v1', 'monitor-test', 'homepage', 'v1', slot]), namespace: 'monitor-test', jobId: 'homepage', scheduleRevision: 'v1', scheduledForMs: slot });
const observation = (changes = {}) => ({ schema: 'tick.http.observation.v1', run: run(), attempt: 1, startedAtMs: 1000, observedAtMs: 1010, durationMs: 10, httpStatus: 200, outcome: 'up', ...changes });
const missing = (code = 'NoSuchKey', headers = {}) => new Response(`<Error><Code>${code}</Code></Error>`, { status: 404, headers });

function fixture({ status = 200, probeThrow = false, lostPut = false, lostClaim = false, lostSettlement = false, unavailableRead = false, pulse } = {}) {
  const kv = atomicHttp(), rows = new Map(), effects = [], s3Calls = [], timers = new Set();
  let wall = 1000, mono = 0, ids = 0, settlementLost = false;
  const fixtureTransport = kv.transport();
  const kvTransport = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/keys/')[1]);
    if (lostClaim && init.method === 'PUT' && key.startsWith('jobs/')) throw new Error('private-unknown-claim');
    if (settlementLost && init.method === 'GET' && key.startsWith('jobs/')) return new Response(null, { status: 503 });
    if (lostSettlement && init.method === 'PUT' && key.startsWith('jobs/') && JSON.parse(init.body).state === 'completed') {
      settlementLost = true; throw new Error('private-settlement-transport'); // Crash window after S3, before KV commit.
    }
    return fixtureTransport(url, init);
  };
  const s3Transport = async (url, init) => {
    s3Calls.push({ method: init.method, key: new URL(url).pathname, body: init.body });
    assert.equal(new URL(url).origin, endpoint); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'manual');
    const key = new URL(url).pathname;
    if (init.method === 'GET') {
      if (unavailableRead) throw new Error('private-read-payload');
      return rows.has(key) ? new Response(rows.get(key)) : missing();
    }
    assert.equal(init.headers.get('if-none-match'), '*'); assert.equal(init.headers.has('if-match'), false);
    if (rows.has(key)) return new Response(null, { status: 412 });
    if (lostPut === 'before') throw new Error('private-put-before-commit');
    rows.set(key, init.body); if (lostPut) throw new Error('private-lost-put'); return new Response();
  };
  const probe = pulse ? createPulseProbe(pulse) : createHttpProbe({ target: 'https://target.example/health', fetch: async (url, init) => {
    effects.push({ url, init }); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    if (probeThrow) throw new Error('private-probe-body'); return new Response('private-response-body', { status });
  } });
  const settings = { namespace: 'monitor-test', monitorId: 'homepage', coordinationPrefix: 'jobs/', admissionPrefix: 'admission/',
    schedule: { kind: 'interval', anchorMs: 0, everyMs: 60000, revision: 'v1', missedWindows: 'skip' },
    admissionSchedule: { kind: 'interval', anchorMs: 0, everyMs: 100, revision: 'v1', missedWindows: 'skip' },
    limits: { maxJobsPerTick: 1, maxAttemptsPerRun: 3, leaseMs: 1000, runTimeoutMs: 5000, retryDelayMs: 10, maxClockSkewMs: 0, deadlineSafetyMs: 1 }, requestTimeoutMs: 2000 };
  const clock = { nowMs: () => wall, monotonicMs: () => mono };
  const resources = { probe, observations: createS3Observations({ endpoint, prefix: 'observations/', fetch: s3Transport }) };
  const app = createMonitorApp(settings, { kv: { storeId: 'test-store', token: async () => 'fixture-credential', fetch: kvTransport },
    clock, resources, ids: { newAttemptToken: () => `owner-${++ids}`, newMutationId: () => `mutation-${++ids}` },
    runtime: { createCancellationController: createCooperativeController, setTimer(callback, ms) { const timer = { at: mono + ms, callback }; timers.add(timer); return () => timers.delete(timer); } },
    loadToken: async () => 'x'.repeat(40), requestId: () => `request-${++ids}` });
  return { app, kv, rows, effects, s3Calls, settings, resources, clock, timers,
    setLostPut(value) { lostPut = value; }, recoverSettlement() { settlementLost = false; lostSettlement = false; },
    advance(ms) { wall += ms; mono += ms; for (const timer of [...timers]) if (timer.at <= mono) timer.callback(); },
    invoke: () => app.runner.tick({ requestId: `invocation-${++ids}`, deadlineMs: wall + 2000, signal: createCooperativeController().signal }),
    request: (token = 'x'.repeat(40)) => new Request('https://receiver.example/__tick/run', { headers: { 'x-tick-probe-token': token } }) };
}

test('practical monitor persists one immutable up observation, settles KV, and suppresses duplicate runs', async () => {
  const f = fixture(); assert.equal(f.effects.length + f.s3Calls.length + f.kv.calls.length, 0);
  const first = await f.invoke(); assert.equal(first.results[0].record.state, 'completed');
  assert.equal(f.rows.size, 1); assert.equal(f.effects.length, 1); assert.equal(f.s3Calls.length, 2);
  const saved = JSON.parse([...f.rows.values()][0]); assert.equal(validObservation(saved), true); assert.equal(saved.outcome, 'up');
  await f.invoke(); assert.equal(f.effects.length, 1); assert.equal(f.s3Calls.length, 2);
  assert.equal(JSON.stringify(saved).includes('target.example'), false); assert.equal(JSON.stringify(first).includes('private-response'), false);
});

test('non-2xx and network failure are completed health data, not execution retries', async () => {
  for (const options of [{ status: 503 }, { status: 302 }, { probeThrow: true }]) {
    const f = fixture(options), result = await f.invoke(); assert.equal(result.results[0].outcome, 'completed');
    const saved = JSON.parse([...f.rows.values()][0]); assert.equal(saved.outcome, options.probeThrow ? 'unreachable' : 'down');
    assert.equal(saved.httpStatus, options.probeThrow ? null : options.status);
    assert.equal(JSON.stringify(saved).includes('private'), false);
  }
});

test('lost S3 reply retries the same run, recovers its retained snapshot and does not probe again', async () => {
  const f = fixture({ lostPut: true }); const first = await f.invoke();
  assert.equal(first.results[0].outcome, 'retry'); assert.equal(first.results[0].failureCode, 'observation-indeterminate');
  assert.equal(f.rows.size, 1); f.setLostPut(false); f.advance(20);
  const second = await f.invoke(); assert.equal(second.results[0].record.state, 'completed'); assert.equal(second.results[0].attempt, 2);
  assert.equal(f.effects.length, 1); assert.equal(f.s3Calls.filter((c) => c.method === 'PUT').length, 1);
});

test('an unknown save without a commit can probe again, while retaining only the first successful snapshot', async () => {
  const f = fixture({ lostPut: 'before' }), first = await f.invoke();
  assert.equal(first.results[0].outcome, 'retry'); assert.equal(f.rows.size, 0);
  f.setLostPut(false); f.advance(20); const second = await f.invoke();
  assert.equal(second.results[0].record.state, 'completed'); assert.equal(second.results[0].attempt, 2);
  assert.equal(f.effects.length, 2); assert.equal(f.rows.size, 1);
  assert.equal(JSON.parse([...f.rows.values()][0]).attempt, 2);
});

test('an indeterminate KV claim grants no authority to probe or read/write application observations', async () => {
  const f = fixture({ lostClaim: true }), result = await f.invoke();
  assert.equal(result.results[0].coordination, 'unresolved');
  assert.equal(f.effects.length, 0); assert.equal(f.s3Calls.length, 0);
});

test('an unavailable observation read fails closed before the monitored HTTP request', async () => {
  const f = fixture({ unavailableRead: true }), result = await f.invoke();
  assert.equal(result.results[0].outcome, 'retry'); assert.equal(f.effects.length, 0); assert.equal(f.rows.size, 0);
});

test('saved observation survives an uncertain KV settlement and expired takeover without another probe', async () => {
  const f = fixture({ lostSettlement: true }), first = await f.invoke(); assert.equal(first.results[0].coordination, 'unavailable');
  assert.equal(f.rows.size, 1); f.recoverSettlement(); f.advance(1001); const second = await f.invoke(); assert.equal(second.results[0].attempt, 2); assert.equal(second.results[0].record.state, 'completed'); assert.equal(f.effects.length, 1);
});

test('authenticated duplicate admission limits monitor effects to one probe and one snapshot', async () => {
  const f = fixture(); assert.equal((await f.app.handle(f.request('wrong'))).status, 401); assert.equal(f.kv.calls.length, 0);
  const replies = await Promise.all(Array.from({ length: 16 }, () => f.app.handle(f.request())));
  const rows = await Promise.all(replies.map((r) => r.json())); assert.ok(replies.every((r) => r.status === 200));
  assert.equal(rows.filter((r) => r.admission.status === 'owned').length, 1); assert.equal(f.effects.length, 1); assert.equal(f.rows.size, 1);
  assert.ok(rows.filter((r) => r.admission.status !== 'owned').every((r) => r.metrics.jobReads === 0));
});

test('Pulse probe shim receives only deadline/cancellation, and Tick owns coordination and observation persistence', async () => {
  const inputs = [], f = fixture({ pulse: async (input) => { inputs.push(input); return { httpStatus: 204 }; } });
  const result = await f.invoke(); assert.equal(result.results[0].record.state, 'completed'); assert.equal(inputs.length, 1);
  assert.deepEqual(Object.keys(inputs[0]).sort(), ['deadlineMs', 'signal']); assert.equal(Object.isFrozen(inputs[0]), true);
  assert.equal('run' in inputs[0], false); assert.equal('attemptToken' in inputs[0], false); assert.equal(f.rows.size, 1);
});

test('cancellation/monotonic exhaustion after a probe prevents a subsequent snapshot write', async () => {
  for (const mode of ['abort', 'elapsed', 'rollback']) {
    const controller = createCooperativeController(); let mono = 0, wall = 1000, writes = 0;
    const job = createMonitorJob({ nowMs: () => wall, monotonicMs: () => mono });
    await assert.rejects(job({ run: run(), attempt: 1, attemptToken: 'fixture-owner', deadlineMs: 1100, signal: controller.signal }, {
      probe: { async check() { if (mode === 'abort') controller.abort(); if (mode === 'elapsed') mono = 101; if (mode === 'rollback') wall = 999; return { httpStatus: 200 }; } },
      observations: { async read() { return { status: 'absent' }; }, async putIfAbsent() { writes++; return { status: 'saved' }; } },
    })); assert.equal(writes, 0);
  }
});

test('a conditional snapshot loser reuses a validated first winner, including its earlier attempt', async () => {
  let reads = 0;
  const job = createMonitorJob({ nowMs: () => 1010, monotonicMs: () => 0 });
  await job({ run: run(), attempt: 2, attemptToken: 'fixture-owner', deadlineMs: 2000, signal: createCooperativeController().signal }, {
    probe: { async check() { return { httpStatus: 503 }; } }, observations: {
      async read() { return ++reads === 1 ? { status: 'absent' } : { status: 'found', value: observation() }; },
      async putIfAbsent() { return { status: 'exists' }; },
    },
  }); assert.equal(reads, 2);
});

test('S3 observations use a stable run key across attempts and reject malformed/foreign snapshots', async () => {
  const calls = [], store = createS3Observations({ endpoint, prefix: 'observations/', fetch: async (url, init) => { calls.push({ url, init }); return new Response(); } });
  await store.putIfAbsent(observation()); await store.putIfAbsent(observation({ attempt: 2 }));
  assert.equal(calls[0].url, calls[1].url); assert.equal(calls[0].init.headers.get('if-none-match'), '*');
  assert.notEqual(observationKey('observations/', run()), observationKey('observations/', run(60000)));
  for (const value of [observation({ run: run(60000) }), observation({ unknown: 'secret' }), observation({ outcome: 'up', httpStatus: 500 }), observation({ durationMs: -1 })]) {
    const reader = createS3Observations({ endpoint, prefix: 'observations/', fetch: async () => new Response(JSON.stringify(value)) });
    assert.equal((await reader.read(run())).status, 'unavailable');
  }
});

test('S3 observations classify unknown outcomes without retry, and generic 404/delete markers fail closed', async () => {
  for (const status of [200, 201, 204, 202, 307, 409, 412, 429, 503]) {
    let calls = 0; const store = createS3Observations({ endpoint, prefix: 'observations/', fetch: async () => { calls++; return new Response(null, { status }); } });
    assert.equal((await store.putIfAbsent(observation())).status, status === 200 ? 'saved' : status === 412 ? 'exists' : 'indeterminate'); assert.equal(calls, 1);
  }
  for (const response of [() => missing('NoSuchBucket'), () => missing('NoSuchKey', { 'x-amz-delete-marker': 'true' }),
    () => new Response('Not found', { status: 404 }), () => new Response('x'.repeat(4097))]) {
    assert.equal((await createS3Observations({ endpoint, prefix: 'observations/', fetch: async () => response() }).read(run())).status, 'unavailable');
  }
});

test('explicit native signal reaches HTTP and S3 transports; cooperative signal is never cast to native', async () => {
  const controller = new AbortController(), context = { run: run(), attempt: 1, attemptToken: 'owner', deadlineMs: 2000, signal: controller.signal, transportSignal: controller.signal };
  const signals = [], fetch = async (_url, init) => { signals.push(init.signal); return init.method === 'GET' ? missing() : new Response(); };
  const probe = createHttpProbe({ target: 'https://target.example/', fetch }); await probe.check(context);
  const s3 = createS3Observations({ endpoint, prefix: 'observations/', fetch }); await s3.read(run(), controller.signal); await s3.putIfAbsent(observation(), controller.signal);
  assert.ok(signals.every((s) => s === controller.signal));
});

test('invalid targets, prefixes and record writes reject before I/O; source payloads cannot be serialized into observations', async () => {
  let calls = 0; const fetch = async () => { calls++; return new Response(); };
  for (const target of ['http://target/', 'https://user:secret@target/', 'https://target/?token=secret', 'https://target/#secret']) assert.throws(() => createHttpProbe({ target, fetch }), /Invalid monitor probe/);
  assert.throws(() => createS3Observations({ endpoint, prefix: '../app/', fetch }), /Invalid S3 observation binding/);
  const store = createS3Observations({ endpoint, prefix: 'observations/', fetch });
  await assert.rejects(store.putIfAbsent(observation({ rawBody: 'secret' })), /Invalid monitor observation/);
  await assert.rejects(store.read({ ...run(), id: 'forged' }), /Invalid observation identity/);
  assert.equal(calls, 0);
});

test('application signer matches the public AWS signature vector and signs the immutable write condition', async () => {
  // Published AWS test credentials, not usable secrets.
  const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const result = await signRequest('https://examplebucket.s3.amazonaws.com/test.txt', { method: 'GET', headers: { range: 'bytes=0-9' } }, credentials, 'us-east-1', Date.parse('2013-05-24T00:00:00Z'));
  assert.match(result.headers.get('authorization'), /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const put = await signRequest(endpoint + '/snapshot', { method: 'PUT', body: 'snapshot', headers: { 'if-none-match': '*' } }, credentials, 'us-east-1', 0);
  assert.match(put.headers.get('authorization'), /SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/);
});
