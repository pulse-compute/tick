import { createJobCoordinator } from './core.js';
import { captureClock, captureCoordination, captureIds, captureRuntime, captureTelemetry } from './internal/bindings.js';
import type { CoordinationResult, JobCoordinator, OwnershipLease } from './core.js';
import type { CancellationController, Clock, CoordinationRecord, ExecutionContext, JobDefinition, LeasedRecord, RunIdentity, TickDefinition, TickEvent, TickInvocation } from './index.js';

/** Host capabilities are explicit: importing the package requires no timers or AbortController. */
export interface ExecutionRuntime {
  createCancellationController(): CancellationController;
  /** Schedule once, asynchronously; return an idempotent cancellation function. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

const codePattern = /^[A-Za-z0-9._:-]{1,80}$/;
/** Deliberate application failure policy. Other thrown values retry with code job-error. */
export class JobFailure extends Error {
  constructor(readonly disposition: 'retry' | 'permanent', readonly code: string) {
    if (!['retry', 'permanent'].includes(disposition) || typeof code !== 'string' || !codePattern.test(code)) {
      throw new TypeError('Invalid Tick job failure');
    }
    super(code);
    this.name = 'JobFailure';
  }
}

type CoordinationStatus = CoordinationResult['status'];
export type JobResult =
  | { readonly jobId: string; readonly status: 'not-run'; readonly coordination: Exclude<CoordinationStatus, 'owned'>;
      readonly record?: Exclude<CoordinationRecord, LeasedRecord> }
  | { readonly jobId: string; readonly status: 'executed'; readonly run: RunIdentity; readonly attempt: number;
      readonly outcome: 'completed' | 'retry' | 'failed' | 'cancelled' | 'deadline-exceeded';
      readonly coordination: CoordinationStatus; readonly failureCode?: string;
      readonly record?: Exclude<CoordinationRecord, LeasedRecord>; readonly settlementDeadlineExceeded?: boolean };

export interface TickResult {
  readonly status: 'finished' | 'cancelled' | 'expired';
  readonly visited: number;
  /** Caller-controlled scan continuation; not a durable or globally coordinated cursor. */
  readonly nextJobIndex: number;
  readonly results: readonly JobResult[];
}
export interface Runner {
  tick(invocation: TickInvocation, options?: { readonly startAt?: number }): Promise<TickResult>;
}

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
interface InvocationBudget { sample(): number | null; readonly cutoff: number }
function classifyFailure(error: unknown): { disposition: 'retry' | 'failed'; failureCode: string } {
  try {
    if (error instanceof JobFailure) {
      const disposition = error.disposition, code = error.code;
      if (['retry', 'permanent'].includes(disposition) && typeof code === 'string' && codePattern.test(code)) {
        return { disposition: disposition === 'permanent' ? 'failed' : 'retry', failureCode: code };
      }
    }
  } catch { /* Thrown proxies/getters remain ordinary sanitized application errors. */ }
  return { disposition: 'retry', failureCode: 'job-error' };
}

function makeBudget(clock: Clock, deadline: number, margin: number): InvocationBudget {
  let invalid = false, startWall = 0, startMono = 0, lastWall = 0, lastMono = 0;
  try { startWall = lastWall = clock.nowMs(); startMono = lastMono = clock.monotonicMs(); } catch { invalid = true; }
  if (!integer(startWall) || !Number.isFinite(startMono) || startMono < 0 || startMono > Number.MAX_SAFE_INTEGER) invalid = true;
  return { cutoff: deadline - margin, sample() {
    if (invalid) return null;
    try {
      const wall = clock.nowMs(), mono = clock.monotonicMs();
      if (!integer(wall) || wall < lastWall || !Number.isFinite(mono) || mono < lastMono || mono > Number.MAX_SAFE_INTEGER) invalid = true;
      lastWall = wall; lastMono = mono;
      const now = Math.max(wall, startWall + Math.ceil(mono - startMono));
      if (!integer(now) || now >= deadline - margin) invalid = true;
      return invalid ? null : now;
    } catch { invalid = true; return null; }
  } };
}

/** Bounded sequential execution. No background loop, automatic renewal, or in-call retry. */
export function createRunner<Resources>(definition: TickDefinition<Resources>, runtime: ExecutionRuntime): Runner {
  if (definition.contractVersion !== 1 || !integer(definition.limits.maxJobsPerTick)
    || definition.limits.maxJobsPerTick < 1 || !Array.isArray(definition.jobs)
    || typeof runtime?.createCancellationController !== 'function' || typeof runtime.setTimer !== 'function') {
    throw new TypeError('Invalid Tick runner configuration');
  }
  const limits = Object.freeze({ ...definition.limits });
  const namespace = definition.namespace;
  const coordination = captureCoordination(definition.bindings.coordination);
  const clock = captureClock(definition.bindings.clock), ids = captureIds(definition.bindings.ids);
  const resources = definition.bindings.resources;
  const emit = captureTelemetry(definition.bindings.telemetry)?.emit;
  const capturedRuntime = captureRuntime(runtime);
  const createController = capturedRuntime.createCancellationController, setTimer = capturedRuntime.setTimer;
  const margin = limits.maxClockSkewMs + limits.deadlineSafetyMs;
  const names = new Set<string>();
  const jobs = definition.jobs.map((job) => {
    if (names.has(job.id) || typeof job.execute !== 'function') throw new TypeError('Invalid Tick jobs');
    names.add(job.id);
    const snapshot: JobDefinition<Resources> = Object.freeze({ ...job, schedule: Object.freeze({ ...job.schedule }) });
    createJobCoordinator({ namespace, job: snapshot, coordination, clock, ids, limits });
    return snapshot;
  });
  // Validate the binding and limits even for an empty job list.
  if (!jobs.length) createJobCoordinator({ namespace, job: { id: 'validation', schedule: {
    kind: 'interval', anchorMs: 0, everyMs: 1, revision: 'validation', missedWindows: 'skip',
  } }, coordination, clock, ids, limits });

  const event = (value: TickEvent) => { try { emit?.(Object.freeze(value)); } catch { /* Observational only. */ } };
  function report(jobId: string, result: CoordinationResult): void {
    if (result.status === 'owned') {
      if (result.missedWindows) event({ kind: 'missed-windows', jobId, count: result.missedWindows, beforeMs: result.lease.record.run.scheduledForMs });
      event({ kind: 'run-state', run: result.lease.record.run, attempt: result.lease.record.attempt, state: 'leased' });
    } else if (result.status === 'settled') event({ kind: 'run-state', run: result.record.run, attempt: result.record.attempt, state: result.record.state });
    else if (['conflict', 'indeterminate', 'unavailable', 'configuration-mismatch'].includes(result.status)) {
      event({ kind: 'coordination', jobId, outcome: result.status as 'conflict' | 'indeterminate' | 'unavailable' | 'configuration-mismatch' });
    }
  }
  async function resolve(coordinator: JobCoordinator, jobId: string, result: CoordinationResult,
    check: () => number | null): Promise<CoordinationResult> {
    report(jobId, result);
    if (result.status !== 'indeterminate' || check() === null) return result;
    const reconciled = await coordinator.reconcile(result.pending); // One bounded revalidation, never a loop.
    report(jobId, reconciled);
    return reconciled;
  }

  return Object.freeze({ async tick(input: TickInvocation, options?: { readonly startAt?: number }): Promise<TickResult> {
    const requestId = input.requestId, deadlineMs = input.deadlineMs, parent = input.signal;
    const startAt = options?.startAt ?? 0;
    if (typeof requestId !== 'string' || !requestId || !integer(deadlineMs) || deadlineMs === 0
      || !parent || typeof parent.aborted !== 'boolean' || typeof parent.addEventListener !== 'function'
      || typeof parent.removeEventListener !== 'function' || !integer(startAt)
      || (jobs.length ? startAt >= jobs.length : startAt !== 0)) throw new TypeError('Invalid Tick invocation');
    const controller = createController();
    const signal = controller.signal;
    let stopped: 'cancelled' | 'expired' | undefined;
    const stop = (reason: 'cancelled' | 'expired') => {
      stopped ??= reason;
      controller.abort();
    };
    const onCancel = () => stop('cancelled');
    parent.addEventListener('abort', onCancel, { once: true });
    const budget = makeBudget(clock, deadlineMs, margin);
    const check = () => {
      if (parent.aborted) stop('cancelled');
      if (stopped) return null;
      const now = budget.sample();
      if (now === null) stop('expired');
      return now;
    };
    // Each coordinator sees the invocation's original elapsed timeline. A later job
    // cannot start its clock again from an unchanged raw wall time.
    const invocationClock: Clock = { nowMs() {
      const now = check();
      if (now === null) throw new TypeError('Tick invocation expired');
      return now;
    }, monotonicMs: clock.monotonicMs };
    const invocation = Object.freeze({ requestId, deadlineMs, signal });
    const results: JobResult[] = [];
    let cancelInvocationTimer: (() => void) | undefined;
    try {
      const now = check();
      if (now !== null) {
        cancelInvocationTimer = setTimer(() => stop('expired'), budget.cutoff - now);
        if (typeof cancelInvocationTimer !== 'function') throw new TypeError('Invalid Tick timer binding');
      }
      const visits = Math.min(limits.maxJobsPerTick, jobs.length);
      for (let offset = 0; offset < visits && check() !== null; offset++) {
        const job = jobs[(startAt + offset) % jobs.length]!;
        const coordinator = createJobCoordinator({ namespace, job, coordination, clock: invocationClock, ids, limits });
        const claimed = await resolve(coordinator, job.id, await coordinator.claim(invocation), check);
        if (claimed.status !== 'owned') {
          results.push(Object.freeze({ jobId: job.id, status: 'not-run', coordination: claimed.status,
            ...(claimed.status === 'settled' ? { record: claimed.record } : {}) }));
          continue;
        }
        const lease: OwnershipLease = claimed.lease;
        const ready = check();
        if (ready === null || !coordinator.isUsable(lease)) {
          stop('expired');
          results.push(Object.freeze({ jobId: job.id, status: 'not-run', coordination: 'expired' }));
          break;
        }
        let cancelled = false;
        let dispatched = false;
        const jobController = createController();
        if (jobController.signal === signal) throw new TypeError('Tick abort binding must produce fresh signals');
        let cancelJobTimer: (() => void) | undefined;
        let onAbort: () => void = () => {};
        const aborted = new Promise<{ kind: 'aborted' }>((resolveAbort) => {
          onAbort = () => { cancelled = true; jobController.abort(); resolveAbort({ kind: 'aborted' }); };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        try {
          cancelJobTimer = setTimer(() => stop('expired'), lease.deadlineMs - ready);
          if (typeof cancelJobTimer !== 'function') throw new TypeError('Invalid Tick timer binding');
          // Timer/telemetry bindings may have run caller code; check again immediately before dispatch.
          if (check() === null || !coordinator.isUsable(lease)) {
            stop('expired');
            results.push(Object.freeze({ jobId: job.id, status: 'not-run', coordination: 'expired' }));
            break;
          }
          const context: ExecutionContext = Object.freeze({ run: lease.record.run, attempt: lease.record.attempt,
            attemptToken: lease.record.attemptToken, deadlineMs: Math.min(lease.deadlineMs, budget.cutoff), signal: jobController.signal,
            ...(jobController.nativeSignal ? { transportSignal: jobController.nativeSignal } : {}) });
          // Attach rejection handling before racing. Late resolution/rejection never settles storage.
          const execution = Promise.resolve().then(async () => {
            if (check() === null || !coordinator.isUsable(lease)) return { kind: 'aborted' as const };
            dispatched = true;
            await job.execute(context, resources);
            return { kind: 'completed' as const };
          }).catch((error: unknown) => ({ kind: 'failed' as const, error }));
          const outcome = await Promise.race([execution, aborted]);
          jobController.abort();
          const finished = check();
          if (cancelled || outcome.kind === 'aborted' || finished === null || !coordinator.isUsable(lease)) {
            if (!stopped) stop('expired');
            results.push(dispatched
              ? Object.freeze({ jobId: job.id, status: 'executed', run: context.run, attempt: context.attempt,
                  outcome: stopped === 'cancelled' ? 'cancelled' : 'deadline-exceeded', coordination: 'expired' })
              : Object.freeze({ jobId: job.id, status: 'not-run', coordination: 'expired' }));
            break;
          }
          let disposition: 'completed' | 'retry' | 'failed' = 'completed';
          let failureCode: string | undefined;
          if (outcome.kind === 'failed') {
            ({ disposition, failureCode } = classifyFailure(outcome.error));
          }
          const settlement = disposition === 'retry'
            ? { kind: 'retry' as const, failureCode: failureCode! } : { kind: disposition };
          const settled = await resolve(coordinator, job.id, await coordinator.settle(lease, settlement), check);
          results.push(Object.freeze({ jobId: job.id, status: 'executed', run: context.run, attempt: context.attempt,
            outcome: disposition, coordination: settled.status, ...(failureCode ? { failureCode } : {}),
            ...(settled.status === 'settled' ? { record: settled.record, settlementDeadlineExceeded: settled.deadlineExceeded } : {}) }));
        } finally {
          cancelJobTimer?.();
          signal.removeEventListener('abort', onAbort);
          jobController.abort();
        }
      }
      check();
      return Object.freeze({ status: stopped ?? 'finished', visited: results.length,
        nextJobIndex: jobs.length ? (startAt + results.length) % jobs.length : 0,
        results: Object.freeze(results) });
    } finally {
      cancelInvocationTimer?.();
      parent.removeEventListener('abort', onCancel);
      // Revoke signals retained by application code after the invocation finishes.
      controller.abort();
    }
  } });
}
