import type {
  Clock, CoordinationBinding, CoordinationRecord, ExecutionLimits, FailedRecord, IdSource,
  IntervalSchedule, LeasedRecord, MutationId, RunId, StoreRevision, TickInvocation, WritePrecondition,
} from './index.js';
import { isCoordinationRecord } from './internal/records.js';
import { captureClock, captureCoordination, captureIds } from './internal/bindings.js';

export type CoordinatorLimits = Pick<ExecutionLimits,
  'maxAttemptsPerRun' | 'leaseMs' | 'runTimeoutMs' | 'retryDelayMs' | 'maxClockSkewMs' | 'deadlineSafetyMs'>;

export interface CoordinatorOptions {
  readonly namespace: string;
  readonly job: { readonly id: string; readonly schedule: IntervalSchedule };
  readonly coordination: CoordinationBinding;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly limits: CoordinatorLimits;
}

declare const leaseBrand: unique symbol;
declare const pendingBrand: unique symbol;
/** Invocation-local receipt. Only this coordinator's actual receipts are accepted at runtime. */
export interface OwnershipLease {
  readonly [leaseBrand]: true;
  readonly record: LeasedRecord;
  readonly deadlineMs: number;
}
/** An unknown write result, not execution authority. Not serializable recovery state. */
export interface PendingTransition {
  readonly [pendingBrand]: true;
  readonly mutationId: MutationId;
}

export type Settlement = { readonly kind: 'completed' } | { readonly kind: 'retry'; readonly failureCode: string }
  | { readonly kind: 'failed' };

export type CoordinationResult =
  | { readonly status: 'owned'; readonly lease: OwnershipLease; readonly missedWindows: number }
  | { readonly status: 'settled'; readonly record: Exclude<CoordinationRecord, LeasedRecord>; readonly deadlineExceeded: boolean }
  | { readonly status: 'skipped'; readonly reason: 'before-anchor' | 'already-recorded' | 'leased' | 'retry-delay' }
  | { readonly status: 'conflict' | 'unavailable' | 'configuration-mismatch' | 'stale' }
  | { readonly status: 'expired'; readonly applied?: true }
  | { readonly status: 'indeterminate' | 'unresolved'; readonly pending: PendingTransition };

export interface JobCoordinator {
  readonly key: string;
  claim(invocation: TickInvocation): Promise<CoordinationResult>;
  renew(lease: OwnershipLease): Promise<CoordinationResult>;
  settle(lease: OwnershipLease, outcome: Settlement): Promise<CoordinationResult>;
  reconcile(pending: PendingTransition): Promise<CoordinationResult>;
  /** Rechecks the original invocation/lease budget; does not read storage or certify effects. */
  isUsable(lease: OwnershipLease): boolean;
}

const identifier = /^[A-Za-z0-9._-]{1,80}$/;
const token = /^[A-Za-z0-9._:-]{1,128}$/;
const nonnegative = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const positive = (n: unknown): n is number => nonnegative(n) && n > 0;
const matches = (s: unknown, pattern: RegExp): s is string => typeof s === 'string' && pattern.test(s);
const add = (a: number, b: number) => {
  const result = a + b;
  if (!nonnegative(result)) throw new TypeError('Tick timestamp overflow');
  return result;
};
function validateSchedule(schedule: IntervalSchedule): void {
  if (schedule.kind !== 'interval' || schedule.missedWindows !== 'skip' || !nonnegative(schedule.anchorMs)
    || !positive(schedule.everyMs) || !matches(schedule.revision, identifier)) throw new TypeError('Invalid Tick interval');
}

/** Exact integer arithmetic, including timestamps near Number.MAX_SAFE_INTEGER. */
export function latestSlot(schedule: IntervalSchedule, nowMs: number): number | null {
  validateSchedule(schedule);
  if (!nonnegative(nowMs)) throw new TypeError('Invalid Tick timestamp');
  if (nowMs < schedule.anchorMs) return null;
  return Number(BigInt(schedule.anchorMs) + ((BigInt(nowMs) - BigInt(schedule.anchorMs)) / BigInt(schedule.everyMs)) * BigInt(schedule.everyMs));
}

