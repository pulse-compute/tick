import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobCoordinator, latestSlot } from '../../dist/core.js';

const clone = (value) => structuredClone(value);
const capabilities = {
  atomicCreate: true, atomicReplace: true, scope: 'global-per-key',
  coherentValueRevision: true, reads: 'possibly-stale',
};

// This fixture performs the precondition check and replacement synchronously. Reads
// can be stale and responses can disappear, but the conditional write stays atomic.
function memoryStore() {
  let entry;
  let generation = 0;
  const store = {
    capabilities: { ...capabilities }, reads: [], writes: [], readHook: undefined, writeHook: undefined,
    snapshot() { return entry ? { status: 'found', value: clone(entry.value), revision: entry.revision } : { status: 'absent' }; },
    seed(value) { entry = { value: clone(value), revision: `etag/90071992547409930000/${++generation}` }; },
    async read(key) {
      store.reads.push(key);
      return store.readHook ? await store.readHook(key, store.snapshot()) : store.snapshot();
    },
    async compareAndSwap(write) {
      store.writes.push(clone(write));
      const matches = write.expected.kind === 'absent'
        ? !entry : !!entry && entry.revision === write.expected.revision;
      if (!matches) return { status: 'conflict' };
      store.seed(write.value);
      return store.writeHook ? await store.writeHook(write) : { status: 'applied' };
    },
  };
  return store;
}

function fixture({ store = memoryStore(), namespace = 'tests', jobId = 'monitor', schedule = {}, limits = {} } = {}) {
  let wall = 1_000;
  let mono = 0;
  let ids = 0;
  const clock = { nowMs: () => wall, monotonicMs: () => mono };
  const options = {
    namespace,
    job: { id: jobId, schedule: { kind: 'interval', anchorMs: 0, everyMs: 100, revision: 'v1', missedWindows: 'skip', ...schedule } },
    coordination: { name: 'state', prefix: 'test/', store },
    clock,
    ids: { newAttemptToken: () => `attempt-${namespace}-${++ids}`, newMutationId: () => `mutation-${namespace}-${++ids}` },
    limits: { maxAttemptsPerRun: 3, leaseMs: 100, runTimeoutMs: 1_000, retryDelayMs: 20, maxClockSkewMs: 5, deadlineSafetyMs: 2, ...limits },
  };
  const coordinator = createJobCoordinator(options);
  return {
    options, coordinator, store, clock,
    advance(ms) { wall += ms; mono += ms; },
    setWall(ms) { wall = ms; },
    setMono(ms) { mono = ms; },
    invocation(deadlineMs = wall + 5_000, signal = new AbortController().signal) { return { requestId: 'request', deadlineMs, signal }; },
  };
}

async function owned(f, invocation = f.invocation()) {
  const result = await f.coordinator.claim(invocation);
  assert.equal(result.status, 'owned');
  return result.lease;
}

function assertBounded(store, before, reads, writes) {
  assert.equal(store.reads.length - before[0], reads);
  assert.equal(store.writes.length - before[1], writes);
}
const counts = (store) => [store.reads.length, store.writes.length];


test('fixed slots share an explicit anchor, including exact boundaries and large integers', () => {
  const schedule = { kind: 'interval', anchorMs: 17, everyMs: 100, revision: 'v1', missedWindows: 'skip' };
  assert.equal(latestSlot(schedule, 16), null);
  assert.equal(latestSlot(schedule, 17), 17);
  assert.equal(latestSlot(schedule, 116), 17);
  assert.equal(latestSlot(schedule, 117), 117);
  assert.equal(latestSlot({ ...schedule, anchorMs: Number.MAX_SAFE_INTEGER - 5, everyMs: 2 }, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER - 1);
  for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => latestSlot(schedule, invalid), TypeError);
});

