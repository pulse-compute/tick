# TICK-02 evidence status

**Live coordination gate: INCONCLUSIVE.** No Fastly credentials/profile or deployed
proof target were available for this implementation. No live API request, deployment,
activation, resource creation, or production KV write was performed.

## Executed locally — 2026-10-07 UTC

- Package declarations, typed consumer, and packed ESM imports passed, including the
  `@pulse-compute/tick/adapters/fastly-kv` subpath; zero runtime dependencies.
- 44 tests passed: 10 adapter regressions, 10 KV proof tests, and 24 existing trigger tests.
- Both Fastly proof guests built with `@fastly/js-compute` 3.45.0. TypeScript 5.9.3,
  Node 24.19.0, and Viceroy 0.21.1 were used locally; CI targets Node 22.
- The actual KV Wasm guest passed authentication/routing checks and all eight scenarios
  against a **local HTTP API fixture**: 38 storage operations, complete unique observations.
  See [local-guest.json](local-guest.json). The distributed-evidence predicate stayed false.
- KV guest: 11,630,280 bytes; SHA-256
  `0a38ef85a8f76734aac5a8acb8fa999dfe4173f83a46f8139d8c464fe4e98b13`.
- Independent adapter and evidence reviews found and resolved mutable-precondition,
  serialization, full-record reconciliation, and mixed-deployment evidence issues.

These results validate the adapter and harness locally. They establish neither deployed
KV atomicity nor native host semantics. The fixture's conditional behavior is test code.

## Remaining gate

Deploy the dedicated HTTP proof with verified TLS/backend timeouts and scoped credentials,
then run the [runbook](../README.md) from coordinated separate locations. Retain the full
trace and inspect contention from at least two receiver POPs within each race, one service
and version, unique request IDs, full-record readback, stale-revision rejection, and the
labeled ambiguous-write/takeover scenarios. Missing responses or throttling are inconclusive.

The native JavaScript KV adapter remains unsupported by SDK 3.45.0's generation interface.
The explicit HTTP adapter has API credential/latency/rate-limit costs that still need live
assessment. Host abort signals are also unavailable in that SDK; elapsed deadlines do not
cancel an in-flight write. See [adapter notes](../../../docs/fastly-kv.md).

At the time of these TICK-02 measurements, no ownership transition implementation was shipped.
TICK-03 subsequently adds an experimental deterministic core at the user's request. Neither
ticket's live status changes; deployed integration remains gated on TICK-01 and TICK-02 evidence.
The measurements and guest artifact above remain the historical TICK-02 results.
