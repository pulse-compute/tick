import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunner, JobFailure } from '../../dist/runner.js';
import { createJobCoordinator } from '../../dist/core.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const clone = (value) => structuredClone(value);
function fixture({ execute = async () => {}, jobs, limits = {}, telemetry } = {}) {
  let wall = 1_000, mono = 0, nextId = 0, revision = 0;
  const entries = new Map(), timers = new Set();
  const store = {
    capabilities: { atomicCreate: true, atomicReplace: true, scope: 'global-per-key', coherentValueRevision: true, reads: 'possibly-stale' },
    reads: [], writes: [], readHook: undefined, writeHook: undefined,
    snapshot(key = 'test/["tick.job.v1","tests","monitor"]') {
      const entry = entries.get(key);
      return entry ? { status: 'found', value: clone(entry.value), revision: entry.revision } : { status: 'absent' };
    },
    seed(key, value) { entries.set(key, { value: clone(value), revision: `opaque/90071992547409930000/${++revision}` }); },
    async read(key) {
      store.reads.push(key);
      return store.readHook ? store.readHook(key, store.snapshot(key)) : store.snapshot(key);
    },
    async compareAndSwap(write) {
      store.writes.push(clone(write));
      const entry = entries.get(write.key);
      if (write.expected.kind === 'absent' ? !!entry : !entry || entry.revision !== write.expected.revision) return { status: 'conflict' };
      store.seed(write.key, write.value);
      return store.writeHook ? store.writeHook(write) : { status: 'applied' };
    },
  };
  const runtime = {
    createAbortController: () => new AbortController(),
    setTimer(callback, delayMs) {
      assert.ok(Number.isSafeInteger(delayMs) && delayMs > 0);
      const timer = { at: mono + delayMs, callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };
  const definition = {
    contractVersion: 1, namespace: 'tests',
    bindings: {
      coordination: { name: 'state', prefix: 'test/', store },
      clock: { nowMs: () => wall, monotonicMs: () => mono },
      ids: { newAttemptToken: () => `attempt-${++nextId}`, newMutationId: () => `mutation-${++nextId}` },
      resources: { marker: 'resource' }, ...(telemetry ? { telemetry } : {}),
    },
    limits: { maxJobsPerTick: 2, maxAttemptsPerRun: 3, leaseMs: 100, runTimeoutMs: 1_000,
      retryDelayMs: 20, maxClockSkewMs: 5, deadlineSafetyMs: 2, ...limits },
    jobs: jobs ?? [{ id: 'monitor', schedule: { kind: 'interval', anchorMs: 0, everyMs: 100, revision: 'v1', missedWindows: 'skip' }, execute }],
  };
  const runner = createRunner(definition, runtime);
  return {
    definition, runtime, runner, store, timers,
    invocation(deadlineMs = wall + 5_000, signal = new AbortController().signal) { return { requestId: 'request', deadlineMs, signal }; },
    advance(ms, wallToo = true) { mono += ms; if (wallToo) wall += ms; },
    setWall(ms) { wall = ms; },
    fire() { for (const timer of [...timers]) if (timer.at <= mono) { timers.delete(timer); timer.callback(); } },
    coordinator(job = definition.jobs[0]) { return createJobCoordinator({ namespace: definition.namespace, job,
      coordination: definition.bindings.coordination, clock: definition.bindings.clock, ids: definition.bindings.ids, limits: definition.limits }); },
  };
}
const job = (id, execute = async () => {}, anchorMs = 0) => ({ id, execute,
  schedule: { kind: 'interval', anchorMs, everyMs: 100, revision: 'v1', missedWindows: 'skip' } });

test('known claim dispatches a frozen context with explicit resources and confirmed completion', async () => {
  let context, resources;
  const f = fixture({ execute: async (ctx, value) => { context = ctx; resources = value; } });
  const result = await f.runner.tick(f.invocation());
  assert.equal(result.status, 'finished');
  assert.equal(result.visited, 1);
  assert.equal(result.results[0].outcome, 'completed');
  assert.equal(result.results[0].record.state, 'completed');
  assert.equal(result.results[0].settlementDeadlineExceeded, false);
  assert.equal(context.run.id, '["tick.run.v1","tests","monitor","v1",1000]');
  assert.equal(context.attempt, 1);
  assert.equal(context.deadlineMs, 1_093);
  assert.equal('revision' in context, false);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(resources, f.definition.bindings.resources);
  assert.equal(context.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.store.reads.length, 2);
  assert.equal(f.store.writes.length, 2);
});

test('maxJobsPerTick counts skipped jobs; a returned cursor allows bounded continuation', async () => {
  const ran = [];
  const f = fixture({ jobs: [job('future', undefined, 2_000), job('second', async () => { ran.push('second'); }), job('third', async () => { ran.push('third'); })] });
  const first = await f.runner.tick(f.invocation());
  assert.equal(first.visited, 2);
  assert.equal(first.results[0].status, 'not-run');
  assert.equal(first.nextJobIndex, 2);
  assert.deepEqual(ran, ['second']);
  const second = await f.runner.tick(f.invocation(), { startAt: first.nextJobIndex });
  assert.equal(second.visited, 2);
  assert.equal(second.nextJobIndex, 1);
  assert.deepEqual(ran, ['second', 'third']);
});

test('simultaneous triggers dispatch only the known CAS winner', async () => {
  let executions = 0;
  const f = fixture({ execute: async () => { executions++; } });
  const results = await Promise.all(Array.from({ length: 16 }, () => f.runner.tick(f.invocation())));
  assert.equal(executions, 1);
  assert.equal(results.filter((r) => r.results[0].status === 'executed').length, 1);
  assert.equal(f.store.reads.length, 17);
  assert.equal(f.store.writes.length, 17);
});

test('unknown thrown payloads become sanitized retry records, with no in-call retry', async () => {
  let executions = 0;
  const f = fixture({ execute: async () => { executions++; throw new Error('secret-token-body'); } });
  const first = await f.runner.tick(f.invocation());
  assert.equal(first.results[0].outcome, 'retry');
  assert.equal(first.results[0].failureCode, 'job-error');
  assert.equal(first.results[0].record.nextAttemptAtMs, 1_020);
  assert.equal(JSON.stringify(first).includes('secret-token-body'), false);
  await f.runner.tick(f.invocation());
  assert.equal(executions, 1);
  f.advance(25);
  const second = await f.runner.tick(f.invocation());
  assert.equal(executions, 2);
  assert.equal(second.results[0].run.id, first.results[0].run.id);
  assert.equal(second.results[0].attempt, 2);
  assert.equal(second.results[0].record.runDeadlineMs, first.results[0].record.runDeadlineMs);
});

test('explicit permanent failures terminate; explicit retries retain only their bounded code', async () => {
  for (const [disposition, outcome, state] of [['permanent', 'failed', 'failed'], ['retry', 'retry', 'retryable']]) {
    const f = fixture({ execute: async () => { throw new JobFailure(disposition, 'invalid-target'); } });
    const result = (await f.runner.tick(f.invocation())).results[0];
    assert.equal(result.outcome, outcome);
    assert.equal(result.failureCode, 'invalid-target');
    assert.equal(result.record.state, state);
  }
  assert.throws(() => new JobFailure('retry', 'unbounded response body'), TypeError);
});

test('attempt limits and retry deadline exhaustion are visible separately from the application outcome', async () => {
  for (const limits of [{ maxAttemptsPerRun: 1 }, { runTimeoutMs: 100, retryDelayMs: 88 }]) {
    const f = fixture({ limits, execute: async () => { throw new Error('temporary'); } });
    const result = (await f.runner.tick(f.invocation())).results[0];
    assert.equal(result.outcome, 'retry');
    assert.equal(result.record.state, 'failed');
    assert.equal(result.record.reason, limits.maxAttemptsPerRun ? 'attempts-exhausted' : 'deadline-exceeded');
  }
});

test('crashed ownership recovers the same run with a new attempt, token, and fixed horizon', async () => {
  let context;
  const f = fixture({ execute: async (ctx) => { context = ctx; } });
  const crashed = await f.coordinator().claim(f.invocation());
  f.advance(105);
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(result.status, 'executed');
  assert.equal(context.run.id, crashed.lease.record.run.id);
  assert.equal(context.attempt, 2);
  assert.notEqual(context.attemptToken, crashed.lease.record.attemptToken);
  assert.equal(result.record.runDeadlineMs, crashed.lease.record.runDeadlineMs);
});

test('exhausted crashed runs terminalize on this visit and advance only on a later invocation', async () => {
  let ran = 0;
  const f = fixture({ limits: { maxAttemptsPerRun: 1 }, execute: async () => { ran++; } });
  await f.coordinator().claim(f.invocation());
  f.advance(105);
  const first = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(first.status, 'not-run');
  assert.equal(first.record.reason, 'attempts-exhausted');
  assert.equal(ran, 0);
  await f.runner.tick(f.invocation());
  assert.equal(ran, 1);
});

test('lost claim response requires one positive revalidation before dispatch', async () => {
  let ran = 0, writes = 0;
  const f = fixture({ execute: async () => { ran++; } });
  f.store.writeHook = async () => ({ status: ++writes === 1 ? 'indeterminate' : 'applied' });
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(ran, 1);
  assert.equal(result.coordination, 'settled');
  assert.equal(f.store.reads.length, 3);
  assert.equal(f.store.writes.length, 3);
  assert.equal(f.store.writes[0].value.attemptToken, f.store.writes[1].value.attemptToken);
});

test('repeated uncertainty remains bounded and never dispatches', async () => {
  let ran = 0;
  const f = fixture({ execute: async () => { ran++; } });
  f.store.writeHook = async () => ({ status: 'indeterminate' });
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(result.coordination, 'indeterminate');
  assert.equal(ran, 0);
  assert.equal(f.store.reads.length, 2);
  assert.equal(f.store.writes.length, 2);
});

test('stale self-read cannot reconcile an uncertain claim over a successor', async () => {
  let ran = 0, old;
  const f = fixture({ execute: async () => { ran++; } });
  f.store.writeHook = async (write) => {
    old = f.store.snapshot(write.key);
    f.store.seed(write.key, { ...write.value, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' });
    f.store.readHook = async () => clone(old);
    return { status: 'indeterminate' };
  };
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(result.coordination, 'conflict');
  assert.equal(ran, 0);
  assert.equal(f.store.snapshot().value.attemptToken, 'successor');
});

test('unknown settlement is revalidated without executing application effects again', async () => {
  let ran = 0, writes = 0;
  const f = fixture({ execute: async () => { ran++; } });
  f.store.writeHook = async () => ({ status: ++writes === 2 ? 'indeterminate' : 'applied' });
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(ran, 1);
  assert.equal(result.coordination, 'settled');
  assert.equal(result.record.state, 'completed');
  assert.equal(f.store.writes.length, 3);
});

test('pre-cancelled and expired invocations perform no storage I/O', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.runner.tick(f.invocation(undefined, controller.signal))).status, 'cancelled');
  assert.equal((await f.runner.tick(f.invocation(1_007))).status, 'expired');
  assert.equal(f.store.reads.length, 0);
  assert.equal(f.timers.size, 0);
});

test('cancellation during read prevents claim writes and dispatch', async () => {
  let ran = 0;
  const f = fixture({ execute: async () => { ran++; } });
  const controller = new AbortController();
  f.store.readHook = async (_key, snapshot) => { controller.abort(); return snapshot; };
  const result = await f.runner.tick(f.invocation(undefined, controller.signal));
  assert.equal(result.status, 'cancelled');
  assert.equal(ran, 0);
  assert.equal(f.store.writes.length, 0);
});

test('parent cancellation reaches a running job and stops later scanning', async () => {
  const started = deferred(), late = deferred();
  let later = 0;
  const f = fixture({ jobs: [job('first', async (ctx) => { started.resolve(ctx); await late.promise; }), job('later', async () => { later++; })] });
  const controller = new AbortController();
  const running = f.runner.tick(f.invocation(undefined, controller.signal));
  const context = await started.promise;
  controller.abort();
  const result = await running;
  assert.equal(context.signal.aborted, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.visited, 1);
  assert.equal(result.results[0].outcome, 'cancelled');
  assert.equal(f.store.writes.length, 1);
  assert.equal(later, 0);
  late.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.writes.length, 1);
  assert.equal(f.timers.size, 0);
});

