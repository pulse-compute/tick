# TICK-01: Fastly trigger viability

## Question and decision

Can a Fastly backend healthcheck repeatedly invoke a Compute receiver, continue during an
idle period, survive deployment, and supply usable timing/traffic evidence?

**Current decision: INCONCLUSIVE — live evidence is required.** Local tests and a Wasm
build validate the harness; they cannot establish Fastly probe cadence or idle continuity.
See [evidence/STATUS.md](evidence/STATUS.md) for executed checks.

Healthchecks are experimental wake-up signals, not a scheduling SLA. TICK-01 preserves all
arrivals. Coordination, duplicate suppression, and application execution are later tickets.

## Topology and bindings

Use two **dedicated test services**, each with a distinct domain/service ID:

1. **Trigger service**: a static backend points to the receiver; attach the healthcheck to
   that backend. Start with 10 s interval, 2 s timeout, expected 200.
2. **Receiver Compute service**: deploy this package. It never fetches itself, the trigger,
   or another backend. Do not create recursive application requests to keep the clock alive.

Receiver dependencies are named and explicit:

| Resource | Binding | Purpose |
| --- | --- | --- |
| Secret Store | `tick_secrets`, key `probe-token` | Dedicated 32–256 character base64url credential |
| Real-time logging endpoint | `tick_evidence` | Persist one JSON event per line |
| Build settings | `src/settings.js` | Non-secret experiment ID and bounded response delay |

No KV store, S3 client, database, Pulse runtime, or background process is required by the
receiver. The log endpoint may target an operator-owned object store or other supported
logging destination. Configure raw message format (e.g. `%s`) without a timestamp prefix;
retain collection start/end times and delivery diagnostics separately. Logging sink delivery
is asynchronous and is not a durable per-event acknowledgement.

## Local checks

From the repository root:

```sh
npm ci
npm test
npm run build
# Optional: Node-only end-to-end smoke test
npm run proof:smoke
# Or test the compiled guest with a locally installed Viceroy binary:
# npm run proof:smoke -- --viceroy /path/to/viceroy
# Generate a dedicated local token without printing it.
export TICK_PROBE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
fastly compute serve --skip-build
```

The `fastly.toml` local secret-store binding reads `TICK_PROBE_TOKEN`. Missing/empty secrets
fail closed. Viceroy exercises the actual guest and bindings, but does not generate real
Fastly healthchecks. A Node-only fallback is `npm run proof:local`; that bypasses the guest.

In another shell with the same local token:

```sh
npm run proof:burst -- --url http://127.0.0.1:7676 --count 100 --concurrency 20
```

The burst script always uses `/__tick/manual`, accepts HTTPS or loopback HTTP, disables
redirects, bounds concurrency/count/timeouts, and never prints the token. An optional
`--events <new-file.ndjson>` saves response observations (exclusive create). Its client
latency includes network/response completion; receiver timing does not.

## Deploy the receiver

1. Use a Fastly account with access to create/configure the two test services. No production
   service should be repurposed. Set up the Fastly CLI and an operator-approved test target.
2. Set a unique experiment ID in `src/settings.js`; keep `responseDelayMs: 0` for normal
   phases. Keep the same experiment ID across the redeployment being measured.
3. Deploy with `fastly compute publish` and complete its setup prompts. Bind a Secret Store
   under `tick_secrets`, populate `probe-token`, and configure/activate the `tick_evidence`
   log endpoint. If already provisioning resources separately, link the same resource name
   to the receiver service. Verify the actual active bindings in Fastly.
4. Use only a dedicated proof token. Never inline credentials at build time or commit them.
   A healthcheck's static header is visible to those who can read service configuration.
   It is separate from the Fastly API token.
5. Smoke-test valid/missing/incorrect tokens and GET/POST. Expected statuses: 200/401/401/405;
   all responses include `Cache-Control` and `Surrogate-Control` with `no-store`.
