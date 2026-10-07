import test from 'node:test';
import assert from 'node:assert/strict';
import { createFastlyKvStore } from '../../dist/adapters/fastly-kv.js';

const revision = '18446744073709551615';
function record(overrides = {}) {
  return {
    contractVersion: 1, mutationId: 'mutation-1',
    run: { id: JSON.stringify(['tick.run.v1', 'test', 'job', 'v1', 0]), namespace: 'test', jobId: 'job', scheduleRevision: 'v1', scheduledForMs: 0 },
    state: 'leased', attempt: 1, attemptToken: 'owner-1', leaseExpiresAtMs: 1000, runDeadlineMs: 5000, ...overrides,
  };
}
const make = (fetch, extra = {}) => createFastlyKvStore({ storeId: 'test-store', token: async () => 'test-credential', fetch, ...extra });
const found = (value = record(), generation = revision) => new Response(JSON.stringify(value), { headers: { generation } });

test('read preserves the exact uint64 generation from the same response as the value', async () => {
  let calls = 0;
  const store = make(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.fastly.com/resources/stores/kv/test-store/keys/prefix%2F%5B%22job%22%5D');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.get('Fastly-Key'), 'test-credential');
    return found();
  });
  assert.deepEqual(await store.read('prefix/["job"]'), { status: 'found', value: record(), revision });
  assert.equal(calls, 1);
});

test('absence and revision writes always send a provider condition; never TTL or numeric generation', async () => {
  const calls = [];
  const store = make(async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); });
  assert.equal((await store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() })).status, 'applied');
  assert.equal((await store.compareAndSwap({ key: 'job', expected: { kind: 'revision', revision }, value: record() })).status, 'applied');
  assert.match(calls[0].url, /\/job\?add=true$/);
  assert.equal(calls[0].init.headers.has('if-generation-match'), false);
  assert.match(calls[1].url, /\/job$/);
  assert.equal(calls[1].init.headers.get('if-generation-match'), revision);
  assert.equal(calls[1].init.headers.has('time_to_live_sec'), false);
  assert.deepEqual(JSON.parse(calls[1].init.body), record());
});

test('only definitive precondition rejection is conflict; uncertain outcomes never grant ownership', async () => {
  for (const status of [200, 201, 204, 202, 301, 401, 403, 404, 409, 412, 429, 500, 503]) {
    let calls = 0;
    const store = make(async () => { calls++; return new Response(null, { status }); });
    const result = await store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() });
    assert.equal(result.status, status === 412 ? 'conflict' : [200, 201, 204].includes(status) ? 'applied' : 'indeterminate', `${status}`);
    assert.equal(calls, 1, 'No automatic write retry');
  }
  const store = make(async () => { throw new Error('private upstream details'); });
  assert.deepEqual(await store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() }), { status: 'indeterminate' });
  assert.deepEqual(await store.read('job'), { status: 'unavailable' });
});

test('a committed write with a lost reply is indeterminate, even when readback finds its mutation', async () => {
  let saved;
  const store = make(async (_url, init) => {
    if (init.method === 'PUT') { saved = JSON.parse(init.body); throw new Error('reply lost after commit'); }
    return found(saved);
  });
  assert.deepEqual(await store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() }), { status: 'indeterminate' });
  const read = await store.read('job');
  assert.equal(read.status, 'found');
  assert.equal(read.value.mutationId, 'mutation-1');
  // Finding a past mutation is not an ownership decision; this adapter never dispatches work.
});

test('missing, malformed, oversized, or incompatible reads fail closed', async () => {
  const responses = [
    () => new Response(null, { status: 500 }),
    () => new Response('{}'),
    () => found(record(), '9007199254740993.0'),
    () => found(record(), '18446744073709551616'),
    () => found(record(), '01'),
    () => found(record(), '0'),
    () => found(record({ contractVersion: 2 })),
    () => found(record({ attempt: 0 })),
    () => found(record({ state: 'unknown' })),
    () => found(record({ unexpected: 'payload' })),
    () => found(record({ run: { ...record().run, id: 'not-the-canonical-id' } })),
    () => new Response('{', { headers: { generation: revision } }),
    () => new Response('x'.repeat(16385), { headers: { generation: revision } }),
  ];
  for (const response of responses) assert.deepEqual(await make(async () => response()).read('job'), { status: 'unavailable' });
  assert.deepEqual(await make(async () => new Response(null, { status: 404 })).read('job'), { status: 'absent' });
});

