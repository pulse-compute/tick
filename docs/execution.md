# TICK-04 bounded execution

`@pulse-compute/tick/runner` exports `createRunner(definition, runtime)` and `JobFailure`.
The runner executes a bounded sequential slice of a `TickDefinition` when its caller
invokes `tick(invocation, { startAt })`. It is experimental while the TICK-01/02 live
gates remain pending. TICK-05 adds experimental [Fastly trigger admission](trigger.md).

## Host and application bindings

The existing definition binds coordination, clock, IDs, resources, limits, and jobs.
The runner additionally requires an explicit `ExecutionRuntime` for cancellation and
one-shot timers. The package imports no Node APIs, provider SDKs, or host globals.
For a host that supports the standard cancellation and timer APIs:

```ts
import { createRunner, JobFailure } from '@pulse-compute/tick/runner';
import type { ExecutionRuntime } from '@pulse-compute/tick/runner';

const runtime: ExecutionRuntime = {
  createCancellationController() {
    const controller = new AbortController();
    return { signal: controller.signal, nativeSignal: controller.signal,
      abort: () => controller.abort() };
  },
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
const runner = createRunner(definition, runtime);
const result = await runner.tick(invocation);
// When definitions exceed maxJobsPerTick, the caller can pass result.nextJobIndex
// as startAt on its next invocation.
```

The runtime must produce a fresh working signal/controller on each call, schedule timer
callbacks asynchronously on the same elapsed-time basis as the clock, support the
configured duration range, and return idempotent timer cancellation functions. The
standard host snippet uses native transport cancellation. For Fastly SDK 3.45.0, which
has timers but no native AbortController/fetch signal, use:

```ts
import { createCooperativeController } from '@pulse-compute/tick/cancellation';
const runtime: ExecutionRuntime = {
  createCancellationController: createCooperativeController,
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
```

`CancellationSignal` exposes `aborted` and abort-listener registration/removal. It is a
notification contract, not a native DOM AbortSignal. The cooperative helper cancels once
and contains listener exceptions. It has no `nativeSignal` and cannot cancel host fetch.
TICK-05 renames the private draft runtime factory from `createAbortController` to
`createCancellationController`; callers must update their explicit host binding.

Construction validates contract version, unique job IDs, callable execution/runtime
bindings through [shared TICK-06 checks](bindings.md), schedules, and visit/time limits.
Each captured runtime rejects reused, inactive, or malformed controllers; optional native
signals must be tied to that same controller. No controller or timer is created merely
by constructing a runner. Jobs, schedules, limits, and callable bindings are captured
before I/O. Resources retain their application-owned identity; freezing the definition
does not freeze application resources.

## Bounded visits and transitions

- Each invocation visits at most `maxJobsPerTick` jobs, including misses and contention.
- Each visited job acquires at most one attempt and executes at most once. The runner
  never sleeps for retries, renews leases automatically, or drains old schedule slots.
- Claim and settlement each permit one reconciliation after an indeterminate write.
  Each core operation performs at most one read and one conditional write: at most four
  operations, eight store calls per visited job. There are no contention loops.
- `startAt` and `nextJobIndex` provide caller-controlled scan continuation. They are
  neither retained scheduling state nor a shared fairness guarantee. Concurrent ticks
  still require successful atomic claims; a cursor grants no ownership.

The runner rechecks cancellation and time immediately before application dispatch and
before settlement. An uncertain claim requires positive conditional revalidation before
execution. Repeated uncertainty, a conflicting revision, or an unresolved read grants no
execution authority. An older exhausted/expired run is terminalized on its visit; the
latest eligible occurrence can be claimed on a later invocation.

`TickResult.status` is `finished`, `cancelled`, or `expired`. Per-job results distinguish
`not-run` from `executed`. An executed `outcome` describes the application result;
`coordination` describes storage acknowledgement. Only `settled` includes the established
non-leased `record`. For example, an application retry request can establish a failed
record when attempts or the fixed run horizon are exhausted. `completed` with an
indeterminate settlement does not mean the coordination record is completed.
`settlementDeadlineExceeded` preserves evidence of a known settlement finishing late.
Results contain no thrown exception payload, pending handle, or ownership receipt.

## Application failures and retries

Successful resolution requests completion. A thrown/rejected value defaults to retry
with `job-error`; raw exceptions, HTTP bodies, and credentials are never persisted or
included in results. A job can deliberately choose:

```ts
throw new JobFailure('retry', 'upstream-unavailable');
throw new JobFailure('permanent', 'invalid-target');
```

Codes must match `[A-Za-z0-9._:-]{1,80}` and be non-secret. Retry records retain the
run identity, attempt count, and fixed run deadline. A later trigger may acquire the
next attempt after `retryDelayMs` plus the skew allowance. Attempt limits and usable
deadline constraints can terminalize the retry request. Permanent failures retain the
core's `permanent-failure` reason; their application code appears only in the result.

## Deadlines, cancellation, and recovery

The job receives the canonical run, attempt, attempt token, cooperative cancellation
signal, and conservative epoch deadline. The deadline is the earliest invocation, fixed
run, or current lease bound minus skew and safety margins. The original invocation
monotonic budget spans all visited jobs; it does not restart for each claim. Clock
rollback/regression fails closed. A job must finish and leave time for settlement within
its current lease. The runner performs no heartbeat renewal.

Parent cancellation and deadline timers abort the job signal. A timed-out or cancelled
attempt is left leased for conservative recovery instead of releasing it immediately.
If a job ignores cancellation, the runner stops waiting and stops visiting more jobs.
Its promise remains rejection-handled; late resolution/rejection cannot settle storage.
Each attempt has its own signal, revoked once its application promise finishes or the
invocation stops. Timers and cancellation listeners are removed when the invocation
returns. Synchronous application code that blocks the event loop
cannot be preempted by a JavaScript timer.

The runner awaits in-flight coordination operations, including writes whose outcome may
be unknown. It does not race them and leave detached mutations. Providers/transports
must supply cancellation or host timeouts for bounded I/O latency. A local deadline is
not a server-clock CAS condition and cannot retract a write already sent. Storage work
is bounded by count; timely response also depends on the host and application yielding.

After process loss, a later trigger recovers the retained lease after expiry plus skew.
It uses the same run ID and fixed horizon, increments attempt, and obtains a new token.
Already committed terminal records suppress replay. Missing completion acknowledgement
may cause the same logical run to execute again, even if its application effect succeeded.

## Application effects

Use `context.run.id` as the durable deduplication identity across retries and crashes;
an attempt token identifies one execution, not one logical effect. Applications must
enforce their own atomic conditional/idempotent write or commit protocol at the resource
where effects occur. Merely checking a key and then performing an unconditional write
does not establish deduplication. HTTP effects require a receiver-enforced idempotency
key or another explicit policy. Multi-resource effects require an application protocol.

Pass `context.signal` to operations accepting the cooperative contract and respect
`context.deadlineMs`. Forward `context.transportSignal` to native fetch only when present;
the runtime must bind it to the same attempt's actual native controller. Fastly transports
must use configured backend timeouts instead. No native signal is inferred or fabricated.
These local checks do not atomically authorize a downstream commit. A worker that ignores
cancellation can physically overlap a successor, and cancellation cannot undo sent
requests. Neither lease ownership, an attempt token, telemetry, nor a successful runner
result promises exactly-once execution or external effects.

Telemetry is best-effort and observational. Delivery exceptions are contained. It cannot
authorize work or substitute for the retained record; jobs and provider bindings remain
responsible for their own behavior. Live storage, clocks, trigger continuity, and host
runtime support remain unproven by the deterministic tests.
