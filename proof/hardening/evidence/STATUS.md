# TICK-09 evidence status

**Independent reviewer sign-off: PENDING. Deployed gates: INCONCLUSIVE.** This pass
performed an implementation-agent source audit, reproducible adversarial tests, focused
fixes, local guest faults and package workflow preparation. No separate reviewer, live
provider/deployment credentials, cross-POP targets or publication instruction was supplied.
No provisioning, activation, live provider trial, npm publication, tag/release or merge
was performed. Historical TICK-01 through TICK-08 evidence remains unchanged.

## Validation

- `npm test`: **195 tests passed**, including 18 monitor tests; strict types/rejections,
  packed ESM/TypeScript checks and isolated copied monitor consumption. The private
  package contains 33 files including operations guidance, with zero runtime dependencies.
- [Paired regressions](regressions.json): exact merged TICK-08 source tree, isolated build
  and current targeted tests produced **79 pass / 8 fail**. The same 87 tests all pass on
  fixed source. These reproduce clock handoff, serialization hooks, malformed Unicode,
  KV redirect/partial classification and S3 partial/expiring absence failures.
- [Standalone consumer](local-standalone.json) compiled/invoked public package exports
  outside the repo with only the offline tarball. No Pulse or provider SDK dependency.
- [Node receiver smoke](local-node-smoke.json) and all five Wasm builds passed.
  [Validation metadata](local-validation.json) records exact Wasm hashes/lengths and
  Node 24.19.0, TypeScript 5.9.3, SDK 3.45.0 and Viceroy 0.21.1. CI checks on Node 22.
- The private artifact command checks a clean committed checkout, privacy/version,
  dependency/file/export scope and fresh output. CI also runs artifact preparation.
  Manual main-only upload is prepared, not dispatched or described as a release.
  [Five CLI guard cases](artifact-guards.json) rejected before build/pack/network in
  isolated committed fixtures: output escape, privacy disabled, runtime dependency,
  dirty source and existing output.

## Actual local guest observations

[KV](local-kv-guest.json), [trigger](local-trigger-guest.json), [S3](local-s3-guest.json)
and [monitor](local-monitor-guest.json) ran their actual newly built Wasm against local
conditional HTTP fixtures. All passed. Every S3 wire signature was independently
verified with Node HMAC, including host/path/payload/condition/session inputs.

The monitor now covers **eight isolated domains**: duplicate up burst, HTTP 503/down,
transport failure/unreachable, lost save reply after commit, seeded saved-snapshot
recovery, signed GET access denial, KV throttling, and late first-writer save. Access
denial/throttling caused no health request or snapshot. A late-save cohort made two
health requests, retained one attempt-one/up snapshot and settled attempt two after
its own target returned 503. The old PUT body reached the provider fixture before
expiry; the commit was released only when the successor's probe reached its fixture.

All results are **synthetic** and explicitly uncertified. The crash state is seeded,
the late write is a controlled fixture commit after request expiry, and no actual IAM
policy or live quota was evaluated. These do not prove deployed request survival,
backend cancellation, provider CAS scope, naturally interrupted invocation recovery,
or native probe continuity. They do demonstrate the documented consumer recovery and
first-retained-snapshot policy, including permitted physical overlap.

## Remaining gates

Separate reviewer identity/findings/disposition on the exact final candidate tree;
native idle/deployment continuity; measured cross-POP selected-provider conditional
races, stale reads and unknown writes; deployed admission/storage amplification;
actual host/backend lifetime, latency/quotas and clock-skew assumptions; real monitor
permission/lost/late-effect trials; actual Pulse host shim verification when used.
Use [the audit handoff](../REVIEW.md), [operations matrix](../../../docs/operations.md)
and [release gate](../../../docs/release.md). A private artifact, green CI or `live`
label supplies no independent review, provider certification or publication authority.
