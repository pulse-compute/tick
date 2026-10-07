import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, runReferenceBurst } from '../../proof/trigger/reference.mjs';
import { createFastlyTrigger } from '../../dist/adapters/fastly-trigger.js';
import { createCooperativeController } from '../../dist/cancellation.js';
import { createJobCoordinator } from '../../dist/core.js';

test('routing, method, query, and malformed token reject before secrets or storage', async () => {
  const f = fixture(); let loads = 0;
  const handler = createFastlyTrigger({ ...f.options, loadToken: async () => { loads++; return 't'.repeat(40); } });
  for (const [request, status] of [[f.request({ path: '/wrong' }), 404], [f.request({ method: 'POST' }), 405],
    [f.request({ path: '/__tick/run?unexpected=1' }), 400], [f.request({ supplied: '' }), 401]]) {
    const response = await handler(request);
    assert.equal(response.status, status);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(loads, 0); assert.equal(f.calls.length, 0);
});

test('wrong, missing, and failing secrets are sanitized before storage I/O', async () => {
  const f = fixture();
  assert.equal((await f.handler(f.request({ supplied: 'x'.repeat(40) }))).status, 401);
  for (const loadToken of [async () => undefined, async () => { throw new Error('secret-value'); }]) {
    const response = await createFastlyTrigger({ ...f.options, loadToken })(f.request());
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('secret-value'), false);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
});

test('one admitted invocation scans jobs; repeated same-window probes never touch job storage', async () => {
  const f = fixture();
  const first = await (await f.handler(f.request())).json();
  assert.equal(first.admission.status, 'owned');
  assert.equal(first.admission.settlement, 'settled');
  assert.equal(first.metrics.visited, 4); assert.equal(first.metrics.executions, 4);
  assert.equal(first.metrics.jobReads, 8); assert.equal(first.metrics.jobWrites, 8);
  assert.equal(first.cancellation, 'cooperative-only');
  const second = await (await f.handler(f.request())).json();
  assert.equal(second.admission.status, 'skipped');
  assert.equal(second.metrics.jobReads, 0); assert.equal(second.metrics.jobWrites, 0);
  assert.equal(second.metrics.admissionReads, 1); assert.equal(second.metrics.admissionWrites, 0);
});

test('duplicate burst reduces job fanout while retaining explicit admission work and incoming requests', async () => {
  const report = await runReferenceBurst();
  assert.equal(report.complete, true); assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.requests, 100); assert.equal(report.baseline.visited, 1_600);
  assert.equal(report.admitted.sweeps, 1); assert.equal(report.admitted.visited, 16);
  assert.equal(report.admitted.executions, 16); assert.equal(report.baseline.executions, 16);
  assert.equal(report.admitted.admissionReads, 101); assert.equal(report.admitted.admissionWrites, 101);
  assert.equal(report.admitted.jobReads, 32); assert.equal(report.admitted.jobWrites, 32);
  assert.ok(report.storageReductionPercent > 80);
});

test('concurrent observations count each request independently and only one scans', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 16 }, async () => (await f.handler(f.request())).json()));
  assert.equal(results.filter((result) => result.admission.status === 'owned').length, 1);
  assert.equal(new Set(results.map((result) => result.requestId)).size, 16);
  for (const result of results.filter((result) => result.admission.status !== 'owned')) {
    assert.equal(result.metrics.visited, 0); assert.equal(result.metrics.jobReads, 0); assert.equal(result.metrics.jobWrites, 0);
  }
  assert.equal(results.reduce((sum, result) => sum + result.metrics.admissionWrites, 0), 17);
});

test('admission slots rotate the bounded job slice without a per-POP cursor', async () => {
  const f = fixture();
  const first = await (await f.handler(f.request())).json();
  assert.deepEqual(first.tick.results.map((result) => result.jobId), ['job-4', 'job-5', 'job-6', 'job-7']);
  f.advance(1_000);
  const next = await (await f.handler(f.request())).json();
  assert.deepEqual(next.tick.results.map((result) => result.jobId), ['job-0', 'job-1', 'job-2', 'job-3']);
  assert.equal(f.effects.length, 8);
});

test('lost admission write reply requires known conditional revalidation before scanning', async () => {
  const f = fixture(); let writes = 0;
  f.store.writeHook = async (write) => ({ status: write.key === f.gateKey && ++writes === 1 ? 'indeterminate' : 'applied' });
  const result = await (await f.handler(f.request())).json();
  assert.equal(result.admission.status, 'owned'); assert.equal(result.metrics.visited, 4);
  assert.equal(result.metrics.admissionReads, 3); assert.equal(result.metrics.admissionWrites, 3);
  const claims = f.calls.filter((call) => call.kind === 'write' && call.key === f.gateKey);
  assert.equal(claims[0].value.attemptToken, claims[1].value.attemptToken);
});

test('repeated unknown admission outcomes never scan and reconciliation is bounded', async () => {
  const f = fixture(); f.store.writeHook = async () => ({ status: 'indeterminate' });
  const response = await f.handler(f.request()); const result = await response.json();
  assert.equal(response.status, 503); assert.equal(result.admission.status, 'indeterminate');
  assert.equal(result.metrics.admissionReads, 2); assert.equal(result.metrics.admissionWrites, 2);
  assert.equal(result.metrics.jobReads, 0); assert.equal(f.effects.length, 0);
});

