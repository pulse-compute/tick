# TICK-02 conditional KV proof

This harness exercises the **Fastly KV HTTP API** through a Compute receiver. It does
not use the native `fastly:kv-store` SDK, implement a scheduler, or dispatch application
effects. The live coordination gate is **pending**. Synthetic tests and local guest
checks cannot certify global per-key atomicity. See [adapter limitations](../../docs/fastly-kv.md).
Executed checks and remaining gates are recorded in [evidence/STATUS.md](evidence/STATUS.md).

## Setup

Use a dedicated proof Compute service, KV store, and scoped API credential. This path
adds an API request and credential to every storage operation; it must be assessed
separately from native KV for latency, throttling, permissions, and operational cost.
The client only receives the proof endpoint token. Never send its Fastly API credential
to the client or put either credential into source, command arguments, or evidence.

1. Edit `src/settings.js`: set `storeId` to the dedicated KV store ID and `experiment`
   to a fresh `[A-Za-z0-9._-]{1,80}` identifier. The store ID is not a secret. Keep the
   receiver's cooperative request budget between 1 and 10,000 milliseconds.
2. Configure backend `fastly_api` at `api.fastly.com:443`, with TLS certificate checking,
   certificate hostname, SNI, and override host all `api.fastly.com`. Set and verify
   connect/first-byte/between-byte timeouts of 1000/5000/5000 milliseconds using the
   backend API or control panel before activating the service. `fastly.toml` supplies
   only address/port: CLI 16.1.0's setup backend schema does not accept TLS or timeout fields.
   Runtime requests use this fixed backend, bypass cache,
   and reject redirects. They cannot target a client-supplied backend or API hostname.
3. Link Secret Store `tick02_secrets` to the service. Set `probe-token` to a fresh
   32–256 character base64url token and `fastly-api-token` to the dedicated API credential.
   Both secrets are loaded inside requests. Missing bindings fail with sanitized errors.
4. From the repository root, run `npm ci`, `npm test`, then `npm run proof:kv:build`.
   The guest artifact is `proof/kv/bin/main.wasm`. Deploy and activate the dedicated
   proof service using your normal Fastly process; no script here deploys or activates it.

The backend API fields to verify on the inactive version are `use_ssl=true`,
`ssl_check_cert=true`, `ssl_cert_hostname=api.fastly.com`, `ssl_sni_hostname=api.fastly.com`,
`override_host=api.fastly.com`, `connect_timeout=1000`, `first_byte_timeout=5000`, and
`between_bytes_timeout=5000`. Do not assume unrecognized TOML fields configure these.

For local guest checks, the manifest maps `TICK_PROBE_TOKEN` and
`TICK02_FASTLY_API_TOKEN` into the two secret entries. A local run is synthetic even
if its configured HTTP backend contacts a real store. Never count `LOCAL`/`unknown`
metadata as deployed evidence. A settings change requires a new build/deployment.

## Run and preserve observations

Set `TICK_PROBE_TOKEN` in the client environment, then run from the repository root:

```sh
node proof/kv/run.mjs --url https://YOUR-PROOF-HOST/__tick/kv \
  --experiment YOUR-EXPERIMENT --out /tmp/tick02-observations.json
```

The experiment must match the deployed settings. The output is reserved exclusively
with owner-only permissions before the first request; an existing file is never overwritten. Tokens and request
headers are omitted. Exit status is `0` for observed distributed evidence, `1` for a
demonstrated safety failure, and `2` for inconclusive evidence. HTTPS is required except
for loopback HTTP. Use `--mode synthetic` for local checks; `--contenders 4` is the default
and accepts 2–16. Responses, request count, polling, and client lifetimes are bounded.

