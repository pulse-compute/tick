import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFastlyKvStore } from '../../../dist/adapters/fastly-kv.js';
import { createKvReceiver } from '../src/receiver.mjs';
import { runProof } from '../scenarios.mjs';

const TOKEN = 't'.repeat(40), EXPERIMENT = 'local-proof';
const record = { contractVersion: 1, mutationId: 'first', state: 'leased', attempt: 1, runDeadlineMs: 60000,
  leaseExpiresAtMs: 1000, attemptToken: 'owner', run: { id: '["tick.run.v1","tick02","a","v1",0]',
    namespace: 'tick02', jobId: 'a', scheduleRevision: 'v1', scheduledForMs: 0 } };

function fixture({ broken = false, live = false, onePop = false, unavailable = false } = {}) {
  const rows = new Map();
  let generation = 9007199254740993n, requestId = 0, calls = 0;
  const transport = async (url, init) => {
    calls++;
    const target = new URL(url);
    const key = decodeURIComponent(target.pathname.split('/keys/')[1]);
    const current = rows.get(key);
    if (unavailable) return new Response(null, { status: 503 });
    if (init.method === 'GET') return current ? new Response(JSON.stringify(current.value),
      { headers: { generation: current.revision } }) : new Response(null, { status: 404 });
    const expected = new Headers(init.headers).get('if-generation-match');
    assert.ok(target.search === '?add=true' || expected !== null, 'never unconditional');
    if (!broken && ((target.search === '?add=true' && current) || (expected && current?.revision !== expected))) {
      return new Response(null, { status: 412 });
    }
    rows.set(key, { value: JSON.parse(init.body), revision: String(++generation) });
    return new Response(null, { status: 204 });
  };
  const deps = { now: () => 2000, requestId: () => `request-${++requestId}`, loadToken: async () => TOKEN,
    metadata: () => ({ receiverPop: live ? onePop || requestId % 2 ? 'IAD' : 'LHR' : 'LOCAL',
      serviceId: live ? 'ABC123PROOFSERVICE' : 'local', serviceVersion: live ? '1' : 'local' }), fetch: transport,
    createStore: ({ signal, fetch }) => createFastlyKvStore({ storeId: 'proof-store',
      token: async () => 'never-persist-this-api-token', fetch, signal }) };
  const handle = createKvReceiver({ experiment: EXPERIMENT }, deps);
  const request = (body, options = {}) => handle(new Request('http://localhost/__tick/kv', { method: 'POST',
    headers: { 'x-tick-probe-token': TOKEN }, body: typeof body === 'string' ? body : JSON.stringify(body), ...options }));
  return { handle, deps, rows, calls: () => calls, request, call: async (body) => {
    const response = await request(body);
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  } };
}

test('bounded handler authenticates and restricts method, path, experiment, keys and body before KV I/O', async () => {
  const f = fixture();
  const body = { operation: 'read', key: `tick02/${EXPERIMENT}/a`, experiment: EXPERIMENT };
  assert.equal((await f.request(body, { headers: {} })).status, 401);
  assert.equal((await f.request(body, { headers: { 'x-tick-probe-token': 'x'.repeat(40) } })).status, 401);
  assert.equal((await f.handle(new Request('http://localhost/__tick/kv'))).status, 405);
  assert.equal((await f.handle(new Request('http://localhost/other'))).status, 404);
  assert.equal((await f.request({ ...body, key: 'elsewhere/a' })).status, 400);
  assert.equal((await f.request({ ...body, key: `tick02/${EXPERIMENT}/../a` })).status, 400);
  assert.equal((await f.request({ ...body, experiment: 'other' })).status, 400);
  assert.equal((await f.request({ ...body, fault: 'lose-write-response' })).status, 400);
  assert.equal((await f.request('x'.repeat(4097))).status, 400);
  assert.equal((await f.request({ experiment: EXPERIMENT, operation: 'compareAndSwap',
    write: { key: body.key, value: record } })).status, 400);
  assert.equal(f.calls(), 0);
});

test('fault is injected after the real adapter transport committed; readback preserves uint64 revision', async () => {
  const f = fixture();
  const key = `tick02/${EXPERIMENT}/a`;
  const result = await f.call({ experiment: EXPERIMENT, operation: 'compareAndSwap', fault: 'lose-write-response',
    write: { key, expected: { kind: 'absent' }, value: record } });
  assert.equal(result.injectedFault, 'lose-write-response');
  assert.equal(result.result.status, 'indeterminate');
  assert.equal(f.rows.get(key).value.mutationId, 'first');
  const read = await f.request({ experiment: EXPERIMENT, operation: 'read', key });
  assert.match(read.headers.get('cache-control'), /no-store/);
  assert.equal((await read.json()).result.revision, '9007199254740994');
});

