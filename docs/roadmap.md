# Tick implementation roadmap

The package name is provisional (`tick` or `fastly-tick`). The repository is independent
of Pulse and publishing remains disabled. Keep scope to fixed intervals, duplicate-trigger
admission, recoverable attempts, bounded execution, and explicit dependency bindings.

| Ticket | Deliverable / acceptance | Model and effort | Dependency / status |
| --- | --- | --- | --- |
| TICK-00 | TypeScript package contract, binding example, architecture, minimal CI, and documented guarantees/time assumptions. | Astra / Ultra | This change; contracts only. |
| TICK-01 | Authenticated Fastly probe receiver and evidence harness; measure idle continuity, deployment gaps, routing, timeout, and POP arrivals. | Sol 6.1 / High | PR #1 merged; live viability pending. |
| TICK-02 | Minimal KV adapter plus deployed concurrency, stale-read, lost-response, and takeover proof. | Astra / Ultra | After 00; pending. |
| TICK-03 | Fixed-interval eligibility and ownership transitions; deterministic tests of run identity, recovery, and stale-owner rejection. | Astra / Ultra | After 01/02 live gates; pending. |
| TICK-04 | Bounded execution, retries, cancellation/deadline propagation, crash recovery, and application effect contract. | Sol 6.1 / High | After 03; pending. |
| TICK-05 | Fastly trigger integration and admission before job scanning; measure request and storage amplification under duplicates. | Sol 6.1 / High | After 04; pending. |
| TICK-06 | Runtime binding validation, ergonomic provider configuration, and reusable adapter conformance suite. | Sol 6.1 / High | After 02–05; pending. |
| TICK-07 | S3 conditional-write adapter; deployed conformance including ambiguous outcomes and stale-owner rejection. | Sol 6.1 / High | After 06; pending, unless needed earlier as coordination fallback. |
| TICK-08 | One practical HTTP monitor with KV coordination/S3 observations; verify Pulse boundary and standalone usage. | Sol 6.1 / High | After 06; needs 07 only if coordinating via S3. |
| TICK-09 | Independent adversarial review, deployed fault scenarios, focused fixes, operations docs, package/release workflow. | Astra / Ultra review; Sol 6.1 / High fixes | After 07/08; pending. |

## Evidence gates

1. **Trigger viability (01):** demonstrate that native probes reach the receiver when
   the source service is idle; measure gaps around deployment, timeout, and POP traffic.
   If insufficient, change the trigger design before TICK-03. A local burst is not this proof.
2. **Coordination viability (02):** prove deployed global per-key conditional creation
   and replacement against contending invocations. Include stale reads and uncertain
   write outcomes. If KV cannot enforce the contract, prove S3 before TICK-03; do not
   substitute a read/put lock or weaken the ownership claim.
3. **Integration viability (05):** require measured duplicate suppression, bounded
   storage work, and crash recovery before expanding adapters or consumers.

TICK-00 may proceed while live evidence is pending because it defines requirements
without implementing a scheduler. TICK-02 can likewise investigate storage independently
of TICK-01's trigger proof. Neither passing types nor local receiver tests clear a live gate.

TICK-01's checked-in [evidence status](../proof/evidence/STATUS.md) remains authoritative.
The existing local results demonstrate receiver/harness behavior; native probe timing,
idle continuity, cross-POP amplification, and deployed request lifetime remain unverified.

## Scope control

The first preview can use one proven coordination provider. TICK-07 may follow that
preview if Fastly KV passes; the final review must accurately state supported providers.
Adapter semantics are required from day one, but an unproven second backend is not a
prerequisite to the first useful consumer.

Defer cron/calendar expressions, queues, workflow graphs, dashboards, durable audit
history, automatic schedule migration, record garbage collection, and full Uptime Kuma
compatibility. Do not add release-scale test gates to each small development slice.
Resolve the public package name before publishing; no release/publish is part of TICK-00.
