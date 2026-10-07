import test from 'node:test';
import assert from 'node:assert/strict';
import { createS3Store } from '../../dist/adapters/s3.js';
import { createCoordinationBinding } from '../../dist/bindings.js';
import { runStoreConformance } from '../../dist/testing/conformance.js';
import { createJobCoordinator } from '../../dist/core.js';
import { atomicS3, endpoint, errorResponse, record } from '../helpers/atomic-s3.mjs';

const revision = '"opaque/900719925474099300000-2"';
const make = (fetch, extra = {}) => createS3Store({ endpoint, fetch, ...extra });
const found = (value = record(), etag = revision, headers = {}) => new Response(JSON.stringify(value), { headers: { etag, ...headers } });

test('S3 encodes exact full keys and returns ETag with the value from one GET', async () => {
  let calls = 0;
  const store = make(async (url, init) => {
    calls++; assert.equal(url, endpoint + '/prefix//%5B%22job%22%5D%20%21%27%28%29%2A%25%3F%23%C3%A9/');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    return found();
  });
  assert.deepEqual(await store.read('prefix//["job"] !\'()*%?#é/'), { status: 'found', value: record(), revision });
  assert.equal(calls, 1);
});

test('S3 sends exactly one atomic condition per PUT; quotes and opaque revision stay unchanged', async () => {
  const calls = [];
  const store = make(async (url, init) => { calls.push({ url, init }); return new Response(); });
  for (const expected of [{ kind: 'absent' }, { kind: 'revision', revision }]) {
    assert.equal((await store.compareAndSwap({ key: 'jobs/one', expected, value: record() })).status, 'applied');
  }
  assert.equal(calls[0].init.headers.get('if-none-match'), '*'); assert.equal(calls[0].init.headers.get('if-match'), null);
  assert.equal(calls[1].init.headers.get('if-match'), revision); assert.equal(calls[1].init.headers.get('if-none-match'), null);
  assert.ok(calls.every(({ url, init }) => url === endpoint + '/jobs/one' && init.method === 'PUT' && !new URL(url).search));
  assert.deepEqual(JSON.parse(calls[1].init.body), record());
});

test('S3 only acknowledges PutObject 200; 409, redirects and transport failures stay indeterminate without retry', async () => {
  for (const status of [200, 201, 204, 202, 301, 307, 401, 403, 404, 409, 412, 429, 500, 503]) {
    let calls = 0;
    const store = make(async () => { calls++; return new Response(null, { status }); });
    assert.equal((await store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() })).status,
      status === 412 ? 'conflict' : status === 200 ? 'applied' : 'indeterminate', `${status}`);
    assert.equal(calls, 1);
  }
  const store = make(async () => { throw new Error('private-upstream-details'); });
  assert.deepEqual(await store.read('job'), { status: 'unavailable' });
  assert.deepEqual(await store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() }), { status: 'indeterminate' });
  for (const status of [200, 404, 412]) {
    const response = status === 404 ? errorResponse('NoSuchKey') : new Response(null, { status });
    Object.defineProperty(response, 'redirected', { value: true });
    assert.equal((await make(async () => response).compareAndSwap({ key: 'job', expected: { kind: 'revision', revision }, value: record() })).status, 'indeterminate');
  }
});

