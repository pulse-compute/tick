import assert from 'node:assert/strict';
import test from 'node:test';
import { runStoreConformance } from '../../dist/testing/conformance.js';
import { atomicHttp } from '../helpers/atomic-http.mjs';

const options = (fixture, extra = {}) => ({ suiteId: 'test-cohort', prefix: 'conformance/test-cohort/', mode: 'synthetic',
  writers: [fixture.store(), fixture.store()],
  faults: { lostReply: fixture.store({ lostReply: true }), unavailable: fixture.store({ unavailable: true }) }, ...extra });

test('HTTP candidate observes every reusable case with retained state and exact uint64 revisions', async () => {
  const f = atomicHttp(), report = await runStoreConformance(options(f));
  assert.equal(report.status, 'observed', JSON.stringify(report));
  assert.equal(report.certified, false); assert.equal(report.cases.length, 7);
  assert.ok(report.cases.every((value) => value.status === 'observed'));
  assert.ok(report.calls.reads <= report.bounds.reads && report.calls.writes <= report.bounds.writes);
  assert.equal(f.calls.length, report.calls.reads + report.calls.writes - 2); // Unavailable fault never reached the backend.
  assert.ok(f.calls.some((call) => call.revision?.startsWith('1844674407370955')));
  assert.ok(f.rows.size >= 3); assert.ok(f.calls.every((call) => ['GET', 'PUT'].includes(call.method)));
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.equal(JSON.stringify(report).includes('fixture-credential'), false);
  assert.equal(JSON.stringify(report).includes('1844674407370955'), false);
});

test('the same suite accepts opaque revisions without requiring Fastly or a test framework', async () => {
  const rows = new Map(); let revision = 0;
  const capabilities = { atomicCreate: true, atomicReplace: true, scope: 'global-per-key', coherentValueRevision: true, reads: 'possibly-stale' };
  const store = (fault) => ({ capabilities,
    async read(key) { if (fault === 'unavailable') return { status: 'unavailable' };
      const row = rows.get(key); return row ? { status: 'found', ...structuredClone(row) } : { status: 'absent' }; },
    async compareAndSwap({ key, expected, value }) {
      if (fault === 'unavailable') return { status: 'indeterminate' };
      const current = rows.get(key);
      if (expected.kind === 'absent' ? !!current : current?.revision !== expected.revision) return { status: 'conflict' };
      rows.set(key, { value: structuredClone(value), revision: `opaque/r${++revision}/900719925474099300000` });
      return { status: fault === 'lost' ? 'indeterminate' : 'applied' };
    },
  });
  const report = await runStoreConformance({ suiteId: 'opaque', prefix: 'opaque/cohort/', mode: 'synthetic', writers: [store(), store()],
    faults: { lostReply: store('lost'), unavailable: store('unavailable') } });
  assert.equal(report.status, 'observed', JSON.stringify(report));
});

test('missing fault bindings and a live label never imply complete evidence or certification', async () => {
  const f = atomicHttp(); const report = await runStoreConformance(options(f, { faults: undefined, mode: 'live' }));
  assert.equal(report.status, 'inconclusive'); assert.equal(report.certified, false);
  assert.deepEqual(report.cases.slice(-2).map((value) => value.reason), ['fault-not-bound', 'fault-not-bound']);
});

test('a used prefix is inconclusive and records are never reset for a rerun', async () => {
  const f = atomicHttp(); await runStoreConformance(options(f));
  const before = structuredClone([...f.rows]);
  const report = await runStoreConformance(options(f));
  assert.equal(report.status, 'inconclusive'); assert.equal(report.cases[0].reason, 'prefix-in-use');
  assert.deepEqual([...f.rows], before);
});

test('conditional replacement on a missing key must definitively reject', async () => {
  const f = atomicHttp(); const report = await runStoreConformance(options(f, { writers: [f.store({ missingRevisionCreates: true }), f.store({ missingRevisionCreates: true })] }));
  assert.equal(report.status, 'failed');
  assert.equal(report.cases.find((value) => value.name === 'revision-on-missing').reason, 'revision-created-missing-key');
});

test('reusing one revision for different values fails coherence checks', async () => {
  const f = atomicHttp(); const report = await runStoreConformance(options(f, { writers: [f.store({ reuseRevision: true }), f.store({ reuseRevision: true })] }));
  assert.equal(report.status, 'failed');
  assert.ok(report.cases.some((value) => value.reason === 'incoherent-value-revision'));
});

