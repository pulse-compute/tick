# TICK-00 architecture and contract

Tick turns duplicated, unreliable triggers into bounded attempts at interval work.
This document defines the draft contract exported by `src/index.ts`. TICK-00 supplies
types and package scaffolding only: no runner, provider adapter, or ownership proof.
`examples/bindings.ts` demonstrates typed dependency wiring, not runnable scheduling.
TICK-02 adds a separate [HTTP KV adapter candidate](fastly-kv.md); its deployed gate
remains pending, and it does not implement the ownership transitions described here.

## Boundaries and bindings

- The trigger adapter authenticates incoming signals; a signal is not ownership.
- The future core calculates eligible intervals and conditionally changes job records.
- The coordination adapter provides atomic operations on one key, without a clock predicate.
- The executor owns application behavior, effect deduplication, and downstream commit rules.
- Pulse is an optional consumer. Tick has no Pulse runtime or package dependency.

`TickDefinition.bindings.coordination` maps a logical `name`, a literal `prefix`, and
an injected `CoordinationStore`. A future provider factory resolves a store name or
bucket and host credentials. The core applies the prefix once; the adapter must not
silently apply it again. Arbitrary application dependencies live in typed `resources`:
coordination can use KV while observations use S3. Clock, IDs, and telemetry are injected.

## Identity and retained state

The core's exact key encoding is `prefix + JSON.stringify(['tick.job.v1', namespace, jobId])`.
The canonical run ID is `JSON.stringify(['tick.run.v1', namespace, jobId, scheduleRevision,
scheduledForMs])`. Array element order and the numeric timestamp are significant. No
delimiter joining, normalization, hashing, or provider-specific rewriting is implied.

There is one retained latest record per namespace/job. Records include the format version,
logical run, execution attempt, fixed run deadline, and unique mutation ID. States are
`leased`, `retryable`, `completed`, and `failed`. The latest run timestamp is the retained
highwater mark; terminal records prevent old occurrences being claimed again.

| Identity | Meaning |
| --- | --- |
| Run ID | One scheduled occurrence, stable across retries. |
| Attempt token | Unique to one ownership acquisition, including takeover. |
| Mutation ID | Unique to one proposed state transition; retained during its reconciliation. |
| Store revision | Opaque equality-only precondition paired with the exact stored value. |

Attempt tokens and revisions are not ordered fencing tokens. Never parse a revision as
a number. Fresh mutation content on every distinct transition prevents the protocol from
intentionally cycling back to identical serialized values. Adapters must preserve it.

Never delete, expire, or reset retained records in this contract. Such changes could permit
replay or recreate old preconditions. Record garbage collection, schedule migration, and
namespace migration require a later design. Stored contract/schedule revision mismatches
fail closed; restarting a worker must not silently reset the schedule.

## Coordination operations

`read()` returns `found` with a coherent value/revision pair, `absent`, or `unavailable`.
Reads may be stale. A read showing absence or expiry never authorizes work by itself.

`compareAndSwap()` accepts either an absence precondition or an exact revision. The
adapter must enforce creation/replacement atomically across all writers to that key.
It must never emulate this with unconditional `get` followed by `put`.

| Result | Meaning |
| --- | --- |
| `applied` | The conditional write is positively known to have succeeded. |
| `conflict` | The precondition was definitively rejected; this write did not apply. |
| `indeterminate` | Application is unknown, including a lost response after possible commit. |

An applied write need not return a revision. Read the coherent stored pair before the
next CAS, validate that its state/run/token still permit the intended transition, then
use its revision. Never obtain a successor's revision and overwrite its state with a
former owner's locally cached state. Stale preconditions must conflict atomically.

An indeterminate result never authorizes execution. Reconcile the exact mutation and
attempt identity; a stale read of one's own claim is insufficient evidence of current
ownership. Require a successful conditional revalidation before dispatch, with usable
time remaining. Repeated uncertainty consumes the invocation budget and must stop.
Transport exceptions likewise must not become success or ordinary contention.