test('a job ignoring cancellation stops waiting at its lease bound; late rejection is handled', async () => {
  const started = deferred(), late = deferred();
  const f = fixture({ execute: async (ctx) => { started.resolve(ctx); await late.promise; } });
  const running = f.runner.tick(f.invocation());
  const context = await started.promise;
  f.advance(93); f.fire();
  const result = await running;
  assert.equal(result.status, 'expired');
  assert.equal(result.results[0].outcome, 'deadline-exceeded');
  assert.equal(context.signal.aborted, true);
  assert.equal(f.store.snapshot().value.state, 'leased');
  late.reject(new Error('late secret')); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.writes.length, 1);
  assert.equal(f.timers.size, 0);
});

test('late application completion without a timer callback still cannot settle', async () => {
  const f = fixture({ execute: async () => { f.advance(93); } });
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(result.outcome, 'deadline-exceeded');
  assert.equal(f.store.writes.length, 1);
});

test('coordination writes are awaited through cancellation and their late success never dispatches', async () => {
  const written = deferred(), reply = deferred();
  let ran = 0;
  const f = fixture({ execute: async () => { ran++; } });
  f.store.writeHook = async () => { written.resolve(); return reply.promise; };
  const running = f.runner.tick(f.invocation(1_050));
  await written.promise;
  f.advance(43); f.fire();
  let returned = false; running.then(() => { returned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  reply.resolve({ status: 'applied' });
  const result = await running;
  assert.equal(result.status, 'expired');
  assert.equal(ran, 0);
  assert.equal(result.results[0].coordination, 'expired');
});

test('cancellation during settlement preserves positively known late completion evidence', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.store.writeHook = async (write) => { if (write.value.state === 'completed') controller.abort(); return { status: 'applied' }; };
  const result = await f.runner.tick(f.invocation(undefined, controller.signal));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.results[0].outcome, 'completed');
  assert.equal(result.results[0].record.state, 'completed');
  assert.equal(result.results[0].settlementDeadlineExceeded, true);
});