test('constructor rejects unsafe schedules, limits and weak storage capabilities before I/O', () => {
  const f = fixture();
  for (const change of [
    { namespace: 'bad namespace' },
    { job: { ...f.options.job, id: '../job' } },
    { job: { ...f.options.job, schedule: { ...f.options.job.schedule, everyMs: 0 } } },
    { limits: { ...f.options.limits, maxAttemptsPerRun: 1.5 } },
    { limits: { ...f.options.limits, leaseMs: 7 } },
    { coordination: { ...f.options.coordination, prefix: 'bad:' } },
    { coordination: { ...f.options.coordination, store: { ...f.store, capabilities: { ...capabilities, atomicReplace: false } } } },
  ]) assert.throws(() => createJobCoordinator({ ...f.options, ...change }), TypeError);
  assertBounded(f.store, [0, 0], 0, 0);
});

test('first claim persists canonical run identity and a frozen, bounded receipt', async () => {
  const f = fixture();
  const lease = await owned(f);
  assert.equal(f.coordinator.key, 'test/["tick.job.v1","tests","monitor"]');
  assert.equal(lease.record.run.id, '["tick.run.v1","tests","monitor","v1",1000]');
  assert.equal(lease.record.attempt, 1);
  assert.equal(lease.record.runDeadlineMs, 2_000);
  assert.equal(lease.record.leaseExpiresAtMs, 1_100);
  assert.equal(lease.deadlineMs, 1_093);
  assert.deepEqual(f.store.writes[0].expected, { kind: 'absent' });
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Object.isFrozen(lease.record), true);
  assert.equal(Object.isFrozen(lease.record.run), true);
  assert.equal(f.coordinator.isUsable(lease), true);
  assertBounded(f.store, [0, 0], 1, 1);
});

test('before-anchor and duplicate triggers do not write or create work', async () => {
  const f = fixture({ schedule: { anchorMs: 1_100 } });
  assert.deepEqual(await f.coordinator.claim(f.invocation()), { status: 'skipped', reason: 'before-anchor' });
  assertBounded(f.store, [0, 0], 1, 0);
  f.advance(100);
  await owned(f);
  const before = counts(f.store);
  assert.deepEqual(await f.coordinator.claim(f.invocation()), { status: 'skipped', reason: 'leased' });
  assertBounded(f.store, before, 1, 0);
});

test('simultaneous absent reads yield one winning CAS and no in-call retries', async () => {
  const f = fixture();
  const result = await Promise.all(Array.from({ length: 16 }, () => f.coordinator.claim(f.invocation())));
  assert.equal(result.filter((r) => r.status === 'owned').length, 1);
  assert.equal(result.filter((r) => r.status === 'conflict').length, 15);
  assertBounded(f.store, [0, 0], 16, 16);
});

test('terminal highwater skips replay and only advances to the latest eligible slot', async () => {
  const f = fixture();
  const first = await owned(f);
  const complete = await f.coordinator.settle(first, { kind: 'completed' });
  assert.equal(complete.status, 'settled');
  assert.equal(complete.record.state, 'completed');
  assert.deepEqual(await f.coordinator.claim(f.invocation()), { status: 'skipped', reason: 'already-recorded' });
  f.advance(350);
  const next = await f.coordinator.claim(f.invocation());
  assert.equal(next.status, 'owned');
  assert.equal(next.lease.record.run.scheduledForMs, 1_300);
  assert.equal(next.missedWindows, 2);
  assert.equal(next.lease.record.attempt, 1);
  assert.notEqual(next.lease.record.run.id, first.record.run.id);
});

test('expired takeover retains logical run and deadline with a new attempt and token', async () => {
  const f = fixture();
  const first = await owned(f);
  f.advance(104);
  assert.deepEqual(await f.coordinator.claim(f.invocation()), { status: 'skipped', reason: 'leased' });
  f.advance(1);
  const second = await owned(f);
  assert.equal(second.record.run.id, first.record.run.id);
  assert.equal(second.record.attempt, 2);
  assert.notEqual(second.record.attemptToken, first.record.attemptToken);
  assert.equal(second.record.runDeadlineMs, first.record.runDeadlineMs);
  assert.equal(second.record.leaseExpiresAtMs, 1_205);
  assert.equal(f.coordinator.isUsable(first), false);
});

