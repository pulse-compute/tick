# TICK-06 validation — 2026-10-07 UTC

**Live TICK-01/02/05 gates remain INCONCLUSIVE.** These are new local checks of binding
configuration and adapter conformance. No live Fastly API request, deployment, activation,
resource creation, or production store mutation was performed. Earlier ticket evidence
is historical and unchanged.

- `npm test` passed 151 tests: 12 binding, 12 reusable conformance, 32 core, 29 runner,
  22 trigger/evidence, 10 adapter, 24 TICK-01 proof, and 10 TICK-02 proof tests.
  The conformance checks also passed after the final aggregation fix ensuring that two
  acknowledged winners remain failed evidence when another contender throws.
- Typechecked provider/resource examples and rejection cases passed. Isolated packed
  ESM/TypeScript consumption passed for both new subpaths (29 files; zero runtime dependencies).
- The [public conformance suite](local-conformance.json) observed all seven cases against
  the actual HTTP adapter with a local atomic HTTP fixture: 29 reads and 13 conditional
  writes. Unavailable faults did not reach the backend. `certified` remains false.
  A separate opaque-revision reference adapter also observed all cases. Adversarial
  fixtures detected non-atomic read/put, revision reuse, conditional creation on missing
  keys, malformed/numeric outcomes, and incorrect lost-reply classification.
- All three Fastly proof guests built with SDK 3.45.0 and TypeScript 5.9.3. Node 24.19.0
  and Viceroy 0.21.1 were used locally; CI targets Node 22. The existing Node receiver
  smoke passed.
- The [integrated guest using logical mappings](local-trigger-guest.json) passed its
  authentication/routing, duplicate, lost-reply, seeded recovery, and cooperative timeout
  checks. The 16-request burst admitted one four-job sweep: 26 admission calls plus 16
  job calls = 42 API calls; the full smoke made 89. Contender counts vary with ordering.
- The [KV guest](local-kv-guest.json) passed all eight existing scenarios in 38 API calls.
  Both Wasm guests used a local atomic HTTP fixture, not native or deployed Fastly KV.

| Guest | Bytes | SHA-256 |
| --- | ---: | --- |
| Integrated receiver | 11,828,703 | `e5b066e79650f88c5096d3c2aa4a7e5c88005cb723b8a8f9ac45c7be5e10d47e` |
| KV proof | 11,631,712 | `85f9fb90f65e806b87fc7c44f967e2046be07a145778383e9c24125dc4b188f3` |

Declaration checks cannot establish global CAS, ID uniqueness, clock skew, timer accuracy,
native cancellation semantics, or backend lifetime. The conformance suite reports finite
observations; a live mode label never certifies a deployment. Missing/stale readback or
fault bindings remain inconclusive. Follow the deployed ticket runbooks and correlate
complete traces with POP/deployment identity before relying on provider guarantees.
