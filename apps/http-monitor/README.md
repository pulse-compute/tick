# TICK-08 HTTP monitor

One runnable consumer of the public Tick package. An authenticated external trigger
checks one configured HTTPS URL, coordinates through Fastly's HTTP KV API, and keeps
an immutable health observation in S3. It uses no database, Pulse package, provider SDK,
dashboard, background loop or internal scheduler. All deployed gates remain
**INCONCLUSIVE**; see [local evidence and missing checks](evidence/STATUS.md).

## Behavior and resource mapping

The defaults in `settings.mjs` select the latest one-minute job slot. Namespace admission
allows a sweep every five seconds; a separate per-job claim still authorizes execution.
Three attempts share a fixed 30-second run horizon. Duplicate triggers can still incur
admission traffic. Missed slots are skipped, never backfilled as historical health data;
a pending older run is recovered before a newer slot can execute.

| Logical dependency | Explicit binding | Authority |
| --- | --- | --- |
| `state` / `tick08/jobs/` | Fastly KV HTTP conditional store | Per-job claim, retry and retained terminal state |
| `state` / `tick08/admission/` | Same store, distinct prefix | Sweep admission only |
| `resources.probe` | Fixed-target HTTP GET, or a host-supplied Pulse shim | Return HTTP status or transport failure |
| `resources.observations` | Application-owned S3 HTTP snapshot store with signed transport | Conditional first snapshot for a run |
| Clock, IDs, timers, cancellation, credentials | Node or Fastly host | Explicit runtime capabilities |

`src/app.ts` builds these mappings with public `@pulse-compute/tick/bindings` exports.
Construction performs no provider I/O. The application's S3 JSON store is separate from
Tick's S3 **coordination** adapter: observations are application data, not ownership receipts.

The job reads its S3 key first. A matching saved observation completes recovery without
another HTTP request. Otherwise it sends one GET with caching and redirect following
disabled, inspects only status/headers, and cancels the body. A 2xx response is `up`,
another HTTP status (including 3xx) is `down`, and a transport exception is `unreachable`.
These are successful health observations. Storage uncertainty causes an execution retry
on a later trigger; exception messages and response bodies are never persisted.

The snapshot key is stable across attempts:

```text
tick08/observations/ns-tick08-monitor/job-homepage/rev-v1/at-<scheduledForMs>.json
```

Each JSON value contains only schema, canonical run identity, original attempt number,
probe start/observation epoch times, monotonic duration, outcome and HTTP status/null.
Use the run identity returned in a trigger response with `observationKey(prefix, run)`
to locate the object through your ordinary S3 tooling. No list/latest API is supplied.

PUT uses atomic `If-None-Match: *`. An unknown PUT may have committed; a later attempt
reads the same key before probing. A known conditional loser performs one bounded
readback and accepts a valid first winner. An absent read or lost save before commit
can lead to another probe. A malformed/foreign snapshot or unavailable read fails closed.
Per execution there are at most two S3 GET calls, one S3 PUT call and one health GET
call, with no application transport retry loop. Coordination/admission bounds are described in
[the trigger notes](../../docs/trigger.md).

This is **first retained snapshot per logical run**, conditional on atomic S3 writes,
coherent reads and retained current objects. It is not exactly-once HTTP execution or
owner-fenced S3 commit. A previously sent PUT can arrive after cancellation or takeover
and win the immutable key; the new owner accepts that earlier observation, even if its
probe would now report a different outcome. The stored attempt and timestamps describe
that first result. Cancellation cannot retract a sent request or undo a save.

## Build and check

From the repository root, with Node 22+:

```sh
npm ci
npm run test:monitor
npm run monitor:guest:build
npm run monitor:guest:smoke -- --viceroy /absolute/path/to/viceroy
```

`test:monitor` compiles strict TypeScript, runs application failure/recovery tests, then
copies the source to an isolated directory, installs only the offline packed Tick
artifact and compiles/invokes it through public exports. The package still has zero
runtime dependencies; this application, its signer and host tools stay outside the
packed artifact. The standalone check needs no Pulse monorepo or network.

The Viceroy check invokes the actual compiled application guest with three local HTTP
backends and generated temporary fixture credentials. Five isolated domains cover a
16-trigger burst, HTTP 503, transport failure, a real fixture commit with its reply
dropped, and recovery from explicitly seeded expired KV state plus a saved snapshot.
Every S3 wire signature is independently verified. It uses local port 17680 and cleans
up its guest/process configuration; it does not measure deployed CAS or native probes.

## Node host

The included `node.mjs` runs the same application on `127.0.0.1:8080`. Populate these
environment variables through your existing secret/environment workflow before
`npm run monitor:node`:

| Variable | Value |
| --- | --- |
| `TICK08_TARGET` | HTTPS URL without credentials, query or fragment |
| `TICK08_KV_STORE_ID` | Dedicated Fastly KV store ID |
| `TICK08_S3_ENDPOINT` | Regional virtual-hosted bucket HTTPS origin, without a path |
| `TICK08_S3_REGION` | Explicit matching AWS region |
| `TICK08_PROBE_TOKEN` | Dedicated 32–256 character base64url trigger token |
| `TICK08_FASTLY_API_TOKEN` | Scoped HTTP KV API credential |
| `TICK08_AWS_ACCESS_KEY_ID`, `TICK08_AWS_SECRET_ACCESS_KEY` | Scoped observation credentials |
| `TICK08_AWS_SESSION_TOKEN` | Session token when using temporary credentials; otherwise omitted |

