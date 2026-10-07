/** Draft contract version. TICK-00 exports no scheduler implementation or provider adapter. */
export const TICK_CONTRACT_VERSION = 1 as const;

declare const revisionBrand: unique symbol;
declare const runIdBrand: unique symbol;
declare const attemptBrand: unique symbol;
declare const mutationBrand: unique symbol;

/** Equality-only precondition paired with an exact stored value; never convert to Number. */
export type StoreRevision = string & { readonly [revisionBrand]: true };
/** Deterministic logical occurrence identity; stable across attempts. */
export type RunId = string & { readonly [runIdBrand]: true };
/** Unique to one ownership acquisition. Not an ordered downstream fencing token. */
export type AttemptToken = string & { readonly [attemptBrand]: true };
/** Fresh for every proposed state change; retained when reconciling an ambiguous write. */
export type MutationId = string & { readonly [mutationBrand]: true };

export interface RunIdentity {
  readonly id: RunId;
  readonly namespace: string;
  readonly jobId: string;
  readonly scheduleRevision: string;
  readonly scheduledForMs: number;
}

interface RecordBase {
  readonly contractVersion: typeof TICK_CONTRACT_VERSION;
  readonly mutationId: MutationId;
  readonly run: RunIdentity;
  /** Starts at 1; increments only when acquiring an execution attempt. */
  readonly attempt: number;
  /** Fixed at first claim. Renewal and takeover cannot extend this horizon. */
  readonly runDeadlineMs: number;
}

export interface LeasedRecord extends RecordBase {
  readonly state: 'leased';
  readonly attemptToken: AttemptToken;
  readonly leaseExpiresAtMs: number;
}

export interface RetryableRecord extends RecordBase {
  readonly state: 'retryable';
  readonly nextAttemptAtMs: number;
  /** Bounded, non-secret application/runner code; no exception or response payload. */
  readonly failureCode: string;
}

export interface CompletedRecord extends RecordBase {
  readonly state: 'completed';
  readonly completedAtMs: number;
}

export interface FailedRecord extends RecordBase {
  readonly state: 'failed';
  readonly failedAtMs: number;
  readonly reason: 'attempts-exhausted' | 'deadline-exceeded' | 'permanent-failure';
}

/** One retained latest record per namespace/job, not one independently claimed key per slot. */
export type CoordinationRecord = LeasedRecord | RetryableRecord | CompletedRecord | FailedRecord;

export type ReadResult =
  | { readonly status: 'found'; readonly value: CoordinationRecord; readonly revision: StoreRevision }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable' };

/** Missing and expected-revision are distinct; neither is an unconditional overwrite. */
export type WritePrecondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'revision'; readonly revision: StoreRevision };

export interface ConditionalWrite {
  readonly key: string;
  readonly expected: WritePrecondition;
  readonly value: CoordinationRecord;
}

export type WriteResult =
  | { readonly status: 'applied' }
  | { readonly status: 'conflict' }
  | { readonly status: 'indeterminate' };

/**
 * Normative semantics live in docs/architecture.md. Capability literals are declarations,
 * not certification. Each deployed adapter must pass its own concurrency proof.
 */
export interface CoordinationStore {
  readonly capabilities: {
    readonly atomicCreate: true;
    readonly atomicReplace: true;
    readonly scope: 'global-per-key';
    readonly coherentValueRevision: true;
    readonly reads: 'possibly-stale';
  };
  read(key: string): Promise<ReadResult>;
  /** Never emulate this operation with unconditional get/put. No clock predicate is implied. */
  compareAndSwap(write: ConditionalWrite): Promise<WriteResult>;
}

export interface CoordinationBinding {
  /** Human-readable logical resource alias; credentials/host handles belong to the adapter. */
  readonly name: string;
  /** Core-owned literal key prefix; adapter must not silently add it a second time. */
  readonly prefix: string;
  readonly store: CoordinationStore;
}

export interface Clock {
  /** Unix epoch milliseconds, used for slot and lease eligibility. */
  nowMs(): number;
  /** Monotonic milliseconds, used for elapsed duration/invocation budget checks. */
  monotonicMs(): number;
}

export interface IdSource {
  /** Unique across processes, restarts, jobs, and attempts within the record retention lifetime. */
  newAttemptToken(): AttemptToken;
  /** Never reuse for a distinct proposed transition. */
  newMutationId(): MutationId;
}

export interface IntervalSchedule {
  readonly kind: 'interval';
  /** Explicit shared origin; do not derive it from worker startup time. */
  readonly anchorMs: number;
  readonly everyMs: number;
  /** Immutable identifier for these schedule semantics; mismatch fails closed. */
  readonly revision: string;
  readonly missedWindows: 'skip';
}

export interface ExecutionContext {
  readonly run: RunIdentity;
  readonly attempt: number;
  readonly attemptToken: AttemptToken;
  /** Conservative local budget, no later than invocation/run/lease bounds minus margins. */
  readonly deadlineMs: number;
  /** Cooperative cancellation cannot undo a dispatched HTTP request or side effect. */
  readonly signal: AbortSignal;
}

export interface JobDefinition<Resources> {
  readonly id: string;
  readonly schedule: IntervalSchedule;
  /** Application effects must use run.id for deduplication and enforce their own commit rules. */
  readonly execute: (context: ExecutionContext, resources: Resources) => Promise<void>;
}

export interface ExecutionLimits {
  /** Bound visits, including skipped/contended jobs, not just successful claims. */
  readonly maxJobsPerTick: number;
  readonly maxAttemptsPerRun: number;
  readonly leaseMs: number;
  readonly runTimeoutMs: number;
  readonly retryDelayMs: number;
  /** Assumed maximum pairwise wall-clock difference; configuration is not proof of the bound. */
  readonly maxClockSkewMs: number;
  readonly deadlineSafetyMs: number;
}

export type TickEvent =
  | { readonly kind: 'missed-windows'; readonly jobId: string; readonly count: number; readonly beforeMs: number }
  | { readonly kind: 'run-state'; readonly run: RunIdentity; readonly attempt: number; readonly state: CoordinationRecord['state'] }
  | { readonly kind: 'coordination'; readonly jobId: string; readonly outcome: 'conflict' | 'indeterminate' | 'unavailable' | 'configuration-mismatch' };

export interface Telemetry {
  /** Observational; delivery failure cannot grant ownership, dispatch work, or alter stored state. */
  emit(event: TickEvent): void;
}

export interface TickDefinition<Resources> {
  readonly contractVersion: typeof TICK_CONTRACT_VERSION;
  readonly namespace: string;
  readonly bindings: {
    readonly coordination: CoordinationBinding;
    readonly clock: Clock;
    readonly ids: IdSource;
    readonly resources: Resources;
    readonly telemetry?: Telemetry;
  };
  readonly limits: ExecutionLimits;
  readonly jobs: readonly JobDefinition<Resources>[];
}

/** Per-invocation input; the experimental runner is exported from the /runner subpath. */
export interface TickInvocation {
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