test('S3 distinguishes NoSuchKey from bucket/proxy/delete-marker 404; missing If-Match is a known conflict', async () => {
  assert.deepEqual(await make(async () => errorResponse('NoSuchKey')).read('missing'), { status: 'absent' });
  assert.equal((await make(async () => errorResponse('NoSuchKey')).compareAndSwap({ key: 'missing', expected: { kind: 'revision', revision }, value: record() })).status, 'conflict');
  for (const response of [() => errorResponse('NoSuchBucket'), () => new Response('Not found', { status: 404 }),
    () => errorResponse('NoSuchKey', 404, { 'x-amz-delete-marker': 'true' }),
    () => new Response('<Error><Code>NoSuchBucket</Code><Message><Code>NoSuchKey</Code></Message></Error>', { status: 404 }),
    () => new Response('<Error><Code>NoSuchKey</Code><Code>NoSuchBucket</Code></Error>', { status: 404 }),
    () => new Response('<!DOCTYPE Error><Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
    () => new Response('<Error><Code>NoSuchKey</Code>' + 'x'.repeat(16384) + '</Error>', { status: 404 })]) {
    assert.equal((await make(async () => response()).read('missing')).status, 'unavailable');
    assert.equal((await make(async () => response()).compareAndSwap({ key: 'missing', expected: { kind: 'revision', revision }, value: record() })).status, 'indeterminate');
  }
});

test('S3 malformed, weak, missing, oversized, expiring and partial reads fail closed', async () => {
  for (const response of [() => new Response('{}'), () => found(record(), 'unquoted'), () => found(record(), '*'),
    () => found(record(), 'W/"weak"'), () => found(record(), '"a", "b"'), () => found(record(), '""'),
    () => found(record(), '"' + 'x'.repeat(1023) + '"'), () => found(record({ contractVersion: 2 })),
    () => found(record({ unknown: true })), () => found(record(), revision, { 'content-range': 'bytes 0-10/100' }),
    () => found(record(), revision, { 'x-amz-expiration': 'expiry-date="tomorrow"' }),
    () => new Response('x'.repeat(16385), { headers: { etag: revision } }),
    () => new Response(new Uint8Array([255]), { headers: { etag: revision } })]) {
    assert.equal((await make(async () => response()).read('job')).status, 'unavailable');
  }
});

test('S3 declaration and invalid writes reject before I/O with sanitized errors', async () => {
  let calls = 0; const store = make(async () => { calls++; return found(); });
  for (const key of ['', '.', 'a/../b', './b', 'a/./b', 'a\nb', 'é'.repeat(513), '\ud800']) await assert.rejects(store.read(key), /Invalid S3 key/);
  for (const endpoint of ['http://bucket', 'https://user:secret@bucket', 'https://bucket/path', 'https://bucket/?query', 'https://bucket/#hash']) {
    assert.throws(() => make(async () => found(), { endpoint }), /Invalid S3 binding/);
  }
  for (const expected of [undefined, { kind: 'overwrite' }, { kind: 'revision', revision: 123 }, { kind: 'revision', revision: '*' },
    { kind: 'revision', revision: 'W/"weak"' }, { kind: 'revision', revision: '"a", "b"' }]) {
    await assert.rejects(store.compareAndSwap({ key: 'job', expected, value: record() }), /Invalid S3 conditional write/);
  }
  for (const value of [Object.create(record()), Object.assign(Object.create({ toJSON() { return {}; } }), record()), record({ extra: 'x' })]) {
    await assert.rejects(store.compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value }), /Invalid S3 conditional write/);
  }
  assert.throws(() => make(async () => found(), { signal: { aborted: false, addEventListener() {}, removeEventListener() {} } }), /Invalid S3 binding/);
  assert.equal(calls, 0);
});

test('S3 captures bindings and serialized writes before host signing awaits; forwards native cancellation', async () => {
  let release, sent; const pause = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const options = { endpoint, signal: controller.signal, async fetch(url, init) { await pause; sent = { url, init }; return new Response(); } };
  const store = createS3Store(options), value = record(), expected = { kind: 'revision', revision };
  const write = { key: 'original', expected, value }; const pending = store.compareAndSwap(write);
  options.endpoint = 'https://other'; options.fetch = async () => { throw new Error(); }; options.signal = undefined;
  write.key = 'other'; expected.revision = '*'; value.mutationId = 'changed'; release();
  assert.equal((await pending).status, 'applied'); assert.equal(sent.url, endpoint + '/original');
  assert.equal(sent.init.headers.get('if-match'), revision); assert.equal(JSON.parse(sent.init.body).mutationId, 'mutation-1');
  assert.equal(sent.init.signal, controller.signal);
});

test('S3 captures a revision getter once so it cannot switch a replacement into a wildcard condition', async () => {
  let reads = 0, sent;
  const expected = { kind: 'revision', get revision() { return ++reads === 1 ? revision : '*'; } };
  const store = make(async (_url, init) => { sent = init; return new Response(); });
  assert.equal((await store.compareAndSwap({ key: 'job', expected, value: record() })).status, 'applied');
  assert.equal(reads, 1); assert.equal(sent.headers.get('if-match'), revision); assert.equal(sent.headers.has('if-none-match'), false);
});

test('S3 response cleanup failure cannot turn an acknowledged write or precondition rejection into uncertainty', async () => {
  for (const [status, expected] of [[200, 'applied'], [412, 'conflict']]) {
    const response = new Response('private-unused-body', { status });
    response.body.cancel = async () => { throw new Error('private-cleanup-failure'); };
    assert.equal((await make(async () => response).compareAndSwap({ key: 'job', expected: { kind: 'absent' }, value: record() })).status, expected);
  }
});