With the token already supplied securely, invoke externally:

```sh
curl --fail-with-body --header "x-tick-probe-token: $TICK08_PROBE_TOKEN" \
  http://127.0.0.1:8080/__tick/run
```

Only exact GET `/__tick/run` is accepted; queries and bodies reject. Every response
disables caching. HTTP 200 acknowledges the trigger protocol, not the monitored site's
health or successful job execution: inspect `admission`, `tick.results` and the snapshot.
Node has explicit native cancellation, disconnect propagation and 1.5-second per-fetch
timeouts. Timers bound invocation/job budgets; the host does not generate interval
triggers. For a remote receiver, put authenticated HTTPS ingress in front of this
loopback listener using your normal host workflow.

## Fastly host and controlled deployment

`fastly.js` uses SDK 3.45.0, WebCrypto signing, Secret Store, host timers and cooperative
cancellation. It does not cast the cooperative signal into a native fetch signal; the
pinned SDK does not support native fetch abort. The three static backends are explicit.

Before a controlled trial, establish the earlier trigger/KV gates and record these
settings with the application evidence:

1. Replace the nonsecret target/store/bucket/region placeholders in `settings.mjs` and
   matching backend hosts in `fastly.toml`. Keep job/admission/observation prefixes
   dedicated. Choose and retain the namespace/revisions; a target change must not
   silently reuse an old health snapshot. Schedule/namespace migration needs a separate
   reviewed plan; restarting the guest never resets stored state.
2. Link Secret Store `tick08_secrets`. Map `probe-token`, `fastly-api-token`,
   `aws-access-key-id`, `aws-secret-access-key`, and `aws-session-token` to the variables
   above for local serving; supply an empty session entry only for non-session credentials.
   Use credentials scoped to KV and S3 GetObject/PutObject on the dedicated prefixes.
   Never log or commit credentials, authorization headers or presigned URLs.
3. Verify TLS, certificate/SNI and Host override separately for `fastly_api`
   (`api.fastly.com`), `monitored` (target host), and `observations` (the exact bucket
   origin signed by the host). An address and port in this manifest do not configure
   or prove those properties. The sample is not ready to activate with placeholders.
4. Disable backend retries, caching and redirect following. Configure and measure
   connect/first-byte/between-byte timeouts against the eight-second lease and ten-second
   request budget, including secret reads/signing and coordination calls. A per-stage
   backend timeout is not a total request bound. Verify total host request lifetime and
   slow-body behavior; the guest limits observation/error bodies to 4096 bytes. Change
   budgets if provider latency/quotas do not fit. A timeout can leave an effect uncertain.
5. Build with `npm run monitor:guest:build` (or the app manifest's build command), inspect
   Wasm hash/configuration, and use the operator's normal dedicated-service workflow.
   No provisioning, activation or publication is performed by these checks.
6. Send authenticated external triggers. Native health probes require the separate
   source/receiver topology and continuity checks in [TICK-01's runbook](../../proof/README.md).
   Set GET `/__tick/run`, the dedicated auth header, expected 200, receiver TLS/Host and
   a measured timeout. There is no timer-driven scheduling fallback in this application.

Keep KV terminal/admission records and S3 current snapshots retained, without TTL,
lifecycle deletion, unconditional overwrites or delete markers. Deleting state permits
replay; an S3 delete marker can make a conditional create possible again. This sample
has no garbage collector. Storage grows by roughly one observation per executed minute,
and duplicate arrivals still consume receiver/admission traffic.

Probe callers usually discard response bodies. The S3 snapshot records health; it does
not provide complete admission/POP or coordination traces. A controlled live trial must
capture those through operator-owned request/backend logging, sanitize it and retain
it alongside readbacks. Do not export raw secrets or target response payloads.

## Optional Pulse boundary

The standalone HTTP binding is the default. A host can replace only the probe capability:

```ts
import { createPulseProbe } from './src/resources.js';

// invokePulseProbe is your host-owned adapter, with its target/provider mapped explicitly.
const probe = createPulseProbe(invokePulseProbe);
```

`PulseProbeInvoker` receives a frozen object with `deadlineMs`, cooperative `signal`,
and optional native `transportSignal`, and returns `{ httpStatus: number | null }`.
It receives no run/attempt identity, KV handle, admission authority, timer or S3 store.
Tick still claims/runs/settles; the application still persists observations. Shape and
authority separation are tested with an injected shim, not an actual Pulse SDK call.
This is a wiring contract, not a security sandbox: a host closure can capture other
capabilities. There is no implied Pulse runtime API, SDK compatibility claim or monorepo
dependency. Verify the actual host shim separately when integrating Pulse.

To close the practical-monitor gate, measure native idle/deployment continuity, cross-POP
admission/job claims, actual KV uncertain writes, S3 conditional races and lost replies,
late-effect recovery, timeouts, latency/quotas and clock assumptions on dedicated retained
state. The local results leave all earlier live gates open.