6. Repeat manual requests and confirm distinct request IDs with fresh arrival times, no
   unexpected cache hits, and corresponding log events. Confirm configured logging delivery
   before starting a window. Save service versions, receiver domain, timing settings, and
   redacted configuration as evidence.

## Configure the trigger

Create a separate test service/version and domain via your normal provisioning flow. Supply
an existing **unlocked, inactive** trigger version. This helper creates only two named
resources; it never creates a service or activates a version:

```sh
node proof/scripts/configure-trigger.mjs \
  --service-id TRIGGER_SERVICE_ID \
  --receiver-service-id RECEIVER_SERVICE_ID \
  --version 1 \
  --receiver https://RECEIVER_DOMAIN
```

The default is a redacted dry run. API writes use Fastly form encoding and verify each
resource with a readback, including the exact auth header, without printing its value. With `FASTLY_API_TOKEN` and `TICK_PROBE_TOKEN` set, add
`--apply` to create `tick01_probe` and `tick01_receiver`. The script refuses active/locked
versions and existing resources of those names. After a partial API failure, inspect the
unlocked version and remove its partial proof resources before retrying. It will not
silently overwrite existing configuration. Review and activate the version explicitly.

The plan fixes TLS SNI, certificate hostname, Host override, and healthcheck Host to the
receiver domain, avoiding accidental routing back to the trigger. The supplied receiver
service ID is a separation check; independently verify that its domain actually resolves to
that receiver service. Trigger application requests should return a simple response; the
healthcheck belongs to the configured static backend and does not need application fetches.

Warm the trigger domain with real requests from known vantage points. Record which vantage
points were used. Fastly initializes a service on first traffic; do not assume an untouched
service starts a perpetual clock. A local concurrency burst is not multi-POP warm-up evidence.

## Capture and experiment sequence

Capture the receiver's raw `tick_evidence` NDJSON from before the baseline starts until after
the final phase ends; allow log delivery to drain before analysis. `fastly log-tail` is useful
for diagnostics, but prefer persistent logs for idle windows. Console and named-logger
copies have the same request ID and are deduplicated by the analyzer. Strip tooling prefixes
before supplying NDJSON; do not silently discard malformed or missing records. Reconcile
with available request/healthcheck diagnostics. If completeness cannot be established, set
`collectionComplete: false`.

Choose phase boundaries **before looking at the results**, using UTC epoch milliseconds.
For an initial 10 s interval, use a predeclared 30 s maximum gap. Recommended initial windows:

| Phase | Duration | Action and required evidence |
| --- | --- | --- |
| Baseline | 10 min | Warm trigger first; record native arrivals and multiplicity. |
| Idle | At least 60 min | Stop all external application requests to both services. Keep only native probes and out-of-band log collection. Record start/end even if no arrivals occur. |
| Redeploy | 10 min | Activate a new receiver version with the same experiment/token; include both old and new arrivals. Also test a trigger-version activation separately and record its activation time. |
| Burst | Bounded, outside idle | Use `/__tick/manual`, e.g. 100 requests/concurrency 20. Save client latency and unique IDs. This is synthetic load, not native POP proof. |

`noExternalTraffic` is an operator attestation, not something logs can prove. Never manually
call `/__tick/probe` during native windows; possession of the token permits doing so and
route labels alone cannot prove provenance. Use `/__tick/manual` for all smoke/load calls.

Repeat a longer idle window before treating the trigger as operationally useful. A successful
hour is an observation, not a reliability or future-liveness guarantee.

### Timeout and request lifetime

Run a **separate experiment ID** after the normal phases:

- Normal receiver delay 0 with 2 s probe timeout.
- Receiver delay 2500 ms with 2 s probe timeout (bounded at 3000 ms).
- Restore delay 0 and verify recovery.