test('s3-http logical mapping applies the prefix once and construction performs no transport I/O', async () => {
  const fixture = atomicS3();
  const binding = createCoordinationBinding({ name: 'state', prefix: 'jobs/' }, { state: { kind: 's3-http', options: { endpoint, fetch: fixture.transport() } } });
  assert.equal(fixture.calls.length, 0); assert.equal(binding.prefix, 'jobs/');
  assert.equal((await binding.store.read('jobs/one')).status, 'absent'); assert.equal(fixture.calls[0].key, 'jobs/one');
});

test('S3 reusable conformance observes all seven cases through actual adapter transport, and catches a broken missing-key condition', async () => {
  const fixture = atomicS3();
  const report = await runStoreConformance({ writers: [fixture.store(), fixture.store()], prefix: 'test/s3/', suiteId: 's3-test', mode: 'synthetic',
    faults: { lostReply: fixture.store({ lostReply: true }), unavailable: fixture.store({ unavailable: true }) } });
  assert.equal(report.status, 'observed', JSON.stringify(report)); assert.equal(report.certified, false); assert.equal(report.cases.length, 7);
  const broken = atomicS3();
  const rejected = await runStoreConformance({ writers: [broken.store({ missingRevisionCreates: true }), broken.store({ missingRevisionCreates: true })],
    prefix: 'test/broken/', suiteId: 'broken', mode: 'synthetic' });
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.cases.find((c) => c.name === 'revision-on-missing').status, 'failed');
});

function coordinator(store, name = 'first') {
  let ids = 0;
  return createJobCoordinator({ namespace: 'test', job: { id: 'job', schedule: { kind: 'interval', anchorMs: 0, everyMs: 1000, revision: 'v1', missedWindows: 'skip' } },
    coordination: { name: 'state', prefix: 'owners/', store }, clock: { nowMs: () => 1000, monotonicMs: () => 0 },
    ids: { newAttemptToken: () => `${name}-owner-${++ids}`, newMutationId: () => `${name}-mutation-${++ids}` },
    limits: { maxAttemptsPerRun: 3, leaseMs: 100, runTimeoutMs: 1000, retryDelayMs: 0, maxClockSkewMs: 0, deadlineSafetyMs: 1 } });
}
const invocation = () => ({ requestId: 'test', deadlineMs: 5000, signal: new AbortController().signal });

test('S3 rejects a former owner settlement using a stale coherent GET after successor CAS', async () => {
  const f = atomicS3(); let held;
  const c = coordinator(f.store({ readHook: () => held ? new Response(held.body, { headers: { etag: held.revision } }) : undefined }));
  const first = await c.claim(invocation()); assert.equal(first.status, 'owned');
  held = structuredClone(f.rows.get(c.key));
  const next = { ...held.value, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' };
  assert.equal((await f.store().compareAndSwap({ key: c.key, expected: { kind: 'revision', revision: held.revision }, value: next })).status, 'applied');
  assert.equal((await c.settle(first.lease, { kind: 'completed' })).status, 'conflict');
  assert.deepEqual(f.rows.get(c.key).value, next); assert.equal((await c.renew(first.lease)).status, 'stale');
});

test('S3 lost claim reply grants no lease, and only a positive CAS revalidation grants ownership', async () => {
  const f = atomicS3(); let drop = true;
  const c = coordinator(make(async (url, init) => f.transport({ lostReply: drop && init.method === 'PUT' })(url, init)));
  const first = await c.claim(invocation()); assert.equal(first.status, 'indeterminate'); assert.equal('lease' in first, false);
  drop = false; const original = f.rows.get(c.key).value;
  const recovered = await c.reconcile(first.pending); assert.equal(recovered.status, 'owned');
  assert.equal(recovered.lease.record.attemptToken, original.attemptToken); assert.notEqual(recovered.lease.record.mutationId, original.mutationId);
});

test('S3 stale matching read after reply loss cannot revalidate over a successor', async () => {
  const f = atomicS3(); let held, drop = true;
  const transport = async (url, init) => f.transport({ lostReply: drop && init.method === 'PUT',
    readHook: () => held ? new Response(held.body, { headers: { etag: held.revision } }) : undefined })(url, init);
  const c = coordinator(make(transport)); const first = await c.claim(invocation()); assert.equal(first.status, 'indeterminate');
  drop = false; held = structuredClone(f.rows.get(c.key));
  const next = { ...held.value, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' };
  await f.store().compareAndSwap({ key: c.key, expected: { kind: 'revision', revision: held.revision }, value: next });
  assert.equal((await c.reconcile(first.pending)).status, 'conflict'); assert.deepEqual(f.rows.get(c.key).value, next);
});