test('missing resources and host errors are sanitized; deadline cancellation reaches transport', async () => {
  const f = fixture();
  const body = { experiment: EXPERIMENT, operation: 'read', key: `tick02/${EXPERIMENT}/a` };
  const noSecret = createKvReceiver({ experiment: EXPERIMENT }, { ...f.deps,
    loadToken: async () => { throw new Error('secret must not leak'); } });
  const response = await noSecret(new Request('http://localhost/__tick/kv', { method: 'POST',
    headers: { 'x-tick-probe-token': TOKEN }, body: JSON.stringify(body) }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'proof_unavailable' });
  let aborted = false;
  const bounded = createKvReceiver({ experiment: EXPERIMENT, deadlineMs: 5 }, { ...f.deps,
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted = true; reject(new Error('deadline')); }, { once: true })) });
  const stopped = await bounded(new Request('http://localhost/__tick/kv', { method: 'POST',
    headers: { 'x-tick-probe-token': TOKEN }, body: JSON.stringify(body) }));
  assert.equal((await stopped.json()).result.status, 'unavailable');
  assert.equal(aborted, true);
});

test('hosts without AbortController cancel body reads and await host-bounded writes without a signal shim', async () => {
  const f = fixture();
  let completed = false, cancelled = false, calls = 0;
  const host = createKvReceiver({ experiment: EXPERIMENT, deadlineMs: 5 }, { ...f.deps,
    createAbortController: () => undefined,
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.signal, undefined);
      await new Promise((resolve) => setTimeout(resolve, 15));
      completed = true;
      return new Response(null, { status: 204 });
    } });
  const response = await host(new Request('http://localhost/__tick/kv', { method: 'POST',
    headers: { 'x-tick-probe-token': TOKEN }, body: JSON.stringify({ experiment: EXPERIMENT,
      operation: 'compareAndSwap', write: { key: `tick02/${EXPERIMENT}/a`, expected: { kind: 'absent' }, value: record } }) }));
  const observation = await response.json();
  assert.equal(completed, true, 'the handler awaits the operation instead of detaching it at the deadline');
  assert.equal(observation.result.status, 'applied');
  assert.equal(observation.deadlineExceeded, true);
  assert.equal(observation.cancellation, 'host-timeouts');
  const stalled = await host(new Request('http://localhost/__tick/kv', { method: 'POST',
    headers: { 'x-tick-probe-token': TOKEN }, duplex: 'half',
    body: new ReadableStream({ cancel() { cancelled = true; } }) }));
  assert.equal(stalled.status, 400);
  assert.equal(cancelled, true);
  assert.equal(calls, 1, 'a cancelled body never starts storage I/O');
});

test('all scenarios exercise adapter and receiver while synthetic evidence never closes the live gate', async () => {
  const f = fixture();
  const report = await runProof({ call: f.call, experiment: EXPERIMENT, pollDelayMs: 0 });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.cases.length, 8);
  assert.ok(report.cases.every((c) => c.verdict === 'observed'));
  assert.equal(report.evidence.completeTrace, true);
  assert.ok(report.trace.length < 60);
  assert.equal(report.trace.filter((t) => t.response.injectedFault).length, 2);
  assert.ok(!JSON.stringify(report).includes('never-persist-this-api-token'));
  const calls = f.calls();
  const repeated = await runProof({ call: f.call, experiment: EXPERIMENT, pollDelayMs: 0 });
  assert.equal(repeated.verdict, 'inconclusive');
  assert.match(repeated.cases[0].reason, /already exist/);
  assert.equal(f.calls() - calls, 7, 'repeat only reads freshness; no overwrites');
});

test('report requires complete successful scenarios and multiple POPs in both races, not just mode=live', async () => {
  const local = fixture();
  assert.equal((await runProof({ call: local.call, experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0 })).verdict, 'inconclusive');
  const one = fixture({ live: true, onePop: true });
  assert.equal((await runProof({ call: one.call, experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0 })).verdict, 'inconclusive');
  const distributedFixture = fixture({ live: true });
  const report = await runProof({ call: distributedFixture.call, experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0 });
  assert.equal(report.verdict, 'observed', 'fixture tests verdict calculation; this is not deployed evidence');
  assert.equal(report.evidence.distributed, true);
  const late = fixture({ live: true });
  const deadline = await runProof({ experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0, call: async (body) => {
    const observation = await late.call(body);
    observation.deadlineExceeded = true;
    return observation;
  } });
  assert.ok(deadline.cases.every((c) => c.verdict === 'observed'));
  assert.equal(deadline.verdict, 'inconclusive', 'late observations cannot satisfy the distributed gate');
  const mixed = fixture({ live: true });
  let observed = 0;
  const versions = await runProof({ experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0, call: async (body) => {
    const observation = await mixed.call(body);
    observation.serviceVersion = String(++observed % 2 + 1);
    return observation;
  } });
  assert.ok(versions.cases.every((c) => c.verdict === 'observed'));
  assert.equal(versions.verdict, 'inconclusive', 'mixed deployment versions can point at different stores or code');
});

