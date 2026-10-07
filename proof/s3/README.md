# TICK-07 deployed S3 proof runbook

This is a separate authenticated storage receiver, not a scheduled trigger or application
executor. Each driver operation reaches a fresh Fastly invocation; the S3 adapter sends
one signed GET/conditional PUT. The driver reuses TICK-06 conformance and adds retained
stale-owner renewal/settlement rejection and an unknown claim superseded before
revalidation. [STATUS.md](evidence/STATUS.md) separates local and deployed evidence.

## Prepare an isolated deployment

1. Allocate a dedicated regional general purpose bucket and **fresh exclusive cohort**
   matching `[A-Za-z0-9_-]{1,40}`. Keys stay under `tick07/COHORT/`. Never share this
   prefix with production jobs/admission, reset it, delete records or reuse a cohort.
2. Set `src/settings.js` endpoint, region and cohort; replace the backend address in
   `fastly.toml` with the same virtual-hosted bucket origin. The checked-in endpoint and
   `tick07-local` cohort are fixture placeholders. Select your explicit Fastly profile
   and new proof service; attach backend `s3` and Secret Store `tick07_secrets`.
3. Grant the proof principal GetObject/PutObject for that prefix and ListBucket scoped
   to it. Enforce conditional PUTs; forbid deletion, old-version restoration, other
   unconditional/copy writers, expiration/archive lifecycle rules and replication into
   the proof prefix. Versioning does not replace these rules. Read [S3 notes](../../docs/s3.md).
4. Populate `probe-token`, `aws-access-key-id`, `aws-secret-access-key`, and
   `aws-session-token` through Secret Store. Use scoped temporary credentials and their
   session token where available; an empty session entry is only for credentials without
   a session. No credentials belong in settings, source, command arguments or evidence.
5. Configure backend TLS verification, certificate hostname, SNI and Host to match the
   signed bucket host. Set connect/first-byte/between-byte timeouts within the 5 s receiver
   budget (for example 500/2,000/1,000 ms), and verify the deployed settings. Disable
   connection/SDK retries and any proxy cache. The guest explicitly uses cache `pass`
   and manual redirects; region redirects are unsuccessful observations, never followed.
6. Run `npm ci`, `npm test`, `npm run proof:s3:build`. From `proof/s3`, run your explicit
   Fastly `compute build`/`compute publish` workflow only after choosing the intended
   deployment. This ticket does not activate a service or alter an AWS bucket.

The guest signs the payload and all adapter headers with proof-only WebCrypto SigV4.
Signing loads credentials inside each operation, supporting host-controlled rotation.
The pinned SDK has no native fetch cancellation, so the receiver uses a deadline marker
and awaits the transport/write; configured backend timeouts must bound it. A deadline
does not abandon a coordination write or change an acknowledged HTTP outcome. Verify
the host request lifetime and latency before interpreting a live run.

## Capture a bounded run

After loading only the probe token into `TICK_PROBE_TOKEN`, from the repo root:

```sh
npm run proof:s3 -- --target https://PROOF_HOST/__tick/s3 \
  --cohort FRESH_COHORT --contenders 4 --mode live \
  --out proof/s3/evidence/live/FRESH_COHORT.json
```

Create the output directory first. The driver reserves a new output file with exclusive
creation and mode 0600 **before writes**. It has a 120 s start budget, 7 s HTTP timeout,
2–8 contenders, bounded read rounds and a calculated maximum request count. No request
or write is retried, including uncertain responses. Every parallel contender is awaited.
A timed-out receiver request may still commit its single PUT; classify it as unknown
and retain the cohort. Choose a new cohort for a new run.

The JSON includes sanitized operation/status/timing traces, independent receiver IDs,
POP/service/version metadata, provider request IDs, injected-fault markers and all nine
case results. It does not include credentials, Authorization headers, ETags or record
payloads. Retain bucket/backend configuration and provider access traces separately so
an operator can verify the provider identity and correlate request IDs. Faults are injected
at the adapter transport boundary: reply loss occurs after HTTP 200; unavailable faults
occur before sending. They do not measure natural packet loss or natural stale reads.
Lease timestamps are explicit fixtures; this proof does not establish clock/skew margins.

## Interpret results

`observed` requires all seven conformance cases, both authority cases, complete unique
receiver traces, unexpired requests, provider request IDs and at least two observed POPs
in **each** create/replace race, all on one service/version. A single routing origin may
leave the result inconclusive: run the same one-shot driver with an operator-owned `call`
binding that distributes contenders across controlled geographic origins and retains
the full trace. Do not join unrelated cohorts or relabel synthetic metadata as deployed.
`certified` remains false even for finite live observations. A clear atomicity/stale-write
violation is `failed`; missing metadata, faults, readback, permission or transport evidence
is `inconclusive`. CLI exit codes are 0 observed / 1 failed / 2 inconclusive.

Before claiming S3 as a viable coordination fallback, retain actual AWS/POP evidence,
verify policy/current-key isolation, repeat across fresh cohorts and test real transport
failures/backend deadlines. This proof cannot clear native-trigger continuity, integration
amplification, time fencing or exactly-once effects. Earlier TICK-01/02/05 gates stay open.

## Local guest check

```sh
npm run proof:s3:build
npm run proof:s3:smoke -- --viceroy /path/to/viceroy
```

The smoke runner creates ephemeral random fixture credentials, uses an atomic HTTP server
with content-derived ETags, and independently verifies every guest signature with Node
HMAC. It exercises real Wasm/Secret Store/backend/WebCrypto behavior and all nine cases;
it is labeled synthetic and cannot certify AWS S3. Shut down/remove only the dedicated
proof service and credential bindings after a live trial; preserve retained evidence keys.