test('invalid configuration and writes are rejected before any I/O', async () => {
  let calls = 0;
  const store = make(async () => { calls++; return found(); });
  for (const key of ['', '.', '..', '.well-known/acme-challenge/x', 'x?y', 'x\ny', 'é'.repeat(513)]) {
    await assert.rejects(store.read(key), /Invalid Fastly KV key/);
  }
  for (const expected of [undefined, { kind: 'overwrite' }, { kind: 'revision', revision: 9007199254740992 }, { kind: 'revision', revision: '1e9' }, { kind: 'revision', revision: '0' }]) {
    await assert.rejects(store.compareAndSwap({ key: 'job', expected, value: record() }), /Invalid Fastly KV conditional write/);
  }
  await assert.rejects(store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: { state: 'leased' } }), /Invalid Fastly KV conditional write/);
  assert.throws(() => make(async () => found(), { storeId: '../other' }), /Invalid Fastly KV binding/);
  assert.equal(calls, 0);
});

test('retained terminal/retry records round trip without adding expiry or deleting state', async () => {
  const { attemptToken, leaseExpiresAtMs, ...base } = record();
  const records = [
    { ...base, state: 'completed', completedAtMs: 900 },
    { ...base, state: 'retryable', nextAttemptAtMs: 1500, failureCode: 'upstream-timeout' },
    { ...base, state: 'failed', failedAtMs: 900, reason: 'permanent-failure' },
  ];
  for (const value of records) assert.deepEqual(await make(async () => found(value)).read('job'), { status: 'found', value, revision });
});

test('per-invocation cancellation is passed through and credential failures are sanitized', async () => {
  const controller = new AbortController();
  const store = make(async (_url, init) => { assert.equal(init.signal, controller.signal); return found(); }, { signal: controller.signal });
  assert.equal((await store.read('job')).status, 'found');
  const unavailable = make(async () => { assert.fail('Must not send missing credentials'); }, { token: async () => '' });
  assert.deepEqual(await unavailable.read('job'), { status: 'unavailable' });
  assert.deepEqual(await unavailable.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() }), { status: 'indeterminate' });
});

test('the exact serialized record must be valid; inherited data and custom serialization cannot bypass validation', async () => {
  let calls = 0;
  const store = make(async () => { calls++; return new Response(null, { status: 204 }); });
  const inherited = Object.create(record());
  const serialized = Object.assign(Object.create({ toJSON() { return {}; } }), record());
  const throws = Object.assign(Object.create({ toJSON() { throw new Error('secret serialization failure'); } }), record());
  for (const value of [inherited, serialized, throws]) {
    await assert.rejects(store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value }),
      { name: 'TypeError', message: 'Invalid Fastly KV conditional write' });
  }
  assert.equal(calls, 0);
});

test('caller mutations during credential resolution cannot change key, condition, revision, or body', async () => {
  for (const expected of [{ kind: 'absent' }, { kind: 'revision', revision }]) {
    let release;
    const token = new Promise((resolve) => { release = resolve; });
    const kind = expected.kind;
    let observed;
    const store = make(async (url, init) => { observed = { url, init }; return new Response(null, { status: 204 }); }, { token: () => token });
    const write = { key: 'original', expected, value: record() };
    const pending = store.compareAndSwap(write);
    write.key = 'changed';
    expected.kind = 'overwrite';
    expected.revision = '1';
    write.value.mutationId = 'changed';
    release('credential');
    assert.deepEqual(await pending, { status: 'applied' });
    assert.equal(observed.url, `https://api.fastly.com/resources/stores/kv/test-store/keys/original${kind === 'absent' ? '?add=true' : ''}`);
    assert.equal(observed.init.headers.get('if-generation-match'), kind === 'revision' ? revision : null);
    assert.equal(JSON.parse(observed.init.body).mutationId, 'mutation-1');
  }
});
