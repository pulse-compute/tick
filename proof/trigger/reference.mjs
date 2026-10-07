// Atomic reference storage, injected clocks and timers. No deployed guarantees.
import { createCooperativeController } from '../../dist/cancellation.js';
import { createFastlyTrigger } from '../../dist/adapters/fastly-trigger.js';
import { createRunner } from '../../dist/runner.js';

export const token = 't'.repeat(40);
export function fixture({ jobCount = 8, maxJobsPerTick = 4, gateEveryMs = 1_000, execute,
  gateLimits = {}, jobLimits = {}, requestTimeoutMs = 5_000 } = {}) {
  let wall = 1_000, mono = 0, ids = 0, revision = 9007199254740993n;
  const rows = new Map(), timers = new Set(), effects = [], calls = [];
  const store = {
    capabilities: { atomicCreate: true, atomicReplace: true, scope: 'global-per-key', coherentValueRevision: true, reads: 'possibly-stale' },
    readHook: undefined, writeHook: undefined,
    snapshot(key) { const row = rows.get(key); return row ? { status: 'found', value: structuredClone(row.value), revision: row.revision } : { status: 'absent' }; },
    seed(key, value) { rows.set(key, { value: structuredClone(value), revision: String(++revision) }); },
    async read(key) {
      calls.push({ kind: 'read', key });
      const value = store.snapshot(key);
      return store.readHook ? store.readHook(key, value) : value;
    },
    async compareAndSwap(operation) {
      calls.push({ kind: 'write', ...structuredClone(operation) });
      const row = rows.get(operation.key);
      if (operation.expected.kind === 'absent' ? !!row : !row || row.revision !== operation.expected.revision) return { status: 'conflict' };
      store.seed(operation.key, operation.value);
      return store.writeHook ? store.writeHook(operation) : { status: 'applied' };
    },
  };
  const runtime = { createCancellationController: createCooperativeController, setTimer(callback, delayMs) {
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) throw new Error('bad timer');
    const timer = { at: mono + delayMs, callback }; timers.add(timer);
    return () => timers.delete(timer);
  } };
  const clock = { nowMs: () => wall, monotonicMs: () => mono };
  const idSource = { newAttemptToken: () => `attempt-${++ids}`, newMutationId: () => `mutation-${++ids}` };
  const definition = { contractVersion: 1, namespace: 'tick05-reference',
    bindings: { coordination: { name: 'jobs', prefix: 'jobs/', store }, clock, ids: idSource, resources: { effects } },
    limits: { maxJobsPerTick, maxAttemptsPerRun: 3, leaseMs: 1_000, runTimeoutMs: 5_000,
      retryDelayMs: 20, maxClockSkewMs: 5, deadlineSafetyMs: 5, ...jobLimits },
    jobs: Array.from({ length: jobCount }, (_, index) => ({ id: `job-${index}`,
      schedule: { kind: 'interval', anchorMs: 0, everyMs: 1_000, revision: 'v1', missedWindows: 'skip' },
      execute: execute ?? (async (context, resources) => { resources.effects.push(context.run.id); }) })),
  };
  const admission = { coordination: { name: 'admission', prefix: 'admission/', store },
    schedule: { kind: 'interval', anchorMs: 0, everyMs: gateEveryMs, revision: 'v1', missedWindows: 'skip' },
    limits: { maxAttemptsPerRun: 3, leaseMs: 1_000, runTimeoutMs: 5_000,
      retryDelayMs: 20, maxClockSkewMs: 5, deadlineSafetyMs: 5, ...gateLimits },
  };
  const options = { definition, admission, runtime, requestTimeoutMs, loadToken: async () => token,
    requestId: () => `request-${++ids}`, metadata: () => ({ receiverPop: 'reference', serviceId: 'reference', serviceVersion: '1' }) };
  return { options, definition, admission, clock, runtime, store, timers, calls, effects,
    handler: createFastlyTrigger(options), runner: createRunner(definition, runtime),
    advance(ms) { wall += ms; mono += ms; for (const timer of [...timers]) if (timer.at <= mono) { timers.delete(timer); timer.callback(); } },
    setWall(ms) { wall = ms; },
    request({ supplied = token, path = '/__tick/run', method = 'GET', signal } = {}) {
      return new Request(`https://receiver.example${path}`, { method, headers: { 'x-tick-probe-token': supplied }, ...(signal ? { signal } : {}) });
    },
    gateKey: 'admission/["tick.job.v1","tick05-reference","trigger-admission"]',
    jobKey(index) { return `jobs/["tick.job.v1","tick05-reference","job-${index}"]`; },
  };
}

export async function runReferenceBurst({ requests = 100, jobs = 16 } = {}) {
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > 256 || !Number.isSafeInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('Invalid burst bounds');
  const baseline = fixture({ jobCount: jobs, maxJobsPerTick: jobs });
  const before = await Promise.all(Array.from({ length: requests }, (_, index) => baseline.runner.tick({
    requestId: `baseline-${index}`, deadlineMs: 6_000, signal: createCooperativeController().signal,
  })));
  const gated = fixture({ jobCount: jobs, maxJobsPerTick: jobs });
  const responses = await Promise.all(Array.from({ length: requests }, () => gated.handler(gated.request())));
  const bodies = await Promise.all(responses.map((response) => response.json()));
  const counts = (calls, prefix, kind) => calls.filter((call) => call.key.startsWith(prefix) && call.kind === kind).length;
  const baseCalls = baseline.calls.length, gateCalls = gated.calls.length;
  return { schema: 'tick.trigger.burst.v1', mode: 'synthetic', requests, jobs,
    baseline: { visited: before.reduce((sum, result) => sum + result.visited, 0), executions: baseline.effects.length,
      jobReads: counts(baseline.calls, 'jobs/', 'read'), jobWrites: counts(baseline.calls, 'jobs/', 'write'), totalStorageCalls: baseCalls },
    admitted: { sweeps: bodies.filter((body) => body.admission?.status === 'owned').length,
      visited: bodies.reduce((sum, body) => sum + (body.metrics?.visited ?? 0), 0), executions: gated.effects.length,
      admissionReads: counts(gated.calls, 'admission/', 'read'), admissionWrites: counts(gated.calls, 'admission/', 'write'),
      jobReads: counts(gated.calls, 'jobs/', 'read'), jobWrites: counts(gated.calls, 'jobs/', 'write'), totalStorageCalls: gateCalls },
    complete: responses.every((response) => response.status === 200) && bodies.every((body) => body.schema === 'tick.trigger.observation.v1'),
    storageReductionPercent: Math.round((1 - gateCalls / baseCalls) * 10_000) / 100,
    verdict: 'inconclusive', note: 'Incoming requests are not suppressed. Atomic reference storage only; no native probe or cross-POP evidence.' };
}