Change only `responseDelayMs`, rebuild, and deploy the receiver for each condition. Record
health status as observed from warmed trigger locations or appropriate Fastly diagnostics;
health state is site-specific. Do not infer successful probe responses from receiver logs:
a client can time out while the receiver later logs an intended 200. A manual request with
`--timeout-ms 2000` can test client cancellation but does not replace native healthcheck
observations. Keep this fault experiment out of normal continuity analysis.

All observation/hold work is awaited before responding. There is no `waitUntil`, detached
job, or work after the response. `handlerElapsedMs` stops before logging/response handoff;
it is not a total network RTT or confirmation the sender received 200.

## Analyze

Copy `fixtures/manifest.example.json` into ignored `evidence/live/`, fill real boundaries, the receiverServiceId, and
settings, and set `mode: "live"` only for a deployed run. Require all three attestations:
complete collection, verified native healthcheck configuration, and no external traffic in
idle. `expectedVersions` on redeploy is the old/new **receiver** version pair.

```sh
node proof/scripts/analyze.mjs \
  --events proof/evidence/live/events.ndjson \
  --manifest proof/evidence/live/manifest.json \
  > proof/evidence/live/analysis.json
```

The analyzer includes leading/trailing silence; removes duplicate log delivery by request
ID; preserves distinct simultaneous arrivals; reports per-window multiplicity, receiver POPs,
versions, and handler timing. Three intervals/three native events per phase is only an input
sufficiency floor. Follow the longer protocol above for a meaningful decision.

A report's `pass` means **observed arrival continuity only**. It cannot establish backend
healthcheck response success, end-to-end timeout behavior, or distributed scheduling safety.
Valid input exits 0 even for `fail`/`inconclusive`; automation must inspect `verdict` explicitly.
Malformed input exits 1. Synthetic or incomplete evidence never establishes live continuity.

### TICK-01 decision gate

Mark the ticket's live proof GO only after a reviewer has all of:

- Complete baseline/idle/redeployment observations within the predeclared gap budget.
- Fresh request IDs and non-cacheable live responses.
- Native trigger configuration plus documented warm-up/vantage points; receiving POP
  metadata is not misrepresented as the issuing POP.
- Native timeout/fault/recovery observations and client latency, beyond handler timing.
- Bounded manual burst evidence and measured native arrival multiplicity/traffic volume.
- Configuration, observation window lengths, deployment changes, and limitations recorded.

Otherwise record NO-GO for an observed unacceptable behavior or INCONCLUSIVE for missing or
insufficient evidence. Never promote local tests, fixtures, or analyzer output alone into a
GO decision. TICK-02 coordination remains an independent gate even if the clock succeeds.

## Teardown

Deactivate/delete the dedicated trigger test service first to stop all healthchecks. Stop
load clients, then retire the receiver test service and remove proof-only logging/resources
if no longer needed. Revoke the dedicated probe token. Preserve sanitized raw evidence and
the manifest with the decision. Do not commit service credentials or sensitive log exports.

## Official references

- [Healthcheck startup, fanout, and amortization](https://www.fastly.com/documentation/guides/concepts/healthcheck/)
- [Healthcheck API and headers](https://www.fastly.com/documentation/reference/api/services/healthcheck/)
- [Backend routing/TLS fields](https://www.fastly.com/documentation/reference/api/services/backend/)
- [Service chaining and loop detection](https://www.fastly.com/documentation/guides/getting-started/services/service-chaining/)
- [SecretStore](https://www.fastly.com/documentation/reference/compute/sdks/javascript/js-compute/secret-store/class.SecretStore/)
- [Local resources and setup in fastly.toml](https://www.fastly.com/documentation/reference/compute/fastly-toml/)
- [Receiver FASTLY_POP meaning](https://www.fastly.com/documentation/reference/compute/ecp-env/fastly-pop/)
- [Local testing limitations](https://www.fastly.com/documentation/guides/compute/developer-guides/testing/)

API form encoding follows [Fastly’s generated JS healthcheck client](https://github.com/fastly/fastly-js/blob/main/src/api/HealthcheckApi.js).