The pinned Fastly JS SDK does **not** supply `AbortController` or support fetch signals.
Its receiver uses a local deadline flag and request-body cancellation, with outbound I/O
limited by configured backend timeouts and the host request lifetime. An elapsed local
deadline cannot abort an in-flight Fastly write. The handler awaits that operation rather
than racing a timer and leaving detached work. Each observation reports `deadlineExceeded`
and `cancellation: "host-timeouts"`; late observations cannot satisfy the live gate. On
hosts with real signal support, the same handler passes an actual abort signal and reports
`"abort-signal"`. This is cooperative cancellation, never proof that a write did not commit.

All operations are authenticated POSTs to `/__tick/kv`, with no query string, a body of
at most 4 KiB, and a key beneath `tick02/<experiment>/`. The only operations are reads
and conditional writes of proof records. There is no listing, deletion, expiry, reset,
unconditional write, or arbitrary-key endpoint. Retain records after a run and choose
a new experiment for another run. Existing keys make a repeated experiment inconclusive
without intentional overwrite; stale absence still cannot bypass atomic create conditions.

`runProof({ call, experiment, mode, contenders, pollAttempts, pollDelayMs })` in
`scenarios.mjs` is the shared driver. Its injected `call` accepts an operation object
and returns the authenticated receiver's JSON observation. A distributed test rig can
route contender calls through geographically separate callers while retaining the same
driver, scenario coordination, and complete trace. The simple CLI uses one client origin;
one client may reach only one POP and therefore may leave the distributed gate inconclusive.
Do not concatenate unrelated reports and claim they are one concurrent race.

## Cases and verdicts

The report captures each operation request, response, client start/end time, receiver
POP, service identity/version, request ID, result, and actual injected-fault marker.

| Case | Required observation |
| --- | --- |
| Missing revision | Revision-conditional write on a fresh missing key conflicts; it must not upsert. |
| Create race | Concurrent create-if-absent contenders yield exactly one applied write; all others conflict. Readback matches the winner's complete record. |
| Replace race | Contenders using the same coherent read revision yield exactly one applied replacement, with complete winner readback. |
| Stale owner | A retained old revision cannot renew or complete after a successor replaces it. |
| Crash takeover | A seeded expired lease fixture is replaced by a new attempt; the former attempt cannot complete. |
| Lost response | The transport throws after successful PUT; the adapter returns indeterminate. Full-record reconciliation is followed by positive conditional revalidation. |
| Uncertain superseded | A reconciled uncertain claim is replaced by a successor; its held revision cannot revalidate. |

The expired lease uses fixture clock `2000`, expiry `1000`, and successor expiry `3000`;
there is no real-time sleep, server-clock predicate, scheduler takeover implementation,
or physical-overlap guarantee. Stale revisions are deliberately retained client snapshots,
not naturally observed stale provider reads. Lost responses are explicitly injected after
a successful PUT response reaches the receiver, not claimed as observed network failures.

Multiple applied writes against one precondition or an applied stale write produce `fail`.
Timeouts, throttling, missing observations, inconclusive reads, and incomplete scenarios
cannot yield a successful verdict. `observed` requires every case, a complete trace with
unique request IDs, one consistent deployed service identity and version, valid live metadata, and at
least two receiver POPs **within each create/replace contention cohort**. Setting
`mode: live` alone is insufficient. Every observation must stay within its recorded
receiver deadline. This bounded observation is evidence for the selected
HTTP path, not a universal proof, performance certification, or native SDK endorsement.
Review the preserved trace before changing the roadmap gate.

## Local validation

`npm test` includes `proof/kv/test/proof.test.mjs`. These tests run the real HTTP adapter
through the real receiver against an in-memory conditional transport, preserve generations
above JavaScript's safe integer range, inject post-commit response loss, and verify failing
CAS implementations and incomplete evidence cannot pass. The intentionally fabricated live
metadata test verifies verdict calculation only; it is not saved as deployed evidence.

After building the guest, run the actual Viceroy guest against a local HTTP API fixture:

```sh
npm run proof:kv:smoke -- --viceroy /path/to/viceroy
```

This validates guest imports, request handling, and HTTP-adapter integration with the
fixture. It exercises neither native KV operations nor deployed global KV semantics;
the result remains synthetic and cannot close the live coordination gate.
