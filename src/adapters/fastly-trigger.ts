import { createJobCoordinator } from '../core.js';
import type { CoordinationResult, CoordinatorLimits } from '../core.js';
import { createRunner } from '../runner.js';
import { captureClock, captureCoordination, captureIds, captureRuntime, captureTelemetry } from '../internal/bindings.js';
import type { ExecutionRuntime, TickResult } from '../runner.js';
import type { CoordinationBinding, CoordinationStore, IntervalSchedule, TickDefinition } from '../index.js';

export interface FastlyTriggerOptions<Resources> {
  readonly definition: TickDefinition<Resources>;
  readonly admission: {
    /** Separate prefix; the same physical store can back admission and job records. */
    readonly coordination: CoordinationBinding;
    readonly schedule: IntervalSchedule;
    readonly limits: CoordinatorLimits;
  };
  readonly runtime: ExecutionRuntime;
  readonly path?: string;
  readonly requestTimeoutMs: number;
  readonly loadToken: () => Promise<string | undefined>;
  readonly requestId: () => string;
  readonly metadata?: () => { readonly receiverPop: string; readonly serviceId: string; readonly serviceVersion: string };
}

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store, max-age=0',
  'surrogate-control': 'no-store', 'x-content-type-options': 'nosniff' };
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { ...HEADERS, ...extra },
});
function matchesToken(actual: string, expected: string): boolean {
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < 256; index++) difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  return difference === 0;
}
function counted(store: CoordinationStore, counters: { reads: number; writes: number }): CoordinationStore {
  const read = store.read.bind(store), write = store.compareAndSwap.bind(store);
  return { capabilities: store.capabilities,
    read(key) { counters.reads++; return read(key); },
    compareAndSwap(operation) { counters.writes++; return write(operation); },
  };
}

