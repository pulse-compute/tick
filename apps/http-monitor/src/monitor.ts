import { JobFailure } from '@pulse-compute/tick/runner';
import type { Clock, ExecutionContext, RunIdentity, TickDefinition } from '@pulse-compute/tick';

export interface Observation {
  readonly schema: 'tick.http.observation.v1';
  readonly run: RunIdentity;
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly observedAtMs: number;
  readonly durationMs: number;
  readonly outcome: 'up' | 'down' | 'unreachable';
  readonly httpStatus: number | null;
}
export type ObservationRead = { readonly status: 'found'; readonly value: Observation }
  | { readonly status: 'absent' | 'unavailable' };
export interface ObservationStore {
  read(run: RunIdentity, signal?: AbortSignal): Promise<ObservationRead>;
  /** Atomic first observation wins; never overwrite a snapshot from an earlier attempt. */
  putIfAbsent(value: Observation, signal?: AbortSignal): Promise<{ readonly status: 'saved' | 'exists' | 'indeterminate' }>;
}
export interface Probe {
  check(context: ExecutionContext): Promise<{ readonly httpStatus: number | null }>;
}
export interface MonitorResources { readonly probe: Probe; readonly observations: ObservationStore }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const ownKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function validRun(value: unknown): value is RunIdentity {
  if (!value || typeof value !== 'object') return false;
  const run = value as RunIdentity;
  return ownKeys(run, ['id', 'namespace', 'jobId', 'scheduleRevision', 'scheduledForMs'])
    && [run.namespace, run.jobId, run.scheduleRevision].every((s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(s))
    && integer(run.scheduledForMs) && run.id === JSON.stringify(['tick.run.v1', run.namespace, run.jobId, run.scheduleRevision, run.scheduledForMs]);
}
export function validObservation(value: unknown): value is Observation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Observation;
  return ownKeys(v, ['schema', 'run', 'attempt', 'startedAtMs', 'observedAtMs', 'durationMs', 'outcome', 'httpStatus'])
    && v.schema === 'tick.http.observation.v1' && validRun(v.run) && integer(v.attempt) && v.attempt > 0
    && integer(v.startedAtMs) && integer(v.observedAtMs) && v.observedAtMs >= v.startedAtMs && integer(v.durationMs)
    && (v.httpStatus === null ? v.outcome === 'unreachable' : Number.isInteger(v.httpStatus) && v.httpStatus >= 100 && v.httpStatus <= 599
      && v.outcome === (v.httpStatus >= 200 && v.httpStatus < 300 ? 'up' : 'down'));
}

/** Application effect policy, independent of the host, runner and provider SDKs. */
export function createMonitorJob(clock: Clock): TickDefinition<MonitorResources>['jobs'][number]['execute'] {
  let now: () => number, mono: () => number;
  try { now = clock.nowMs.bind(clock); mono = clock.monotonicMs.bind(clock); }
  catch { throw new TypeError('Invalid monitor clock'); }
  return async (context, resources) => {
    // Capture resource callables before awaits; resources themselves remain application-owned.
    const read = resources.observations.read.bind(resources.observations);
    const put = resources.observations.putIfAbsent.bind(resources.observations);
    const check = resources.probe.check.bind(resources.probe);
    let lastWall = 0, lastMono = 0, baseWall: number | undefined, baseMono = 0;
    const usable = () => {
      const wall = now(), elapsed = mono();
      if (!integer(wall) || wall < lastWall || !Number.isFinite(elapsed) || elapsed < lastMono || elapsed > Number.MAX_SAFE_INTEGER) throw new JobFailure('retry', 'monitor-clock');
      if (baseWall === undefined) { baseWall = wall; baseMono = elapsed; }
      const effective = Math.max(wall, baseWall + Math.ceil(elapsed - baseMono));
      if (context.signal.aborted || !integer(effective) || effective >= context.deadlineMs) throw new JobFailure('retry', 'monitor-deadline');
      lastWall = wall; lastMono = elapsed; return wall;
    };
    const matching = (value: unknown) => validObservation(value) && value.run.id === context.run.id;
    usable();
    let prior: ObservationRead;
    try { prior = await read(context.run, context.transportSignal); }
    catch { throw new JobFailure('retry', 'observation-unavailable'); }
    usable();
    if (prior.status === 'found') {
      if (!matching(prior.value)) throw new JobFailure('permanent', 'observation-invalid');
      return; // A previous attempt committed the effect, even if its KV settlement was lost.
    }
    if (prior.status !== 'absent') throw new JobFailure('retry', 'observation-unavailable');
    const startedAtMs = usable(), startMono = lastMono;
    let httpStatus: number | null;
    try { httpStatus = (await check(context)).httpStatus; }
    catch { httpStatus = null; } // Transport failure is a health observation, never an error payload.
    const observedAtMs = usable(), endMono = lastMono;
    if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new JobFailure('permanent', 'probe-invalid');
    const value = Object.freeze({ schema: 'tick.http.observation.v1' as const, run: Object.freeze({ ...context.run }), attempt: context.attempt,
      startedAtMs, observedAtMs, durationMs: Math.ceil(endMono - startMono), httpStatus,
      outcome: httpStatus === null ? 'unreachable' as const : httpStatus >= 200 && httpStatus < 300 ? 'up' as const : 'down' as const });
    if (!validObservation(value)) throw new JobFailure('permanent', 'observation-invalid');
    let result: Awaited<ReturnType<ObservationStore['putIfAbsent']>>;
    try { result = await put(value, context.transportSignal); }
    catch { throw new JobFailure('retry', 'observation-indeterminate'); }
    usable();
    if (result.status === 'saved') return;
    if (result.status !== 'exists') throw new JobFailure('retry', 'observation-indeterminate');
    // A known conditional loser may reuse a valid first winner for this logical run.
    let winner: ObservationRead;
    try { winner = await read(context.run, context.transportSignal); }
    catch { throw new JobFailure('retry', 'observation-unavailable'); }
    usable();
    if (winner.status !== 'found') throw new JobFailure('retry', 'observation-unavailable');
    if (!matching(winner.value)) throw new JobFailure('permanent', 'observation-invalid');
  };
}
