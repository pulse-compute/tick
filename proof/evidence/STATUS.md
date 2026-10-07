# TICK-01 evidence status

**Implementation: ready for review. Live trigger viability: INCONCLUSIVE.**

## Executed locally

- 24 focused Node tests pass: authentication, routing, bounded delay, duplicate visibility,
  phase-boundary gaps, log deduplication, service/version identity, local-evidence rejection,
  configuration validation, and sensitive-value-free errors.
- Fastly SDK 3.45.0 compiles the receiver to Wasm successfully.
- Compiled guest exercised with Viceroy 0.21.1, using real guest Secret Store and logger calls.
- Valid/missing/wrong authentication, wrong method, unknown route, and native/manual route
  classification behaved as expected; responses carried both no-store headers.
- Viceroy burst: **100/100 successful responses, 100 unique IDs, concurrency 20**.
- Node-only local smoke also passes. It is a convenience check, not platform evidence.

See [local-validation.json](local-validation.json) and [local-smoke.json](local-smoke.json).
The burst latency is a local machine measurement, not a Fastly edge performance estimate.
An initial cross-process smoke attempt could not reach a separately sandboxed loopback
server; the checked-in smoke runner starts server and clients together and passed.

## Not executed / not established

No Fastly services were deployed. No live Fastly credentials or selected deployment target
were available in this session. Therefore there is no evidence yet for:

- Native healthcheck-to-Compute traversal and configured API resource readback.
- Native probe interval, site/IP amplification, or idle-time continuity.
- Continuity during receiver/trigger deployment.
- Native probe timeout, unhealthy transition, and recovery.
- Live cache/routing behavior, global distribution, or sustained request cost.

The [runbook](../README.md) supplies configuration tooling, capture protocol, thresholds,
analysis, and teardown. The live gate remains open; **do not advance dependent scheduler
work on the assumption that this proof passed**. TICK-02's coordination proof may proceed
independently. TICK-00 remains unimplemented beyond the minimal scaffold needed here.