test('stale readback exhausts bounded reads and remains inconclusive', async () => {
  const f = atomicHttp();
  const stale = () => f.store({ readHook: (key, current) => key.endsWith('/race') && current ? new Response(null, { status: 404 }) : undefined });
  const report = await runStoreConformance(options(f, { writers: [stale(), stale()], readRounds: 1 }));
  assert.equal(report.status, 'inconclusive'); assert.equal(report.cases[0].reason, 'readback-not-observed');
  assert.equal(report.cases[0].reads, 4); assert.ok(report.calls.reads <= report.bounds.reads);
});

test('loss of a committed reply cannot be classified as conflict', async () => {
  const f = atomicHttp(), lost = f.store({ lostReply: true });
  const misleading = { ...lost, compareAndSwap: async (operation) => { await lost.compareAndSwap(operation); return { status: 'conflict' }; } };
  const report = await runStoreConformance(options(f, { faults: { lostReply: misleading, unavailable: f.store({ unavailable: true }) } }));
  assert.equal(report.status, 'failed'); assert.equal(report.cases.find((value) => value.name === 'lost-reply').reason, 'lost-reply-misclassified');
});

test('numeric revisions and malformed write statuses fail the adapter contract', async () => {
  for (const fault of ['revision', 'status']) {
    const f = atomicHttp(), store = f.store();
    const malformed = { ...store, async read(key) { const result = await store.read(key);
      return fault === 'revision' && result.status === 'found' ? { ...result, revision: Number(result.revision) } : result; },
    async compareAndSwap(operation) { const result = await store.compareAndSwap(operation); return fault === 'status' ? { status: 'maybe', secret: 'private-result' } : result; } };
    const report = await runStoreConformance(options(f, { writers: [malformed, malformed] }));
    assert.equal(report.status, 'failed'); assert.equal(JSON.stringify(report).includes('private-result'), false);
  }
});

test('a read/put emulation with two acknowledged creates fails even when a third contender throws', async () => {
  for (const withThrow of [false, true]) {
    const f = atomicHttp(), original = f.store(), rows = new Map();
    const weak = { ...original, async read(key) { const row = rows.get(key); return row ? { status: 'found', ...structuredClone(row) } : { status: 'absent' }; },
      async compareAndSwap({ key, expected, value }) {
        const current = rows.get(key);
        if (expected.kind === 'absent' ? !!current : current?.revision !== expected.revision) return { status: 'conflict' };
        await Promise.resolve(); // Deliberately release the condition before mutation.
        rows.set(key, { value, revision: value.mutationId }); return { status: 'applied' };
      } };
    const throwing = { ...weak, async compareAndSwap(operation) { if (operation.key.endsWith('/race')) throw new Error('private-missing-contender'); return weak.compareAndSwap(operation); } };
    const report = await runStoreConformance(options(f, { writers: withThrow ? [weak, weak, throwing] : [weak, weak], faults: undefined }));
    assert.equal(report.status, 'failed'); assert.equal(report.cases[0].reason, 'multiple-acknowledged-winners');
  }
});

test('all contending writes are awaited when another writer throws', async () => {
  const f = atomicHttp(), store = f.store(); let release, started;
  const waiting = new Promise((yes) => { release = yes; }), ready = new Promise((yes) => { started = yes; });
  const broken = { ...store, async compareAndSwap(operation) { if (operation.key.endsWith('/race')) throw new Error('private-write-error'); return store.compareAndSwap(operation); } };
  const delayed = { ...store, async compareAndSwap(operation) { if (operation.key.endsWith('/race')) { started(); await waiting; } return store.compareAndSwap(operation); } };
  let returned = false;
  const running = runStoreConformance(options(f, { writers: [broken, delayed] })).then((value) => { returned = true; return value; });
  await ready; await Promise.resolve(); assert.equal(returned, false);
  release(); const report = await running;
  assert.equal(report.status, 'inconclusive'); assert.equal(report.cases[0].reason, 'write-threw');
  assert.equal(JSON.stringify(report).includes('private-write-error'), false);
});

test('invalid suite bounds and unsupported capabilities reject before adapter I/O', async () => {
  const f = atomicHttp();
  for (const extra of [{ prefix: '' }, { prefix: '../unsafe/' }, { suiteId: '' }, { mode: 'test' }, { readRounds: 9 }, { writers: [f.store()] },
    { writers: [f.store(), { ...f.store(), capabilities: { atomicCreate: true } }] }, { writers: new Array(2) }, { faults: { lostReply: null } }]) {
    await assert.rejects(runStoreConformance(options(f, extra)), TypeError);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(runStoreConformance({ ...options(f), get prefix() { throw new Error('private-prefix'); } }),
    { name: 'TypeError', message: 'Invalid Tick conformance configuration' });
});