test('the invocation monotonic budget does not reset when visiting another job with a frozen wall clock', async () => {
  const f = fixture({ jobs: [job('first', async () => { f.advance(30, false); }), job('second', async () => { assert.fail('must not execute'); })] });
  let reads = 0;
  f.store.readHook = async (_key, snapshot) => { if (++reads === 3) f.advance(15, false); return snapshot; };
  const result = await f.runner.tick(f.invocation(1_050));
  assert.equal(result.status, 'expired');
  assert.equal(result.results[0].outcome, 'completed');
  assert.equal(result.results[1].status, 'not-run');
});

test('wall clock rollback after application work leaves the lease for recovery', async () => {
  const f = fixture({ execute: async () => { f.setWall(999); } });
  const result = await f.runner.tick(f.invocation());
  assert.equal(result.status, 'expired');
  assert.equal(result.results[0].outcome, 'deadline-exceeded');
  assert.equal(f.store.writes.length, 1);
});

test('telemetry exceptions cannot change ownership, dispatch, or settlement', async () => {
  let events = 0;
  const f = fixture({ telemetry: { emit(event) { events++; assert.equal(Object.isFrozen(event), true); throw new Error('sink failed'); } } });
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(result.record.state, 'completed');
  assert.equal(events, 3);
});

test('captured job/configuration and invocation cannot be changed during I/O', async () => {
  let ran = 0;
  const f = fixture({ execute: async () => { ran++; } });
  const invocation = f.invocation(1_050);
  f.store.readHook = async (_key, snapshot) => {
    invocation.deadlineMs = 100_000;
    f.definition.jobs[0].execute = async () => assert.fail('mutated execute');
    f.definition.jobs[0].schedule.everyMs = 1;
    f.definition.limits.leaseMs = 10_000;
    return snapshot;
  };
  const result = (await f.runner.tick(invocation)).results[0];
  assert.equal(ran, 1);
  assert.equal(result.run.scheduledForMs, 1_000);
  assert.equal(f.store.writes[0].value.leaseExpiresAtMs, 1_100);
});