/** Authenticated awaited trigger. Admission never substitutes for individual job ownership. */
export function createFastlyTrigger<Resources>(options: FastlyTriggerOptions<Resources>): (request: Request) => Promise<Response> {
  const path = options.path ?? '/__tick/run';
  const timeoutMs = options.requestTimeoutMs;
  if (!/^\/[A-Za-z0-9/_-]{1,127}$/.test(path) || !integer(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || typeof options.loadToken !== 'function' || typeof options.requestId !== 'function'
    || options.admission.coordination.prefix === options.definition.bindings.coordination.prefix) {
    throw new TypeError('Invalid Tick trigger configuration');
  }
  const clock = captureClock(options.definition.bindings.clock), ids = captureIds(options.definition.bindings.ids);
  const coordination = captureCoordination(options.definition.bindings.coordination);
  const telemetry = captureTelemetry(options.definition.bindings.telemetry);
  const definition = Object.freeze({ ...options.definition,
    limits: Object.freeze({ ...options.definition.limits }),
    bindings: Object.freeze({ ...options.definition.bindings, clock, ids,
      coordination, ...(telemetry ? { telemetry } : {}) }),
    jobs: Object.freeze(options.definition.jobs.map((job) => Object.freeze({ ...job, schedule: Object.freeze({ ...job.schedule }) }))),
  });
  const admission = Object.freeze({ ...options.admission,
    coordination: captureCoordination(options.admission.coordination),
    schedule: Object.freeze({ ...options.admission.schedule }), limits: Object.freeze({ ...options.admission.limits }),
  });
  const runtime = captureRuntime(options.runtime);
  const loadToken = options.loadToken.bind(options), requestId = options.requestId.bind(options);
  const metadata = options.metadata?.bind(options);
  const gateOptions = { namespace: definition.namespace, job: { id: 'trigger-admission', schedule: admission.schedule },
    coordination: admission.coordination, clock, ids: definition.bindings.ids, limits: admission.limits };
  // Validate declarations once, without reads, secrets, timers or host handles.
  createJobCoordinator(gateOptions);
  createRunner(definition, runtime);
  const margin = admission.limits.maxClockSkewMs + admission.limits.deadlineSafetyMs;
  const reserve = admission.limits.deadlineSafetyMs;
  if (timeoutMs <= margin + reserve) throw new TypeError('Tick trigger leaves no execution time');

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== path) return reply(404, { error: 'not_found' });
    if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    if (url.search || request.body !== null) return reply(400, { error: 'invalid_request' });
    const supplied = request.headers.get('x-tick-probe-token') ?? '';
    if (!TOKEN.test(supplied)) return reply(401, { error: 'unauthorized' });
    let cancelTimer: (() => void) | undefined;
    let controller: ReturnType<ExecutionRuntime['createCancellationController']> | undefined;
    let onCancel: (() => void) | undefined;
    const parent = request.signal; // The pinned guest supplies no native request signal.
    const gateCalls = { reads: 0, writes: 0 }, jobCalls = { reads: 0, writes: 0 };
    try {
      const receivedAtMs = clock.nowMs(), startedMono = clock.monotonicMs();
      if (!integer(receivedAtMs) || !Number.isFinite(startedMono) || startedMono < 0 || startedMono > Number.MAX_SAFE_INTEGER
        || !integer(receivedAtMs + timeoutMs)) throw new TypeError('Invalid Tick clock');
      const deadlineMs = receivedAtMs + timeoutMs;
      controller = runtime.createCancellationController();
      const scope = controller;
      onCancel = () => scope.abort();
      parent?.addEventListener('abort', onCancel, { once: true });
      if (parent?.aborted) scope.abort();
      cancelTimer = runtime.setTimer(() => scope.abort(), timeoutMs - margin);
      if (typeof cancelTimer !== 'function') throw new TypeError('Invalid Tick timer binding');
      let lastWall = receivedAtMs, lastMono = startedMono, invalid = false;
      const usable = () => {
        try {
          const wall = clock.nowMs(), mono = clock.monotonicMs();
          const effective = Math.max(wall, receivedAtMs + Math.ceil(mono - startedMono));
          if (!integer(wall) || wall < lastWall || !Number.isFinite(mono) || mono < lastMono || mono > Number.MAX_SAFE_INTEGER
            || !integer(effective) || effective >= deadlineMs - margin) invalid = true;
          lastWall = wall; lastMono = mono;
        } catch { invalid = true; }
        if (invalid) scope.abort();
        return !scope.signal.aborted;
      };
      if (!usable()) return reply(503, { error: 'trigger_unavailable' });
      const expected = await loadToken();
      if (typeof expected !== 'string' || !TOKEN.test(expected)) return reply(503, { error: 'trigger_unavailable' });
      if (!matchesToken(supplied, expected)) return reply(401, { error: 'unauthorized' });
      if (!usable()) return reply(503, { error: 'trigger_unavailable' });
      const id = requestId();
      if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('Invalid Tick request ID');
      const rawInfo = metadata?.();
      const info = rawInfo ? { receiverPop: rawInfo.receiverPop, serviceId: rawInfo.serviceId, serviceVersion: rawInfo.serviceVersion } : undefined;
      if (info && ![info.receiverPop, info.serviceId, info.serviceVersion].every((value) => typeof value === 'string' && ID.test(value))) {
        throw new TypeError('Invalid Tick receiver metadata');
      }
      const invocation = Object.freeze({ requestId: id, deadlineMs, signal: scope.signal });
      const gate = createJobCoordinator({ ...gateOptions, coordination: {
        ...admission.coordination, store: counted(admission.coordination.store, gateCalls),
      } });
      const resolve = async (result: CoordinationResult) => result.status === 'indeterminate' && usable()
        ? gate.reconcile(result.pending) : result;
      const claimed = await resolve(await gate.claim(invocation));
      const observation = (status: number, admissionStatus: string, tick?: TickResult, settlement?: CoordinationResult) => reply(status, {
        schema: 'tick.trigger.observation.v1', requestId: id, receivedAtMs, ...info,
        admission: { status: admissionStatus,
          ...(claimed.status === 'owned' ? { scheduledForMs: claimed.lease.record.run.scheduledForMs, attempt: claimed.lease.record.attempt } : {}),
          ...(settlement ? { settlement: settlement.status } : {}) },
        cancellation: scope.nativeSignal ? 'native-transport' : 'cooperative-only',
        metrics: { admissionReads: gateCalls.reads, admissionWrites: gateCalls.writes,
          jobReads: jobCalls.reads, jobWrites: jobCalls.writes, visited: tick?.visited ?? 0,
          executions: tick?.results.filter((result) => result.status === 'executed').length ?? 0 },
        ...(tick ? { tick } : {}),
      });
      if (claimed.status !== 'owned') {
        return observation(['skipped', 'conflict', 'settled'].includes(claimed.status) ? 200 : 503, claimed.status);
      }
      if (!usable() || !gate.isUsable(claimed.lease)) return observation(503, 'expired');
      const slotIndex = (BigInt(claimed.lease.record.run.scheduledForMs) - BigInt(admission.schedule.anchorMs)) / BigInt(admission.schedule.everyMs);
      const startAt = definition.jobs.length ? Number(slotIndex * BigInt(definition.limits.maxJobsPerTick) % BigInt(definition.jobs.length)) : 0;
      // Only a known admitted invocation constructs/visits the job runner and touches job storage.
      const runner = createRunner({ ...definition, bindings: { ...definition.bindings,
        coordination: { ...definition.bindings.coordination, store: counted(definition.bindings.coordination.store, jobCalls) },
      } }, runtime);
      const runnerDeadline = Math.min(deadlineMs, claimed.lease.record.leaseExpiresAtMs, claimed.lease.record.runDeadlineMs) - reserve;
      const tick = await runner.tick({ ...invocation, deadlineMs: runnerDeadline }, { startAt });
      if (tick.status !== 'finished' || !usable() || !gate.isUsable(claimed.lease)) return observation(503, 'owned', tick);
      const settled = await resolve(await gate.settle(claimed.lease, { kind: 'completed' }));
      return observation(settled.status === 'settled' && usable() ? 200 : 503, 'owned', tick, settled);
    } catch {
      return reply(503, { error: 'trigger_unavailable' });
    } finally {
      cancelTimer?.();
      if (onCancel) parent?.removeEventListener('abort', onCancel);
      controller?.abort();
    }
  };
}