Capability literals describe requirements, not certification. Fastly KV and S3 remain
candidate mappings until their deployed proofs pass. Do not infer global atomicity from
local mocks, a provider's method name, or the presence of a generation/ETag field.

## Intervals and missed work

Intervals use an explicit shared anchor: the latest eligible timestamp is
`anchorMs + floor((nowMs - anchorMs) / everyMs) * everyMs`, only when `nowMs >= anchorMs`.
For an unseen job, consider only that latest timestamp. For a terminal stored run,
consider only a strictly newer timestamp. Earlier unclaimed windows are skipped; they
are never reconstructed as historical observations or drained as a catch-up backlog.

While an older run is `leased` or `retryable`, decline newer occurrences. Recover or
terminalize the older run before advancing the record. Once resolved, the current
latest slot can still run; intermediate slots already past are missed. Declining a
trigger during a slot does not permanently reject that slot. This rule needs no
second watermark and keeps only one logically active occurrence per job.

Retries retain the run ID and fixed run deadline, increment attempt on acquisition,
and receive a new attempt token. Delay retries by `retryDelayMs`; never exceed
`maxAttemptsPerRun` or extend `runDeadlineMs` on renewal/takeover. Terminal failure
uses `attempts-exhausted`, `deadline-exceeded`, or `permanent-failure` as appropriate.
The future executor must define how application errors select retryable/permanent
outcomes; TICK-00 does not pretend that behavior already exists.

## Time, leases, and execution

Wall time is epoch milliseconds. Monotonic time measures elapsed invocation budget.
`maxClockSkewMs` is an assumed maximum pairwise wall-clock difference, not a measured
guarantee. The deployment must establish that assumption and handle clock instability.
The runner must stop starting work conservatively before lease expiry, subtracting skew
and safety margins, and allow takeover conservatively after expiry plus the skew margin.
If these margins leave no usable time, it must not dispatch.

Execution deadline cannot exceed invocation, lease, or fixed run bounds after margins.
Recheck budgets after coordination I/O and immediately before dispatch. Neither a CAS
nor a read atomically compares store time with lease expiry. A delayed state write may
succeed after nominal expiry if its revision remains current; a successor's revision
must reject it. Never describe CAS as server-clock fencing.

Only a positively established claim with remaining time can dispatch. Cancellation is
cooperative; it cannot retract a previously sent request. An expired worker and its
successor can physically overlap. A lease alone cannot guarantee one execution or one
external effect. Applications must use run identity and their own atomic/idempotent
effect protocol where required. A prior ownership check is not an atomic downstream
commit guard. Tick makes no exactly-once execution/delivery promise.

`maxJobsPerTick` bounds all visited jobs, including misses and contention. The future
runner must also bound coordination/reconciliation attempts within the invocation.
Per-job CAS does not prevent a POP storm from generating storage traffic; admission
before job scanning and its measured amplification belong to TICK-05.

## Validation and evidence

Before I/O, the future runtime must validate:

- Namespace, job IDs, and schedule revisions match `[A-Za-z0-9._-]{1,80}`; job IDs are unique.
- Coordination prefixes match `[A-Za-z0-9/_-]{0,128}`; final keys satisfy provider constraints.
- All time/count values and calculated timestamps are safe integers; count limits,
  intervals, leases, run timeouts, and safety margins are positive.
- Anchors, retry delays, and clock-skew allowances are nonnegative; lease duration exceeds
  skew plus safety margin, and a dispatch has usable time after all deadline bounds.

Unsupported capabilities or stored configuration mismatch must fail explicitly. Types
and type assertions do not perform any of these runtime validations.

Telemetry is observational. Exceptions/delivery failure must not grant ownership or
change stored state. Missed-window reports describe gaps inferred from available
records and observed triggers; they are not a durable audit log or proof of delivery.
No trigger continuity means no guaranteed scheduling continuity.

The live trigger and coordination gates in [roadmap.md](roadmap.md) precede scheduler
implementation. Local tests establish local behavior only; production guarantees remain
conditional on the selected provider's measured semantics and the time assumptions above.
