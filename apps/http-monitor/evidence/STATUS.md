# TICK-08 evidence status

**Deployed monitor behavior: INCONCLUSIVE.** No deployed service/profile, KV store,
observation bucket, scoped live credentials or cross-POP targets were supplied. No live
provider requests, provisioning, activation, publication or merge were performed.
The earlier TICK-01/02/05/07 gates remain inconclusive and historical evidence is unchanged.

## Local validation

- `npm test`: **188 passing tests**, including 16 monitor tests, strict TypeScript
  examples/rejections and packed ESM/TypeScript consumption. The private package still
  contains 32 files and zero runtime dependencies; application/host/signing tools are excluded.
- [Standalone result](local-standalone.json): copied application TypeScript compiled and
  invoked outside this repository with only an offline installed Tick tarball. One probe
  produced a retained HTTP 503/down observation and duplicate admission suppressed replay.
  There were no Pulse or provider SDK runtime dependencies.
- Monitor tests cover first-snapshot recovery, lost saves both before/after commit,
  uncertain KV claim/settlement, unavailable reads, conditional first-winner readback,
  cancellation/clock bounds, exact run keys, safe status-only payloads and native forwarding.
  The narrow Pulse shim receives only deadline/cancellation; no real Pulse API was invoked.
- The Node receiver proof smoke and all five Wasm builds passed. Local runtime was
  Node 24.19.0, TypeScript 5.9.3, JS Compute SDK 3.45.0 and Viceroy 0.21.1. The CI workflow
  checks/builds on Node 22, including the new application guest.

[Guest result](local-guest.json) records the actual compiled consumer, explicit Secret
Store/static backends, conditional KV HTTP, independently verified S3 SigV4 and these
five isolated local fixture domains:

| Scenario | Authenticated triggers | Health GETs | Snapshots | Completed / stored attempt |
| --- | --- | --- | --- | --- |
| Up, duplicate burst | 16 | 1 | 1 | 1 / 1 |
| HTTP 503/down | 1 | 1 | 1 | 1 / 1 |
| Transport failure/unreachable | 1 | 1 | 1 | 1 / 1 |
| S3 commit with lost reply | 2 | 1 | 1 | 2 / 1 |
| Saved snapshot and expired lease fixture | 1 | 0 | 1 | 2 / 1 |

Rejected authentication/routing caused no fixture provider I/O. Burst admission losers
performed no job reads. Every S3 wire request's host, path, payload, session token and
condition were checked independently with Node HMAC. The lost reply was an actual atomic
fixture commit followed by socket closure. The crash scenario used **explicitly seeded**
expired KV state and a saved first-attempt snapshot; it did not interrupt a real platform
invocation. `mode: synthetic` and `certified: false` remain explicit. The result includes
the exact 11,959,830-byte Wasm SHA-256, runtime versions and request counts; those counts
describe these finite trials, not billing or deployed latency guarantees.

## Evidence still required

Native source-probe idle/deployment continuity, real cross-POP admission and KV job CAS,
provider throttling/stale reads/uncertain commits, actual S3 conditional races and lost
replies, naturally interrupted invocation recovery, slow/late application effects,
backend/TLS/Host/timeouts, invocation lifetime, clock skew and latency/quotas. Correlate
sanitized receiver/backend traces with retained KV and S3 readbacks. The app returns
bounded protocol JSON but does not emit a durable POP/coordination evidence stream;
operators must capture those traces separately for live trials.

Verify the actual Pulse host shim if using it. A tested injected function shape is not
Pulse SDK compatibility or a capability security sandbox. Immutable S3 first-writer
deduplication does not fence an expired owner or guarantee exactly-once probing. Read
[the runbook](../README.md) before choosing deployment budgets or retained-state policy.
