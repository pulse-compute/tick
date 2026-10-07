# Tick implementation roadmap

The development package is `@pulse-compute/tick@0.0.0` with source privacy retained.
The repository is independent of Pulse; manual versioned npm publishing is prepared
separately from deployed provider proof. Keep scope to fixed intervals, duplicate-trigger
admission, recoverable attempts, bounded execution, and explicit dependency bindings.

| Ticket | Deliverable / acceptance | Model and effort | Dependency / status |
| --- | --- | --- | --- |
| TICK-00 | TypeScript package contract, binding example, architecture, minimal CI, and documented guarantees/time assumptions. | Astra / Ultra | PR #2 merged; contracts only. |
| TICK-01 | Authenticated Fastly probe receiver and evidence harness; measure idle continuity, deployment gaps, routing, timeout, and POP arrivals. | Sol 6.1 / High | PR #1 merged; live viability pending. |
| TICK-02 | Minimal KV adapter plus deployed concurrency, stale-read, lost-response, and takeover proof. | Astra / Ultra | PR #3 merged; HTTP adapter/harness implemented, live gate pending. Native JS SDK binding unsupported. |
| TICK-03 | Fixed-interval eligibility and ownership transitions; deterministic tests of run identity, recovery, and stale-owner rejection. | Astra / Ultra | PR #4 merged; experimental core, deployed guarantees remain blocked on 01/02 gates. |
| TICK-04 | Bounded execution, retries, cancellation/deadline propagation, crash recovery, and application effect contract. | Sol 6.1 / High | PR #5 merged; experimental runner, deployed guarantees pending. |
| TICK-05 | Fastly trigger integration and admission before job scanning; measure request and storage amplification under duplicates. | Sol 6.1 / High | PR #6 merged; experimental receiver, live integration gate pending. |
| TICK-06 | Runtime binding validation, ergonomic provider configuration, and reusable adapter conformance suite. | Sol 6.1 / High | PR #7 merged; explicit mappings/shared checks and local conformance, live gates unchanged. |
| TICK-07 | S3 conditional-write adapter; deployed conformance including ambiguous outcomes and stale-owner rejection. | Sol 6.1 / High | PR #8 merged; S3 HTTP candidate, signed guest and nine local cases. Deployed S3 gate pending. |
| TICK-08 | One practical HTTP monitor with KV coordination/S3 observations; verify Pulse boundary and standalone usage. | Sol 6.1 / High | PR #9 merged; standalone consumer, Node/Fastly hosts, optional Pulse shim and local recovery checks. Deployed gates remain pending. |
| TICK-09 | Independent adversarial review, deployed fault scenarios, focused fixes, operations docs, package/release workflow. | Astra / Ultra review; Sol 6.1 / High fixes | PR #10 merged; local implementation audit/fixes, bounded fault matrix and private artifact workflow implemented. Separate independent reviewer sign-off and actual deployed trials remain pending. |

## Evidence gates

1. **Trigger viability (01):** demonstrate that native probes reach the receiver when
   the source service is idle; measure gaps around deployment, timeout, and POP traffic.
   If insufficient, change the trigger design before deployed integration. A local burst is not this proof.
2. **Coordination viability (02):** prove deployed global per-key conditional creation
   and replacement against contending invocations. Include stale reads and uncertain
   write outcomes. If KV cannot enforce the contract, prove S3 before deployed integration; do not
   substitute a read/put lock or weaken the ownership claim.
3. **Integration viability (05):** require measured duplicate suppression, bounded
   storage work, and crash recovery on deployed infrastructure before expanding adapters
   or consumers. Include native probe POP contention, host/backend timeouts, and provider
   latency/quotas; the local atomic reference store does not clear this gate.

TICK-00 may proceed while live evidence is pending because it defines requirements
without implementing a scheduler. TICK-02 can likewise investigate storage independently
of TICK-01's trigger proof. Neither passing types nor local receiver tests clear a live gate.
At the user's request, TICK-03 implements the deterministic protocol against the declared
store contract while both gates remain pending. Its tests exercise an atomic reference store
and injected faults; they do not certify Fastly storage, trigger continuity, or clock bounds.
The [core notes](core.md) document the experimental API and its authority limits.
TICK-04 adds [bounded execution](execution.md) against that protocol with injected host
capabilities. Its local cancellation/recovery tests also leave the live gates pending.
TICK-05 wires [namespace admission](trigger.md) and the runner into a compiled Fastly
guest, with explicit cooperative host cancellation and bounded duplicate-burst evidence.
Its [new evidence status](../proof/trigger/evidence/STATUS.md) distinguishes the local
reference comparison and Viceroy HTTP fixture from the still-pending deployed integration.
TICK-06 adds [binding configuration](bindings.md) and [adapter conformance](conformance.md)
to support provider verification without introducing another provider or a consumer.
Its [validation record](../proof/bindings/STATUS.md) preserves earlier measurements;
construction checks and finite reference-store cases do not clear deployed gates.
TICK-07 adds the [S3 candidate](s3.md), explicit signed transport mapping and
[deployed conformance driver](../proof/s3/README.md). Its [evidence status](../proof/s3/evidence/STATUS.md)
records only local fixture/Wasm observations until actual AWS/cross-POP results exist.
It does not establish a proven fallback for the pending KV gate.
TICK-08 adds a [practical HTTP monitor](../apps/http-monitor/README.md) using public
package exports, KV admission/job state and separate immutable S3 application snapshots.
Its [evidence status](../apps/http-monitor/evidence/STATUS.md) records isolated packed
consumption and actual consumer-Wasm fixture results. The optional Pulse shim verifies
a narrow wiring boundary; no Pulse SDK integration or deployed monitor behavior is certified.
TICK-09 records an [implementation audit and independent reviewer handoff](../proof/hardening/REVIEW.md),
fixes reproduced clock/serialization/HTTP-boundary failures, extends actual guest fixtures,
and adds [operations](operations.md) and [private artifact preparation](release.md).
Its [new evidence](../proof/hardening/evidence/STATUS.md) does not certify earlier gates,
substitute an implementation agent for an independent reviewer, or authorize publication.

TICK-01's checked-in [evidence status](../proof/evidence/STATUS.md) remains authoritative.
The existing local results demonstrate receiver/harness behavior; native probe timing,
idle continuity, cross-POP amplification, and deployed request lifetime remain unverified.
TICK-02's [evidence status](../proof/kv/evidence/STATUS.md) records the local HTTP-adapter
and guest checks; the deployed coordination gate remains inconclusive.

## Scope control

The first preview can use one proven coordination provider. TICK-07 may follow that
preview if Fastly KV passes; the final review must accurately state supported providers.
Adapter semantics are required from day one, but an unproven second backend is not a
prerequisite to the first useful consumer.

Defer cron/calendar expressions, queues, workflow graphs, dashboards, durable audit
history, automatic schedule migration, record garbage collection, and full Uptime Kuma
compatibility. Do not add release-scale test gates to each small development slice.
Resolve the public package name before publishing; no release/publish is part of TICK-00.

## Final package polish

The user-requested follow-up adds a manual main-only npm workflow, versioned tarball
preparation, fast Node 22/24 PR checks and a runnable README example. It leaves source
privacy and all independent/live proof dispositions intact. See [release setup](release.md).