test('invalid definitions, host bindings, and cursors fail before storage I/O', async () => {
  const f = fixture();
  assert.throws(() => createRunner({ ...f.definition, jobs: [job('duplicate'), job('duplicate')] }, f.runtime), TypeError);
  assert.throws(() => createRunner({ ...f.definition, limits: { ...f.definition.limits, maxJobsPerTick: 0 } }, f.runtime), TypeError);
  assert.throws(() => createRunner(f.definition, {}), TypeError);
  await assert.rejects(() => f.runner.tick(f.invocation(), { startAt: 1 }), TypeError);
  assert.equal(f.store.reads.length, 0);
  const empty = createRunner({ ...f.definition, jobs: [] }, f.runtime);
  const result = await empty.tick(f.invocation());
  assert.equal(result.visited, 0);
  assert.equal(result.nextJobIndex, 0);
});

test('timer or telemetry cancellation immediately before dispatch cannot run a job', async () => {
  const parent = new AbortController();
  let ran = 0;
  const f = fixture({ execute: async () => { ran++; }, telemetry: { emit(event) { if (event.kind === 'run-state') parent.abort(); } } });
  const result = await f.runner.tick(f.invocation(undefined, parent.signal));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.results[0].status, 'not-run');
  assert.equal(ran, 0);
  assert.equal(f.store.writes.length, 1);
});