test('multiple winners fail; unavailable reads and incomplete traces are inconclusive', async () => {
  const broken = fixture({ broken: true, live: true });
  const report = await runProof({ call: broken.call, experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0 });
  assert.equal(report.verdict, 'fail');
  assert.equal(report.cases.find((c) => c.name === 'create-race').verdict, 'fail');
  assert.equal(report.cases.find((c) => c.name === 'stale-owner').verdict, 'fail');
  const down = fixture({ unavailable: true });
  assert.equal((await runProof({ call: down.call, experiment: EXPERIMENT, pollDelayMs: 0 })).verdict, 'inconclusive');
  const failed = await runProof({ call: async () => { throw new Error('network'); }, experiment: EXPERIMENT, pollDelayMs: 0 });
  assert.equal(failed.verdict, 'inconclusive');
  assert.equal(failed.evidence.completeTrace, false);
  assert.equal(failed.trace.length, 7);
});

test('reconciliation checks complete semantic records; mutation ID alone cannot accept altered readback', async () => {
  const f = fixture({ live: true });
  const report = await runProof({ experiment: EXPERIMENT, mode: 'live', pollAttempts: 2, pollDelayMs: 0,
    call: async (body) => {
      const observation = await f.call(body);
      if (body.operation === 'read' && body.key.endsWith('/lost-response') && observation.result.status === 'found') {
        observation.result.value.leaseExpiresAtMs++;
      }
      return observation;
    } });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.cases.find((c) => c.name === 'lost-response').verdict, 'inconclusive');
  assert.equal(report.trace.filter((t) => t.request.write?.key.endsWith('/lost-response')).length, 1,
    'mismatched readback never grants a revalidation write');
  const reordered = fixture({ live: true });
  const same = await runProof({ experiment: EXPERIMENT, mode: 'live', pollDelayMs: 0, call: async (body) => {
    const observation = await reordered.call(body);
    if (observation.result.status === 'found') {
      observation.result.value = Object.fromEntries(Object.entries(observation.result.value).reverse());
      observation.result.value.run = Object.fromEntries(Object.entries(observation.result.value.run).reverse());
    }
    return observation;
  } });
  assert.equal(same.verdict, 'observed', 'object property order does not affect full-record equality');
});

test('acknowledged race winners require full readback, including both creation and replacement', async () => {
  for (const name of ['create-race', 'replace-race']) {
    const f = fixture({ live: true });
    let winnerAcknowledged = false;
    const report = await runProof({ experiment: EXPERIMENT, mode: 'live', pollAttempts: 2, pollDelayMs: 0,
      call: async (body) => {
        const observation = await f.call(body);
        if (body.operation === 'compareAndSwap' && body.write.key.endsWith(`/${name}`)
          && body.write.expected.kind === (name === 'create-race' ? 'absent' : 'revision')
          && observation.result.status === 'applied') winnerAcknowledged = true;
        if (body.operation === 'read' && body.key.endsWith(`/${name}`) && winnerAcknowledged) {
          observation.result = { status: 'absent' };
        }
        return observation;
      } });
    assert.equal(winnerAcknowledged, true);
    assert.equal(report.verdict, 'inconclusive');
    assert.equal(report.cases.find((c) => c.name === name).verdict, 'inconclusive');
  }
});

test('CLI rejects existing evidence output before making any request', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tick02-output-'));
  const output = join(folder, 'observations.json');
  await writeFile(output, 'preserve existing evidence');
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.writeHead(503).end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../run.mjs', import.meta.url)),
      '--url', `http://127.0.0.1:${server.address().port}/__tick/kv`, '--experiment', EXPERIMENT, '--out', output],
    { env: { ...process.env, TICK_PROBE_TOKEN: TOKEN } }), /EEXIST/);
    assert.equal(calls, 0);
    assert.equal(await readFile(output, 'utf8'), 'preserve existing evidence');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