test('renewal replaces the receipt and cannot extend the original invocation deadline', async () => {
  const f = fixture();
  const first = await owned(f, f.invocation(1_160));
  f.advance(50);
  const next = await f.coordinator.renew(first);
  assert.equal(next.status, 'owned');
  assert.equal(next.lease.record.attempt, first.record.attempt);
  assert.equal(next.lease.record.attemptToken, first.record.attemptToken);
  assert.equal(next.lease.record.runDeadlineMs, first.record.runDeadlineMs);
  assert.equal(next.lease.record.leaseExpiresAtMs, 1_150);
  assert.notEqual(next.lease.record.mutationId, first.record.mutationId);
  assert.equal(f.coordinator.isUsable(first), false);
  assert.equal((await f.coordinator.settle(first, { kind: 'completed' })).status, 'stale');
  f.advance(40);
  const last = await f.coordinator.renew(next.lease);
  assert.equal(last.status, 'owned');
  assert.equal(last.lease.deadlineMs, 1_153);
  f.advance(63);
  assert.equal(f.coordinator.isUsable(last.lease), false);
});

test('one receipt cannot start overlapping renew and settle transitions', async () => {
  const f = fixture();
  const first = await owned(f);
  const before = counts(f.store);
  const [renew, settle] = await Promise.all([
    f.coordinator.renew(first), f.coordinator.settle(first, { kind: 'completed' }),
  ]);
  assert.equal(renew.status, 'owned');
  assert.equal(settle.status, 'stale');
  assertBounded(f.store, before, 1, 1);
  assert.equal(f.store.snapshot().value.state, 'leased');
});

test('retry keeps identity, observes conservative delay and consumes the next attempt', async () => {
  const f = fixture();
  const first = await owned(f);
  const retry = await f.coordinator.settle(first, { kind: 'retry', failureCode: 'upstream-unavailable' });
  assert.equal(retry.status, 'settled');
  assert.equal(retry.record.state, 'retryable');
  assert.equal(retry.record.nextAttemptAtMs, 1_020);
  assert.equal(retry.record.failureCode, 'upstream-unavailable');
  f.advance(24);
  assert.deepEqual(await f.coordinator.claim(f.invocation()), { status: 'skipped', reason: 'retry-delay' });
  f.advance(1);
  const second = await owned(f);
  assert.equal(second.record.run.id, first.record.run.id);
  assert.equal(second.record.attempt, 2);
  assert.equal(second.record.runDeadlineMs, first.record.runDeadlineMs);
  assert.notEqual(second.record.attemptToken, first.record.attemptToken);
});

test('retry eligibility must precede the deadline cutoff strictly, with skew included', async () => {
  for (const [retryDelayMs, state] of [[87, 'retryable'], [88, 'failed']]) {
    const f = fixture({ limits: { runTimeoutMs: 100, retryDelayMs } });
    const lease = await owned(f);
    // Cutoff is 1093; the conservative retry start is 1092 or exactly 1093.
    const result = await f.coordinator.settle(lease, { kind: 'retry', failureCode: 'temporary' });
    assert.equal(result.status, 'settled');
    assert.equal(result.record.state, state);
    if (state === 'failed') assert.equal(result.record.reason, 'deadline-exceeded');
    else {
      f.advance(92);
      const retry = await owned(f);
      assert.equal(retry.deadlineMs, 1_093);
      assert.equal(retry.record.runDeadlineMs, 1_100);
    }
  }
});

test('attempt exhaustion never steals a live final attempt; expiry terminalizes before advancing', async () => {
  const f = fixture({ limits: { maxAttemptsPerRun: 1 } });
  const first = await owned(f);
  assert.equal((await f.coordinator.claim(f.invocation())).status, 'skipped');
  f.advance(105);
  const terminal = await f.coordinator.claim(f.invocation());
  assert.equal(terminal.status, 'settled');
  assert.equal(terminal.record.state, 'failed');
  assert.equal(terminal.record.reason, 'attempts-exhausted');
  assert.equal(terminal.record.run.id, first.record.run.id);
  const second = await owned(f);
  assert.equal(second.record.run.scheduledForMs, 1_100);
});

