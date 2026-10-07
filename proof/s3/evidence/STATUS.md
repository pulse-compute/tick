# TICK-07 evidence status

**Live S3 coordination gate: INCONCLUSIVE.** No deployed AWS bucket, scoped credentials,
Fastly proof service/profile or cross-POP observation targets were supplied for this
ticket. No AWS requests, provisioning, activation, publication or merge were performed.
The signed receiver, bounded driver and [runbook](../README.md) are ready for a controlled
trial. No production fallback or earlier trigger/KV/integration gate is certified.

## Local validation

- `npm test`: **172 passing tests**, strict TypeScript examples/rejections and isolated
  offline packed ESM/TypeScript consumer. Packed artifact contains 32 files, remains
  private, and has zero runtime dependencies. Signing/evidence tools stay out of it.
- S3 adapter tests exercise the actual HTTP boundary, exact quoted ETags, native signal
  forwarding, missing-key versus bucket/proxy/delete-marker errors, unknown outcomes,
  serialization/configuration capture, shared conformance and core authority rejection.
- Proof-only WebCrypto signing matches AWS's published GET and encoded PUT vectors;
  session token, conditional headers and payload hashes participate in the signature.
- Node receiver smoke and all four Wasm builds passed. The S3, integrated trigger and
  KV guests also passed actual Viceroy 0.21.1 smoke with SDK 3.45.0 on Node 24.19.0.
  CI separately builds/checks on Node 22.

[S3 guest evidence](local-s3-guest.json) records four contending invocations, all seven
shared conformance cases, stale-owner renewal/settlement rejection and superseded
unknown-write rejection. There were **89 receiver operations / 87 provider fixture
requests**, with five retained keys. The two unavailable faults send no provider request;
the two dropped write replies occur after an actual conditional fixture commit. Every
wire signature was independently checked with Node HMAC against the exact host, path,
ETag condition, session token and payload. This is **synthetic fixture evidence**;
`status: inconclusive`, `distributed: false` and `certified: false` remain explicit.

[Integrated trigger](local-trigger-guest.json) and [KV guest](local-kv-guest.json)
regression results are recorded separately, including exact Wasm hashes/lengths.
TICK-01/02/05/06 historical evidence was preserved. These new results verify imports,
bindings and local runtime behavior; they do not reinterpret earlier pending gates.

## Evidence still required

Actual regional AWS conditional-create/replacement races on isolated retained keys,
at least two observed POPs for each race, complete service/version/receiver/provider
request traces, coherent current-object readbacks, lost replies after real commits,
stale-owner rejection and live backend/deadline failure scenarios. Retain bucket policy,
current-key isolation and host/TLS/timeout settings alongside observations. Verify latency,
quotas and clock assumptions before using S3 for admission/job coordination.

Held ETags and lease timestamps in this suite are deliberate fixtures. They do not
measure naturally stale reads, server-clock fencing, native probe continuity, physical
nonoverlap or exactly-once effects. An `observed` finite live trial would still require
operator review and repeat/fault evidence; the report never sets `certified: true`.