function retained<T extends CoordinationRecord>(record: T): T {
  Object.freeze(record.run);
  return Object.freeze(record);
}
const sameRecord = (a: CoordinationRecord, b: CoordinationRecord) => {
  const keys = Object.keys(a) as (keyof CoordinationRecord)[];
  return keys.length === Object.keys(b).length && keys.every((key) => key === 'run'
    ? a.run.id === b.run.id // Both canonical identities and their component fields are validated.
    : a[key] === b[key]);
};

interface Budget { sample(): number | null; readonly deadlineMs: number }
interface Receipt { record: LeasedRecord; budget: Budget; valid: boolean; busy: boolean }
interface Pending { record: CoordinationRecord; budget: Budget; missedWindows: number; valid: boolean; busy: boolean; previous?: LeasedRecord }
type Observation = { status: 'snapshot'; value: CoordinationRecord | null; revision: StoreRevision | null; now: number }
  | { status: 'expired' | 'unavailable' | 'configuration-mismatch' };

/** Experimental storage coordinator. It never calls job.execute or starts background work. */
export function createJobCoordinator(options: CoordinatorOptions): JobCoordinator {
  // Copy configuration and callable bindings once; mutation during an await cannot change a plan.
  const namespace = options.namespace;
  const jobId = options.job.id;
  const schedule = Object.freeze({ ...options.job.schedule });
  const limits = Object.freeze({ ...options.limits });
  const coordination = captureCoordination(options.coordination);
  const clock = captureClock(options.clock), ids = captureIds(options.ids);
  const prefix = coordination.prefix;
  if (!matches(namespace, identifier) || !matches(jobId, identifier)) throw new TypeError('Invalid Tick coordinator identity');
  validateSchedule(schedule);
  if (![limits.maxAttemptsPerRun, limits.leaseMs, limits.runTimeoutMs, limits.deadlineSafetyMs].every(positive)
    || !nonnegative(limits.retryDelayMs) || !nonnegative(limits.maxClockSkewMs)) throw new TypeError('Invalid Tick limits');
  const margin = add(limits.maxClockSkewMs, limits.deadlineSafetyMs);
  if (limits.leaseMs <= margin || limits.runTimeoutMs <= margin) throw new TypeError('Tick limits leave no usable time');
  const key = prefix + JSON.stringify(['tick.job.v1', namespace, jobId]);
  const read = coordination.store.read, cas = coordination.store.compareAndSwap;
  const wall = clock.nowMs, monotonic = clock.monotonicMs;
  const mutationId = ids.newMutationId, attemptToken = ids.newAttemptToken;
  const leases = new WeakMap<OwnershipLease, Receipt>();
  const pending = new WeakMap<PendingTransition, Pending>();

  function budget(invocation: TickInvocation): Budget {
    const deadlineMs = invocation.deadlineMs;
    const signal = invocation.signal;
    if (!positive(deadlineMs) || typeof invocation.requestId !== 'string' || !invocation.requestId
      || !signal || typeof signal.aborted !== 'boolean') throw new TypeError('Invalid Tick invocation');
    let invalid = false, startWall = 0, startMono = 0, lastWall = 0, lastMono = 0;
    try { startWall = lastWall = wall(); startMono = lastMono = monotonic(); } catch { invalid = true; }
    if (!nonnegative(startWall) || !Number.isFinite(startMono) || startMono < 0 || startMono > Number.MAX_SAFE_INTEGER) invalid = true;
    return { deadlineMs, sample() {
      if (invalid) return null;
      try {
        const now = wall(), mono = monotonic();
        if (signal.aborted || !nonnegative(now) || now < lastWall || !Number.isFinite(mono)
          || mono < lastMono || mono > Number.MAX_SAFE_INTEGER) { invalid = true; return null; }
        lastWall = now; lastMono = mono;
        const effective = Math.max(now, startWall + Math.ceil(mono - startMono));
        if (!nonnegative(effective) || effective >= deadlineMs - margin) { invalid = true; return null; }
        return effective;
      } catch { invalid = true; return null; }
    } };
  }
  const cutoff = (record: LeasedRecord, context: Budget) => Math.min(context.deadlineMs, record.leaseExpiresAtMs, record.runDeadlineMs) - margin;
  const usable = (record: LeasedRecord, context: Budget, now: number | null) => now !== null && now < cutoff(record, context);
  // Clamp before adding so a large lease setting cannot overflow a smaller valid run horizon.
  const expiry = (now: number, deadline: number) => now + Math.min(limits.leaseMs, deadline - now);
  const afterSkew = (now: number, time: number) => BigInt(now) >= BigInt(time) + BigInt(limits.maxClockSkewMs);
  function freshMutation(previous?: MutationId): MutationId {
    const id = mutationId();
    if (!matches(id, token) || id === previous) throw new TypeError('Invalid Tick mutation ID source');
    return id;
  }
  function freshAttempt(previous?: string) {
    const id = attemptToken();
    if (!matches(id, token) || id === previous) throw new TypeError('Invalid Tick attempt ID source');
    return id;
  }
  function consistent(record: CoordinationRecord): boolean {
    const run = record.run;
    const stateTime = record.state === 'leased' ? record.leaseExpiresAtMs
      : record.state === 'retryable' ? record.nextAttemptAtMs
      : record.state === 'completed' ? record.completedAtMs : record.failedAtMs;
    return run.namespace === namespace && run.jobId === jobId && run.scheduleRevision === schedule.revision
      && run.scheduledForMs >= schedule.anchorMs
      && (BigInt(run.scheduledForMs) - BigInt(schedule.anchorMs)) % BigInt(schedule.everyMs) === 0n
      && record.runDeadlineMs > run.scheduledForMs && stateTime >= run.scheduledForMs
      && (record.state !== 'leased' || (record.leaseExpiresAtMs > run.scheduledForMs && record.leaseExpiresAtMs <= record.runDeadlineMs));
  }
  async function observe(context: Budget): Promise<Observation> {
    if (context.sample() === null) return { status: 'expired' };
    let result;
    try { result = await read(key); } catch { return context.sample() === null ? { status: 'expired' } : { status: 'unavailable' }; }
    const now = context.sample();
    if (now === null) return { status: 'expired' };
    try {
      if (result.status === 'absent') return { status: 'snapshot', value: null, revision: null, now };
      if (result.status !== 'found') return { status: 'unavailable' };
      const revision = result.revision, value = result.value;
      if (typeof revision !== 'string' || !revision || revision.length > 1024) return { status: 'configuration-mismatch' };
      if (!isCoordinationRecord(value)) return { status: 'configuration-mismatch' };
      const copy: unknown = JSON.parse(JSON.stringify(value));
      if (!isCoordinationRecord(copy) || !consistent(copy)) return { status: 'configuration-mismatch' };
      return { status: 'snapshot', value: retained(copy), revision, now };
    } catch { return { status: 'configuration-mismatch' }; }
  }
  function receipt(record: LeasedRecord, context: Budget): OwnershipLease {
    const lease = Object.freeze({ record, deadlineMs: cutoff(record, context) }) as OwnershipLease;
    leases.set(lease, { record, budget: context, valid: true, busy: false });
    return lease;
  }
  function uncertain(record: CoordinationRecord, context: Budget, missedWindows: number, previous?: LeasedRecord): PendingTransition {
    const handle = Object.freeze({ mutationId: record.mutationId }) as PendingTransition;
    pending.set(handle, { record, budget: context, missedWindows, valid: true, busy: false,
      ...(previous && record.state === 'leased' ? { previous } : {}) });
    return handle;
  }
  async function commit(record: CoordinationRecord, expected: WritePrecondition, context: Budget,
    missedWindows = 0, previous?: LeasedRecord, consume?: () => void): Promise<CoordinationResult> {
    const now = context.sample();
    if (now === null || (previous && !usable(previous, context, now))
      || (record.state === 'leased' && !usable(record, context, now))) return { status: 'expired' };
    retained(record);
    consume?.();
    let status: unknown;
    try { status = (await cas(Object.freeze({ key, expected: Object.freeze(expected), value: record }))).status; }
    catch { status = 'indeterminate'; }
    const finishedAt = context.sample();
    if (status === 'conflict') return { status: 'conflict' };
    if (status !== 'applied') return { status: 'indeterminate', pending: uncertain(record, context, missedWindows, previous) };
    const previousExpired = previous !== undefined && !usable(previous, context, finishedAt);
    if (record.state !== 'leased') return { status: 'settled', record, deadlineExceeded: finishedAt === null || previousExpired };
    if (previousExpired || !usable(record, context, finishedAt)) return { status: 'expired', applied: true };
    return { status: 'owned', lease: receipt(record, context), missedWindows };
  }
  function failed(record: CoordinationRecord, now: number, reason: FailedRecord['reason']): FailedRecord {
    return { contractVersion: 1, run: record.run, attempt: record.attempt, runDeadlineMs: record.runDeadlineMs,
      mutationId: freshMutation(record.mutationId), state: 'failed', failedAtMs: now, reason };
  }
  function acquired(current: CoordinationRecord, now: number): LeasedRecord {
    return { contractVersion: 1, run: current.run, runDeadlineMs: current.runDeadlineMs,
      attempt: add(current.attempt, 1), mutationId: freshMutation(current.mutationId), state: 'leased',
      attemptToken: freshAttempt(current.state === 'leased' ? current.attemptToken : undefined),
      leaseExpiresAtMs: expiry(now, current.runDeadlineMs) };
  }

  async function ownerOperation(lease: OwnershipLease, outcome?: Settlement): Promise<CoordinationResult> {
    const data = leases.get(lease);
    if (!data) throw new TypeError('Unknown Tick ownership receipt');
    if (!data.valid || data.busy) return { status: 'stale' };
    if (!usable(data.record, data.budget, data.budget.sample())) return { status: 'expired' };
    data.busy = true;
    try {
      const observed = await observe(data.budget);
      if (observed.status !== 'snapshot') return observed;
      if (!observed.value || !sameRecord(data.record, observed.value)) { data.valid = false; return { status: 'stale' }; }
      if (!usable(data.record, data.budget, observed.now)) return { status: 'expired' };
      let next: CoordinationRecord;
      const base = { contractVersion: 1 as const, run: data.record.run, attempt: data.record.attempt,
        runDeadlineMs: data.record.runDeadlineMs, mutationId: freshMutation(data.record.mutationId) };
      if (!outcome) next = { ...data.record, ...base, leaseExpiresAtMs: expiry(observed.now, data.record.runDeadlineMs) };
      else if (outcome.kind === 'completed') next = { ...base, state: 'completed', completedAtMs: observed.now };
      else if (outcome.kind === 'failed') next = { ...base, state: 'failed', failedAtMs: observed.now, reason: 'permanent-failure' };
      else if (data.record.attempt >= limits.maxAttemptsPerRun) next = { ...base, state: 'failed', failedAtMs: observed.now, reason: 'attempts-exhausted' };
      else {
        const retryAt = add(observed.now, limits.retryDelayMs);
        next = BigInt(retryAt) + BigInt(limits.maxClockSkewMs) < BigInt(data.record.runDeadlineMs - margin)
          ? { ...base, state: 'retryable', nextAttemptAtMs: retryAt, failureCode: outcome.failureCode }
          : { ...base, state: 'failed', failedAtMs: observed.now, reason: 'deadline-exceeded' };
      }
      return await commit(next, { kind: 'revision', revision: observed.revision! }, data.budget, 0,
        data.record, () => { data.valid = false; });
    } finally { data.busy = false; }
  }

  return Object.freeze({ key,
    async claim(invocation: TickInvocation): Promise<CoordinationResult> {
      const context = budget(invocation);
      const observed = await observe(context);
      if (observed.status !== 'snapshot') return observed;
      const { value: current, now } = observed;
      const expected: WritePrecondition = observed.revision === null ? { kind: 'absent' } : { kind: 'revision', revision: observed.revision };
      if (current && (current.state === 'leased' || current.state === 'retryable')) {
        // An exhausted attempt is still its owner's until conservative expiry.
        if (current.state === 'leased' && !afterSkew(now, current.leaseExpiresAtMs)) return { status: 'skipped', reason: 'leased' };
        if (afterSkew(now, current.runDeadlineMs)) return commit(failed(current, now, 'deadline-exceeded'), expected, context);
        if (current.attempt >= limits.maxAttemptsPerRun) return commit(failed(current, now, 'attempts-exhausted'), expected, context);
        if (current.state === 'retryable' && !afterSkew(now, current.nextAttemptAtMs)) return { status: 'skipped', reason: 'retry-delay' };
        return commit(acquired(current, now), expected, context);
      }
      const slot = latestSlot(schedule, now);
      if (slot === null) return { status: 'skipped', reason: 'before-anchor' };
      if (current && slot <= current.run.scheduledForMs) return { status: 'skipped', reason: 'already-recorded' };
      const run = { id: JSON.stringify(['tick.run.v1', namespace, jobId, schedule.revision, slot]) as RunId,
        namespace, jobId, scheduleRevision: schedule.revision, scheduledForMs: slot };
      const runDeadlineMs = add(now, limits.runTimeoutMs);
      const record: LeasedRecord = { contractVersion: 1, run, runDeadlineMs, attempt: 1,
        state: 'leased', mutationId: freshMutation(current?.mutationId), attemptToken: freshAttempt(),
        leaseExpiresAtMs: expiry(now, runDeadlineMs) };
      const missedWindows = Number((BigInt(slot) - BigInt(current?.run.scheduledForMs ?? schedule.anchorMs)) / BigInt(schedule.everyMs)) - (current ? 1 : 0);
      return commit(record, expected, context, missedWindows);
    },
    renew: (lease: OwnershipLease) => ownerOperation(lease),
    settle(lease: OwnershipLease, outcome: Settlement) {
      // Snapshot before ownerOperation yields to storage I/O.
      const kind = outcome?.kind;
      if (!['completed', 'retry', 'failed'].includes(kind)) throw new TypeError('Invalid Tick settlement');
      if (kind === 'retry') {
        const failureCode = outcome.failureCode;
        if (!matches(failureCode, /^[A-Za-z0-9._:-]{1,80}$/)) throw new TypeError('Invalid Tick failure code');
        return ownerOperation(lease, { kind, failureCode });
      }
      return ownerOperation(lease, { kind });
    },
    async reconcile(handle: PendingTransition): Promise<CoordinationResult> {
      const data = pending.get(handle);
      if (!data) throw new TypeError('Unknown Tick pending receipt');
      if (!data.valid || data.busy) return { status: 'stale' };
      data.busy = true;
      try {
        const observed = await observe(data.budget);
        if (observed.status !== 'snapshot') return observed;
        if (!observed.value || !sameRecord(data.record, observed.value)) return { status: 'unresolved', pending: handle };
        const next = { ...data.record, mutationId: freshMutation(data.record.mutationId) };
        return await commit(next, { kind: 'revision', revision: observed.revision! }, data.budget, data.missedWindows,
          data.previous, () => { data.valid = false; });
      } finally { data.busy = false; }
    },
    isUsable(lease: OwnershipLease) {
      const data = leases.get(lease);
      return !!data && data.valid && !data.busy && usable(data.record, data.budget, data.budget.sample());
    },
  });
}