test('fixed run deadline bounds acquisition and terminalizes a crashed run', async () => {
  const f = fixture({ limits: { runTimeoutMs: 80 } });
  const first = await owned(f);
  assert.equal(first.record.leaseExpiresAtMs, 1_080);
  assert.equal(first.deadlineMs, 1_073);
  f.advance(85);
  const terminal = await f.coordinator.claim(f.invocation());
  assert.equal(terminal.status, 'settled');
  assert.equal(terminal.record.reason, 'deadline-exceeded');
  assert.equal(terminal.record.runDeadlineMs, first.record.runDeadlineMs);
});

test('permanent failure is retained and the consumed receipt cannot settle twice', async () => {
  const f = fixture();
  const lease = await owned(f);
  const result = await f.coordinator.settle(lease, { kind: 'failed' });
  assert.equal(result.status, 'settled');
  assert.equal(result.record.reason, 'permanent-failure');
  const before = counts(f.store);
  assert.equal((await f.coordinator.settle(lease, { kind: 'completed' })).status, 'stale');
  assertBounded(f.store, before, 0, 0);
  assert.equal(f.store.snapshot().value.state, 'failed');
});

test('a stale coherent read cannot overwrite a successor, and a conflicted receipt is consumed', async () => {
  const f = fixture();
  const first = await owned(f);
  const stale = f.store.snapshot();
  // Model another globally authorized writer without relying on our local clock.
  f.store.seed({ ...first.record, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' });
  const successor = f.store.snapshot();
  f.store.readHook = async () => clone(stale);
  const result = await f.coordinator.settle(first, { kind: 'completed' });
  assert.equal(result.status, 'conflict');
  assert.equal(f.store.writes.at(-1).expected.revision, stale.revision);
  assert.deepEqual(f.store.snapshot(), successor);
  assert.equal((await f.coordinator.renew(first)).status, 'stale');
});

test('fresh successor read rejects a former owner before any conditional write', async () => {
  const f = fixture();
  const first = await owned(f);
  f.store.seed({ ...first.record, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' });
  const before = counts(f.store);
  assert.equal((await f.coordinator.renew(first)).status, 'stale');
  assertBounded(f.store, before, 1, 0);
});

test('lost claim response needs fresh successful CAS revalidation before ownership', async () => {
  const f = fixture();
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  const unknown = await f.coordinator.claim(f.invocation());
  assert.equal(unknown.status, 'indeterminate');
  assert.equal('lease' in unknown, false);
  const original = f.store.snapshot();
  assert.equal(Object.isFrozen(unknown.pending), true);
  f.store.writeHook = undefined;
  const before = counts(f.store);
  const recovered = await f.coordinator.reconcile(unknown.pending);
  assert.equal(recovered.status, 'owned');
  assertBounded(f.store, before, 1, 1);
  assert.equal(f.store.writes.at(-1).expected.revision, original.revision);
  assert.equal(recovered.lease.record.attemptToken, original.value.attemptToken);
  assert.equal(recovered.lease.record.leaseExpiresAtMs, original.value.leaseExpiresAtMs);
  assert.equal(recovered.lease.record.runDeadlineMs, original.value.runDeadlineMs);
});

test('lost settlement response consumes the owner and reconciles the exact terminal record', async () => {
  const f = fixture();
  const lease = await owned(f);
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  const unknown = await f.coordinator.settle(lease, { kind: 'completed' });
  assert.equal(unknown.status, 'indeterminate');
  assert.equal(f.coordinator.isUsable(lease), false);
  const terminal = f.store.snapshot().value;
  assert.equal(terminal.state, 'completed');
  f.store.writeHook = undefined;
  const before = counts(f.store);
  const recovered = await f.coordinator.reconcile(unknown.pending);
  assert.equal(recovered.status, 'settled');
  assert.notEqual(recovered.record.mutationId, terminal.mutationId);
  assert.deepEqual(recovered.record, { ...terminal, mutationId: recovered.record.mutationId });
  assertBounded(f.store, before, 1, 1);
});

test('a stale self-read after lost response cannot authorize ownership over a successor', async () => {
  const f = fixture();
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  const unknown = await f.coordinator.claim(f.invocation());
  assert.equal(unknown.status, 'indeterminate');
  const stale = f.store.snapshot();
  f.store.seed({ ...stale.value, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' });
  const successor = f.store.snapshot();
  f.store.readHook = async () => clone(stale);
  f.store.writeHook = undefined;
  const result = await f.coordinator.reconcile(unknown.pending);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(f.store.snapshot(), successor);
});

test('mismatched reconciliation stays unresolved without adopting other state or retrying', async () => {
  const f = fixture();
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  const unknown = await f.coordinator.claim(f.invocation());
  assert.equal(unknown.status, 'indeterminate');
  const current = f.store.snapshot().value;
  f.store.seed({ ...current, leaseExpiresAtMs: current.leaseExpiresAtMs + 1 });
  const before = counts(f.store);
  const result = await f.coordinator.reconcile(unknown.pending);
  assert.equal(result.status, 'unresolved');
  assertBounded(f.store, before, 1, 0);
});

test('repeated uncertainty stays bounded by the original invocation budget', async () => {
  const f = fixture();
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  let result = await f.coordinator.claim(f.invocation(1_050));
  assert.equal(result.status, 'indeterminate');
  f.advance(20);
  const before = counts(f.store);
  result = await f.coordinator.reconcile(result.pending);
  assert.equal(result.status, 'indeterminate');
  assertBounded(f.store, before, 1, 1);
  f.advance(23);
  const expiredBefore = counts(f.store);
  assert.equal((await f.coordinator.reconcile(result.pending)).status, 'expired');
  assertBounded(f.store, expiredBefore, 0, 0);
});

test('late successful writes never return usable ownership', async () => {
  const f = fixture();
  f.store.writeHook = async () => { f.advance(95); return { status: 'applied' }; };
  const result = await f.coordinator.claim(f.invocation());
  assert.equal(result.status, 'expired');
  assert.equal(result.applied, true);
  assert.equal(f.store.snapshot().value.state, 'leased');
});

test('late settlement records its success and reports the expired owner deadline', async () => {
  const f = fixture();
  const lease = await owned(f);
  f.store.writeHook = async () => { f.advance(95); return { status: 'applied' }; };
  const result = await f.coordinator.settle(lease, { kind: 'completed' });
  assert.equal(result.status, 'settled');
  assert.equal(result.record.state, 'completed');
  assert.equal(result.deadlineExceeded, true);
  assert.equal(f.coordinator.isUsable(lease), false);
});

test('a renewal response arriving past the former lease cutoff cannot revive ownership', async () => {
  const f = fixture();
  const lease = await owned(f);
  f.advance(50);
  f.store.writeHook = async () => { f.advance(60); return { status: 'applied' }; };
  const result = await f.coordinator.renew(lease);
  assert.equal(result.status, 'expired');
  assert.equal(result.applied, true);
  assert.equal(f.store.snapshot().value.leaseExpiresAtMs, 1_150);
});

test('ambiguous renewal cannot reconcile beyond the former owner cutoff', async () => {
  const f = fixture();
  const lease = await owned(f);
  f.advance(50);
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  const unknown = await f.coordinator.renew(lease);
  assert.equal(unknown.status, 'indeterminate');
  assert.equal(f.store.snapshot().value.leaseExpiresAtMs, 1_150);
  f.advance(45);
  f.store.writeHook = undefined;
  const before = counts(f.store);
  const result = await f.coordinator.reconcile(unknown.pending);
  assert.equal(result.status, 'expired');
  assert.equal(f.store.writes.length, before[1]);
});

test('read latency and cooperative cancellation prevent a subsequent write', async () => {
  const f = fixture();
  f.store.readHook = async (_key, snapshot) => { f.advance(50); return snapshot; };
  assert.equal((await f.coordinator.claim(f.invocation(1_040))).status, 'expired');
  assert.equal(f.store.writes.length, 0);
  const second = fixture();
  const controller = new AbortController();
  second.store.readHook = async (_key, snapshot) => { controller.abort(); return snapshot; };
  assert.equal((await second.coordinator.claim(second.invocation(undefined, controller.signal))).status, 'expired');
  assert.equal(second.store.writes.length, 0);
});

test('wall rollback, monotonic regression, and a frozen wall clock fail closed', async () => {
  for (const fault of [
    (f) => f.setWall(999),
    (f) => f.setMono(-0.5),
    (f) => f.setMono(93),
  ]) {
    const f = fixture();
    const lease = await owned(f);
    fault(f);
    assert.equal(f.coordinator.isUsable(lease), false);
    const before = counts(f.store);
    assert.equal((await f.coordinator.renew(lease)).status, 'expired');
    assertBounded(f.store, before, 0, 0);
  }
});

test('caller mutations cannot change a captured schedule, invocation budget, or receipt', async () => {
  const f = fixture();
  f.options.job.schedule.everyMs = 1;
  f.options.coordination.prefix = 'changed/';
  f.options.limits.leaseMs = 5_000;
  const invocation = f.invocation(1_050);
  const lease = await owned(f, invocation);
  invocation.deadlineMs = 100_000;
  invocation.signal = new AbortController().signal;
  assert.equal(lease.record.leaseExpiresAtMs, 1_100);
  assert.equal(lease.deadlineMs, 1_043);
  assert.equal(f.store.reads[0], 'test/["tick.job.v1","tests","monitor"]');
  assert.throws(() => { lease.record.run.scheduledForMs = 0; }, TypeError);
  f.advance(43);
  assert.equal(f.coordinator.isUsable(lease), false);
});

test('forged, copied and foreign receipts cannot confer local authority', async () => {
  const f = fixture();
  const lease = await owned(f);
  const foreign = fixture({ store: f.store });
  assert.equal(f.coordinator.isUsable({ ...lease }), false);
  assert.equal(foreign.coordinator.isUsable(lease), false);
  await assert.rejects(() => f.coordinator.renew({ ...lease }), TypeError);
  await assert.rejects(() => foreign.coordinator.settle(lease, { kind: 'completed' }), TypeError);
  await assert.rejects(() => f.coordinator.reconcile({ mutationId: lease.record.mutationId }), TypeError);
});

test('malformed or mismatched retained records fail closed without overwriting state', async () => {
  const source = fixture();
  const first = await owned(source);
  for (const record of [
    { ...first.record, contractVersion: 2 },
    { ...first.record, run: { ...first.record.run, namespace: 'other' } },
    { ...first.record, run: { ...first.record.run, scheduleRevision: 'v2' } },
    { ...first.record, run: { ...first.record.run, scheduledForMs: 1_001, id: '["tick.run.v1","tests","monitor","v1",1001]' } },
    { ...first.record, attempt: 0 },
    { ...first.record, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const f = fixture();
    f.store.seed(record);
    const before = counts(f.store);
    assert.equal((await f.coordinator.claim(f.invocation())).status, 'configuration-mismatch');
    assertBounded(f.store, before, 1, 0);
  }
});

test('an impossible expired lease cannot acquire a future scheduled occurrence', async () => {
  const source = fixture();
  const first = await owned(source);
  const f = fixture();
  f.store.seed({
    ...first.record,
    run: { ...first.record.run, scheduledForMs: 2_000, id: '["tick.run.v1","tests","monitor","v1",2000]' },
    leaseExpiresAtMs: 500,
    runDeadlineMs: 3_000,
  });
  const original = f.store.snapshot();
  assert.equal((await f.coordinator.claim(f.invocation())).status, 'configuration-mismatch');
  assertBounded(f.store, [0, 0], 1, 0);
  assert.deepEqual(f.store.snapshot(), original);
});

test('read failures stay unavailable and a thrown post-commit write stays indeterminate', async () => {
  const f = fixture();
  f.store.readHook = async () => { throw new Error('unavailable'); };
  assert.equal((await f.coordinator.claim(f.invocation())).status, 'unavailable');
  assert.equal(f.store.writes.length, 0);
  f.store.readHook = undefined;
  f.store.writeHook = async () => { throw new Error('response lost'); };
  const result = await f.coordinator.claim(f.invocation());
  assert.equal(result.status, 'indeterminate');
  assert.equal(f.store.snapshot().value.state, 'leased');
});
