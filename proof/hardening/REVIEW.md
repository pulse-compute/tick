# TICK-09 adversarial audit and independent review handoff

Baseline: merged TICK-08 commit `3e0e27d21fc328010e673c842e45965a78cd49c9`, tree
`fa78ac49f6afb91e3a2f6724e972d0a235349eb9`. Scope: core receipts/transitions, runner,
trigger admission, binding/cancellation capture, KV/S3 wire contracts, conformance,
monitor effects/signing/hosts, evidence boundaries and package workflow.

This is an **implementation-agent audit**, with concrete baseline reproductions and
focused fixes. It is not independent reviewer sign-off. A separate reviewer must assess
the exact final PR tree and record identity, findings and disposition before a supported
release. No separate reviewer or deployed certification is claimed in this pass.

## Findings and disposition

| ID | Severity | Reproduction / effect | Disposition |
| --- | --- | --- | --- |
| R09-01 | High | Four seconds of secret loading with stationary wall time and queued timers left less than one second of the original five-second budget. The old handoff dispatched two 1.1-second jobs and settled both before returning 503. | Preserve the original request epoch through admission/runner; stop after the first late application return, without another job or settlement. |
| R09-02 | Medium | Three 70-ms jobs with 100-ms leases, stationary wall time and queued timers: later coordinators restarted from the raw epoch, producing a negative timer delay despite remaining invocation time. | Construct invocation-local coordinators on the runner's original elapsed timeline; lease expiries now advance 1100, 1170, 1240. |
| R09-03 | High | Inherited `toJSON` returned another valid state/mutation; both adapters acknowledged different bytes from the supplied claim. Provided-store conformance also invoked hooks during assessment. | Shared data-only capture rejects root/run hooks and inherited/missing fields; core/adapters/conformance use the same validated representation. |
| R09-04 | Medium | KV GET followed a redirect ending in 404 and returned absent. A partial 200 could supply a purported coherent record. | Reject redirected/partial responses before classifying status, including 404. |
| R09-05 | Low | A KV unpaired UTF-16 surrogate passed key checks, failed during encoding and became indeterminate although no request was sent. | Reject malformed keys as sanitized TypeError before credentials/transport. |
| R09-06 | Medium | Partial/expiring S3 NoSuchKey envelopes established absence or a definitive missing-revision conflict. | Keep such errors unavailable/indeterminate; ordinary full NoSuchKey and 412 semantics are preserved. |
| R09-07 | Medium | Monitor setup omitted ListBucket needed for a missing-object GET to return 404; fresh runs with object-only credentials could stay unavailable. | Correct setup/operations guidance; retain fail-closed 403 behavior and test no probe on access error/throttle. Exact live policy still needs verification. |

[Regression evidence](evidence/regressions.json) records eight failures on the exact
baseline source tree with the current targeted tests copied into an isolated build,
then the same 87 tests passing on the fixed implementation. This uses pinned local
tools and no live provider networking. Full-suite/guest results are recorded separately
in [the status](evidence/STATUS.md).

## Authority paths checked

- Gate ownership never substitutes for a job claim. Duplicate losers have no job scans;
  count bounds remain finite. Writes/reconciliation are awaited without contention loops.
- Unknown claims do not dispatch; matching stale reads cannot revalidate over a successor.
  Exact CAS/fresh mutation content and local opaque/consumed receipts remain required.
- Run, attempt, mutation and revision remain distinct. Terminal retention suppresses replay;
  retries/takeover preserve fixed horizons. Time checks are local, not server fencing.
- Configuration/callables/conditions are captured before awaits; revisions stay strings.
  Credentials, native signals and resources are explicit. The host is trusted; this is
  not a sandbox against arbitrary global prototype tampering.
- Uncooperative jobs can outlive cancellation; late results cannot settle coordination.
  Native/cooperative cancellation and provider count/time limits stay separate.
- HTTP errors are health data; unavailable observation reads are not. First S3 snapshot
  uses conditional creation, exact run identity and bounded readback.
- Signatures include host/path/payload/session/condition. Host retries/cache/redirects
  must not hide unknown writes. The pinned SDK needs cooperative cancellation/host timeouts.
- Evidence/telemetry grant no ownership or release authority. Private package artifacts
  have zero runtime dependencies and no publication/tag/release step.

## Accepted application-effect limitation

The late-save fixture receives attempt one's signed PUT body, holds its conditional
commit beyond that guest request's deadline, and releases it when attempt two's health
GET reaches the target. Attempt two then receives HTTP 503. The first retained `up`
result wins over the new `down` result; attempt two accepts attempt one's snapshot.

This is expected first-writer policy, **not a defect fixed by a lease**. Two physical
probes and a late provider effect are allowed. The fixture proves local consumer policy;
it does not prove a deployed guest survives response completion or that backend timeouts
retract a provider write. No exactly-once/owner-fenced application guarantee is added.

## Separate reviewer and live handoff

Review final clock layering: rollback, partially spent auth/read budgets, cancellation,
late acknowledged writes and near-safe-integer timestamps. Validate JS serialization
inputs and failure classification before accepting revision/absence. Assess host timeouts
and artifact workflow permissions against the actual deployment. Record reviewer identity,
exact reviewed tree, unresolved findings and acceptance.

Use [the operations matrix](../../docs/operations.md) for dedicated cross-POP, uncertain
write, interruption and late-effect trials. Preserve operator traces securely and only
sanitized exports in git. Independent review, native continuity, selected-provider CAS
and deployed monitor gates remain pending. Green CI enables code review, not publication
or production support.