test('each attempt gets a distinct signal revoked before the next job starts', async () => {
  let first;
  const f = fixture({ jobs: [job('first', async (ctx) => { first = ctx.signal; }), job('second', async (ctx) => {
    assert.equal(first.aborted, true);
    assert.notEqual(ctx.signal, first);
    assert.equal(ctx.signal.aborted, false);
  })] });
  const result = await f.runner.tick(f.invocation());
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every((r) => r.record.state === 'completed'), true);
});

test('hostile thrown proxies cannot escape sanitized application failure handling', async () => {
  const error = new Proxy({}, { getPrototypeOf() { throw new Error('secret-from-getter'); } });
  const f = fixture({ execute: async () => { throw error; } });
  const result = (await f.runner.tick(f.invocation())).results[0];
  assert.equal(result.failureCode, 'job-error');
  assert.equal(result.record.state, 'retryable');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('standard host timers abort an uncooperative job without a polling loop', async () => {
  const f = fixture({ execute: async () => new Promise(() => {}), limits: { leaseMs: 30, maxClockSkewMs: 0, deadlineSafetyMs: 1 } });
  f.definition.bindings.clock = { nowMs: () => Date.now(), monotonicMs: () => performance.now() };
  const runtime = { createAbortController: () => new AbortController(), setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  } };
  const runner = createRunner(f.definition, runtime);
  const result = await runner.tick({ requestId: 'native-timer', deadlineMs: Date.now() + 1_000, signal: new AbortController().signal });
  assert.equal(result.status, 'expired');
  assert.equal(result.results[0].outcome, 'deadline-exceeded');
  assert.equal(f.store.writes.length, 1);
});