test('stale self-read cannot revalidate admission over a successor', async () => {
  const f = fixture(); let stale;
  f.store.writeHook = async (write) => {
    stale = f.store.snapshot(write.key);
    f.store.seed(write.key, { ...write.value, attempt: 2, attemptToken: 'successor', mutationId: 'successor-mutation' });
    f.store.readHook = async () => structuredClone(stale);
    return { status: 'indeterminate' };
  };
  const result = await (await f.handler(f.request())).json();
  assert.equal(result.admission.status, 'conflict'); assert.equal(result.metrics.jobReads, 0);
  assert.equal(f.store.snapshot(f.gateKey).value.attemptToken, 'successor');
});

test('crashed admission recovers the same sweep and individual job state rejects completed replay', async () => {
  const f = fixture({ gateLimits: { leaseMs: 100 } });
  const gate = createJobCoordinator({ namespace: f.definition.namespace, job: { id: 'trigger-admission', schedule: f.admission.schedule },
    coordination: f.admission.coordination, clock: f.clock, ids: f.definition.bindings.ids, limits: f.admission.limits });
  const crashed = await gate.claim({ requestId: 'crashed', deadlineMs: 6_000, signal: createCooperativeController().signal });
  const job = createJobCoordinator({ namespace: f.definition.namespace, job: f.definition.jobs[4],
    coordination: f.definition.bindings.coordination, clock: f.clock, ids: f.definition.bindings.ids, limits: f.definition.limits });
  const completed = await job.claim({ requestId: 'first-job', deadlineMs: 6_000, signal: createCooperativeController().signal });
  await job.settle(completed.lease, { kind: 'completed' });
  f.advance(105);
  const result = await (await f.handler(f.request())).json();
  assert.equal(result.admission.attempt, 2);
  assert.equal(result.admission.scheduledForMs, crashed.lease.record.run.scheduledForMs);
  assert.equal(result.metrics.visited, 4); assert.equal(result.metrics.executions, 3);
  assert.equal(result.tick.results[0].coordination, 'skipped');
});

test('budget consumed by authentication cannot start admission or work', async () => {
  const f = fixture();
  const handler = createFastlyTrigger({ ...f.options, loadToken: async () => { f.advance(4_990); return 't'.repeat(40); } });
  assert.equal((await handler(f.request())).status, 503); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
});

test('late admitted writes cannot start job scanning', async () => {
  const f = fixture({ gateLimits: { leaseMs: 100 } });
  f.store.writeHook = async () => { f.advance(95); return { status: 'applied' }; };
  const response = await f.handler(f.request()); const result = await response.json();
  assert.equal(response.status, 503); assert.equal(result.admission.status, 'expired'); assert.equal(result.metrics.jobReads, 0);
});

test('an uncooperative timed-out job leaves admission leased and cannot open another scan', async () => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const f = fixture({ execute: async () => { started(); await new Promise(() => {}); }, jobLimits: { leaseMs: 100 } });
  const running = f.handler(f.request()); await ready; f.advance(90);
  const response = await running; const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.tick.status, 'expired'); assert.equal(body.metrics.executions, 1);
  assert.equal(f.store.snapshot(f.gateKey).value.state, 'leased');
  const later = await (await f.handler(f.request())).json();
  assert.equal(later.admission.status, 'skipped'); assert.equal(later.metrics.jobReads, 0); assert.equal(f.timers.size, 0);
});

test('parent cancellation and clock rollback fail closed during admission', async () => {
  for (const fault of ['abort', 'rollback']) {
    const f = fixture(); const parent = new AbortController();
    f.store.readHook = async (_key, value) => { if (fault === 'abort') parent.abort(); else f.setWall(999); return value; };
    const response = await f.handler(f.request({ signal: parent.signal })); const result = await response.json();
    assert.equal(response.status, 503); assert.equal(result.metrics.jobReads, 0);
    assert.equal(f.calls.filter((call) => call.kind === 'write').length, 0);
  }
});

test('captured configuration and whitelisted metadata cannot leak arbitrary fields', async () => {
  const f = fixture();
  const handler = createFastlyTrigger({ ...f.options, metadata: () => ({ receiverPop: 'test', serviceId: 'test', serviceVersion: '1', secret: 'hidden' }),
    loadToken: async () => {
      f.definition.jobs[4].execute = async () => assert.fail('mutated job');
      f.admission.schedule.everyMs = 1;
      f.options.requestTimeoutMs = 1;
      return 't'.repeat(40);
    } });
  const result = await (await handler(f.request())).json();
  assert.equal(result.metrics.executions, 4); assert.equal('secret' in result, false);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('separate admission prefix and a useful request budget are validated before I/O', () => {
  const f = fixture();
  assert.throws(() => createFastlyTrigger({ ...f.options, admission: { ...f.admission, coordination: f.definition.bindings.coordination } }), TypeError);
  assert.throws(() => createFastlyTrigger({ ...f.options, requestTimeoutMs: 15 }), TypeError);
  assert.equal(f.calls.length, 0);
});

test('cooperative signals make no native transport claim, cancel once, and contain observer failures', () => {
  const controller = createCooperativeController(); let called = 0;
  controller.signal.addEventListener('abort', () => { throw new Error('observer'); });
  const removed = () => assert.fail('removed listener');
  controller.signal.addEventListener('abort', removed); controller.signal.removeEventListener('abort', removed);
  controller.signal.addEventListener('abort', () => { called++; }, { once: true });
  controller.abort(); controller.abort();
  assert.equal(controller.signal.aborted, true); assert.equal(called, 1);
  assert.equal('nativeSignal' in controller, false); assert.equal('throwIfAborted' in controller.signal, false);
});
