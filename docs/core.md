# TICK-03 interval and ownership core

TICK-03 implements an experimental per-job coordinator and deterministic local tests.
The live trigger and coordination gates remain pending in `docs/roadmap.md`; these
functions do not establish Fastly's deployed storage or timing guarantees. There is no
job executor, scheduling loop, trigger handler, or background timer in this core.

## Constructing a coordinator

```ts
import { createJobCoordinator } from '@pulse-compute/tick/core';

const coordinator = createJobCoordinator({
  namespace: 'uptime',
  job: {
    id: 'homepage',
    schedule: {
      kind: 'interval', anchorMs: 0, everyMs: 60_000,
      revision: 'v1', missedWindows: 'skip',
    },
  },
  coordination: { name: 'scheduler-state', prefix: 'uptime/', store },
  clock,
  ids,
  limits: {
    maxAttemptsPerRun: 3, leaseMs: 10_000, runTimeoutMs: 30_000,
    retryDelayMs: 1_000, maxClockSkewMs: 1_000, deadlineSafetyMs: 500,
  },
});

const result = await coordinator.claim({
  requestId: 'request-123',
  deadlineMs: clock.nowMs() + 5_000,
  signal: abortController.signal,
});
```

`store`, `clock`, and `ids` are injected dependencies satisfying the package contracts.
The store must supply global atomic conditional creation and replacement. Capability
declarations are requirements, not proof. The core applies the literal prefix exactly
once; `coordinator.key` exposes the resulting canonical job key for inspection.

Each operation performs at most one read and one conditional write. There are no hidden
contention loops or retries. Construction and invocation validation reject invalid input
before storage I/O. Full provider setup and binding ergonomics remain TICK-06 work.
The pure `latestSlot(schedule, nowMs)` export returns the anchored slot or `null` before
the anchor; it validates safe integer inputs and performs no storage I/O.

## Operations and results

| Operation | Behavior |
| --- | --- |
| `claim(invocation)` | Consider the latest eligible interval, or recover the retained older run. |
| `renew(lease)` | Extend this attempt's lease within its fixed run deadline and original invocation. |
| `settle(lease, outcome)` | Record `completed`, request `retry` with a bounded failure code, or record permanent `failed`. |
| `reconcile(pending)` | Investigate this exact ambiguous transition; an active claim needs successful conditional revalidation. |
| `isUsable(lease)` | Check local receipt validity, cancellation, and remaining time; perform no store read. |

| Result status | Meaning |
| --- | --- |
| `owned` | A positive CAS established the returned lease, with usable local time remaining. |
| `settled` | A non-leased record was established; `deadlineExceeded` reports that the invocation or prior owner's usable time ended while writing. |
| `skipped` | Before anchor, already recorded, another lease active, or retry delay outstanding. |
| `conflict` | The write precondition was definitely rejected. |
| `indeterminate` | A write may have applied; the pending handle grants no execution authority. |
| `unresolved` | Reconciliation could not positively establish the pending transition. |
| `stale` | The receipt or observed state cannot authorize the requested owner operation. |
| `unavailable` | Storage could not supply a usable read. |
| `configuration-mismatch` | Retained state is incompatible with this coordinator. |
| `expired` | Cancellation or time bounds prevent usable ownership; `applied: true` reports a known write that finished too late. |

Lease and pending handles are opaque, frozen, invocation-local receipts. Only actual
handles issued by that coordinator are accepted: casts, serialization, copies, another
coordinator, and a process restart cannot recreate them. Renew, settle, and reconcile
retain the original invocation budget; they do not accept a fresh deadline to extend it.
A handle consumed by a write attempt must not be reused. Use the successor lease or
pending handle returned by that operation. A failed read alone does not consume a lease.
Unknown handles throw `TypeError` in owner/reconciliation operations; `isUsable` returns
false. An unresolved read may itself be stale; it does not prove a write never applied.

## Eligibility, retries, and recovery

The shared anchor determines interval boundaries. The core claims only the latest
eligible slot, keeps one retained record per job, and skips intervening unclaimed slots.
`missedWindows` counts prior slots since the anchor for an unseen job, or intermediate
slots after its retained terminal run; retries report zero. It is an inferred gap, not a
durable delivery ledger. An older leased or retryable run blocks newer slots until resolved.
Terminalizing an expired or exhausted run returns its settled record; a later call can
claim the latest slot. Terminal records are never deleted or given a TTL.

Retry and takeover preserve run identity and the first claim's fixed run deadline. Each
new acquisition increments the attempt and allocates a new token. Renewal does neither.
An ambiguous claim can be reconciled only while its original lease has usable time.
Revalidation preserves its attempt, token, lease expiry, and run deadline, but uses a
fresh mutation ID and a coherent observed revision. A matching stale read cannot grant
ownership by itself. Expired attempts require ordinary claim recovery.

Stored schedule revision mismatches fail closed, even for terminal records. Reusing a
revision while changing its anchor or interval violates the caller's immutable schedule
contract; the retained record cannot detect every such change. Migration is deferred.

## Time and authority limits

Lease expiry is capped by the fixed run deadline. Local execution eligibility ends at
the earliest invocation, lease, or run bound minus clock-skew and safety margins. Reclaim
waits until lease expiry plus the assumed skew allowance. These are local checks, not
atomic server-clock predicates. Time and cancellation are checked around storage I/O.
An in-flight renewal that finishes after the prior lease's usable cutoff returns
`expired` with `applied: true` even if its new stored expiry is later. Reconciliation of
an ambiguous renewal cannot bypass that prior cutoff. A positively applied terminal
settlement can still be reported as `settled` with `deadlineExceeded: true`; it grants
no execution authority. Terminal reconciliation remains bounded by the invocation.

The core retains the initial monotonic invocation budget and uses elapsed monotonic time
to prevent a wall clock from extending it. Observed wall-clock rollback or monotonic
regression fails closed. Monotonic readings may be fractional; stored timestamps are
safe integer milliseconds. The deployment must establish the configured skew bound.

`isUsable` does not certify current stored ownership or authorize a downstream commit.
An expired worker can physically overlap its successor, and cancellation cannot undo
effects already sent. TICK-04 will supply bounded execution; applications still need
run-based deduplication or their own atomic effect protocol. There is no exactly-once
execution or delivery guarantee.
