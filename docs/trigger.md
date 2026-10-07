# TICK-05 Fastly trigger and admission

`@pulse-compute/tick/adapters/fastly-trigger` exports `createFastlyTrigger(options)`.
It returns an awaited `(request: Request) => Promise<Response>` receiver. The trigger,
coordination, and integration live gates remain **INCONCLUSIVE**. Local tests and the
compiled guest establish behavior against a reference store; they do not certify Fastly KV.

## Explicit bindings

Supply a `TickDefinition`, `ExecutionRuntime`, admission coordination binding, anchored
admission schedule, and admission coordinator limits. Also supply `requestTimeoutMs`
(1–10,000 ms), a server-generated bounded `requestId()`, and an asynchronous `loadToken()`.
Optional metadata reports receiver POP, service ID, and service version; only those fields
are included. The default path is `/__tick/run`.

The [typed example](../examples/trigger.ts) maps logical job and admission dependencies.
Both may use the same physical KV store, but **their prefixes must differ**. Resources
remain application-owned: admission does not change how a job maps observations to S3,
calls an HTTP service, or implements effect deduplication. Provider credentials live in
adapter/secret-loader closures, never in definitions or returned observations.

## Admission before job storage

The receiver uses the existing per-job coordinator for a synthetic job named
`trigger-admission` in the definition's namespace. Its retained key is:

```ts
admissionPrefix + JSON.stringify(['tick.job.v1', namespace, 'trigger-admission'])
```

This reuses the core's absence/revision CAS, fixed run horizon, attempt limits, skew
allowance, terminal highwater, and uncertain-write reconciliation. It adds no multi-key
transaction or new adapter record format. Never expire, delete, or reset this record.

Only a known, usable admission lease starts a job scan. A skipped or conflicting probe
touches admission storage only. An indeterminate claim permits one positive conditional
revalidation; repeated uncertainty grants no scan. Each visited job must still obtain
its **own** positive claim. Admission alone grants no authority for application effects.

For admission slot index `k = (scheduledForMs - anchorMs) / everyMs`, the scan starts at
`(k * maxJobsPerTick) % jobs.length`, using exact integer arithmetic. A recovery attempts
the same slice; per-job retained records suppress already confirmed completion. Skipped
admission intervals are not replayed, and job eligibility still uses each job's current
anchored interval. Choose cadence, list order, and visit cap together: a larger list can
take several admitted intervals to visit, and missed triggers or repeated crashes can
delay jobs. There is no durable fairness guarantee or automatic schedule migration.

After a finished bounded scan, the receiver settles admission as completed. This means
the sweep finished, not that every job succeeded or its settlement was acknowledged.
A cancelled/expired scan leaves admission leased for conservative recovery. Recovery
starts after expiry plus skew, retains the gate run/horizon, and increments attempt.
An exhausted gate is terminalized before a later occurrence can proceed. Cooperative
cancellation cannot prevent an old application operation physically overlapping recovery.

## Request and storage bounds

The receiver accepts only GET on its exact path, without query parameters or a body.
`x-tick-probe-token` must match a dedicated 32–256 character base64url secret. Malformed
tokens reject before loading the secret; failed authentication performs no storage I/O.
Responses disable both ordinary and surrogate caching. Errors contain no exception or
upstream payload. The fixed-width comparison is not a cryptographic constant-time claim.

The request budget starts before secret loading and covers admission and execution.
Runner time is capped by the invocation, admission lease, and fixed admission horizon,
with a settlement reserve. Clock regression fails closed. In-flight coordination writes
are awaited; host/backend timeouts must bound network latency. A configured timeout
cannot preempt synchronous code or retract a write already sent.

Admission claim and settlement each allow one reconciliation: at most eight store calls
per request. The runner allows at most eight store calls per visited job, including
uncertain outcomes. Ordinary admission losers need one read, or a read plus conflicting
CAS. With `R` incoming requests and one winning sweep visiting `V` jobs, storage work is
bounded by `8R + 8V`; crash recovery or later admission slots add their own bounded sweeps.
There are no contention loops or automatic renewals. Admission still receives **all R
HTTP requests** and still performs per-request authentication and gate I/O.

`tick.trigger.observation.v1` reports independent per-request admission/job read and write
counts, visits, dispatches, admission outcome, and sanitized `TickResult`. Counters measure
adapter method calls, not provider billing, retries hidden inside application transports,
or application-resource requests. Use transports with no hidden retries. Observations are
not ownership receipts. The local 100-request/16-job comparison measured 3,167 ungated
store calls versus 266 admitted calls (91.6% reduction); see the
[new evidence](../proof/trigger/evidence/STATUS.md). Actual latency, quotas, and costs need
deployed measurement.

## Fastly host and evidence

SDK 3.45.0 supplies timers but no native `AbortController` or fetch cancellation signal.
The guest uses `createCooperativeController()` from `@pulse-compute/tick/cancellation`.
`context.signal` supports abort notification; it cannot be passed as a native fetch signal.
`context.transportSignal` is present only when a host explicitly supplies native support.
See [execution bindings](execution.md) for both recipes. Fastly backend timeouts bound I/O;
the guest does not pretend its cooperative controller cancels HTTP requests.

The [integration proof runbook](../proof/trigger/README.md) builds an actual Wasm receiver,
exercises local duplicate/crash/lost-reply/timeout cases, and captures bounded deployed
burst observations. Configure native probe delivery separately using the
[TICK-01 runbook](../proof/README.md). No timer here creates a background scheduler or
establishes probe continuity while a source service is idle.
