# TICK-05 integration proof

This is a dedicated proof service, separate from the TICK-01 receiver and TICK-02 KV
guest. It integrates admission, job ownership, bounded execution, Secret Store, host
timers, and the explicit HTTP KV adapter. Jobs have no external application effects.
All live gates remain **INCONCLUSIVE**; [new local evidence](evidence/STATUS.md) is separate
from historical results.

## Local validation

```sh
npm ci
npm test
npm run proof:trigger:burst
npm run proof:trigger:build
npm run proof:trigger:smoke -- --viceroy /absolute/path/to/viceroy
```

The burst compares identical 100-request/16-job cohorts with and without admission using
an atomic in-memory reference store. The real Wasm smoke uses a local HTTP API fixture
with exact generation strings above JavaScript's safe integer range. It checks rejected
authentication/routing, a 16-request burst, lost admission replies, pre-existing crashed
leases, and an uncooperative application timeout. Neither fixture proves deployed CAS.
The smoke uses local port 17678 and removes only its temporary configuration and process.

## Dedicated deployment

Deploy only after separately establishing TICK-01/02's requirements; this repository does
not activate services or provision resources as part of local checks. Do not attach the
proof to a production store, production trigger, or application workflow.

1. Create a dedicated proof KV store and set its identifier in `src/settings.js`. Preserve
   all retained records. For a new independent cohort, use a fresh dedicated store or
   explicitly change the proof namespace/prefix in source and rebuild; never delete or
   expire a previous cohort's records to make a rerun win. Record the changed settings.
2. Provision/link Secret Store `tick05_secrets`: `probe-token` is a dedicated 32–256
   character base64url secret; `fastly-api-token` is a dedicated scoped KV API credential.
   Populate secrets outside source/config/log exports. Local environment mappings are
   `TICK_PROBE_TOKEN` and `TICK05_FASTLY_API_TOKEN`.
3. Configure static backend `fastly_api` for `api.fastly.com:443`. Verify TLS is enabled,
   certificate/SNI and host override are `api.fastly.com`, and connect/first-byte/between-byte
   timeouts bound each request below the receiver's remaining lease/invocation budget.
   The setup manifest's address/port alone does not establish these properties. Avoid
   retries, redirects, and caching. There is no native fetch abort in SDK 3.45.0; the
   receiver awaits writes and requires host-bounded I/O. Measure the actual API latency
   before choosing lease/budget values; a failed latency fit is evidence to change the design.
4. Configure real-time logging endpoint `tick05_evidence` with raw JSON message format
   (for example `%s`) to an operator-owned durable destination. The guest also emits console
   observations; deduplicate log delivery by request ID. Tokens and exception payloads
   are omitted. Restrict access to observations and sanitize exports before committing.
5. Build with the manifest in this directory, inspect the configuration, and activate the
   dedicated receiver through the operator's normal Fastly workflow. Record service,
   version, Wasm hash, settings, backend timeouts, and clock assumptions alongside evidence.

The proof exposes exact GET paths `/__tick/run/normal`, `/__tick/run/lost`,
`/__tick/run/crash`, and `/__tick/run/timeout`. All require `x-tick-probe-token`; queries,
bodies, and other methods reject. Every response disables caching. `normal` executes
no-op jobs; `lost` drops the first successful admission PUT reply in that invocation;
`timeout` deliberately never resolves its first eligible job. Each scenario has independent
admission/job prefixes. The local smoke seeds `crash` records; a live crash experiment
must capture an interrupted real invocation or use an explicitly labeled seeded fault.
Do not describe seeded state as an observed platform crash.

The proof-only admission interval is **one hour**, with eight jobs and a four-job cap.
This keeps a bounded burst within one cohort stable; it is not a recommended production
cadence. A repeated normal burst within that interval will skip scanning. A recovery can
revisit the same slice, with per-job highwater suppressing confirmed completed runs.

## Burst and native probe observations

With the secret already supplied securely as `TICK_PROBE_TOKEN`, capture a new trace:

```sh
mkdir -p proof/trigger/evidence/live
node proof/trigger/run.mjs --url https://RECEIVER/__tick/run/normal \
  --mode live --requests 100 --concurrency 16 --max-jobs 4 \
  --output proof/trigger/evidence/live/NEW_COHORT.json
```

The driver allows at most 256 requests and 32 workers, bounds each request/body, refuses
redirects, and reserves a new output before networking. It persists only whitelisted
primitive protocol fields. Remote requests require HTTPS; local HTTP requires synthetic
mode. It measures explicit client traffic, not native probe continuity or hidden POP fanout.

For native probes, follow TICK-01's [separate source-service topology and idle/deployment
windows](../README.md). Configure a static backend to the integrated receiver, with GET
`/__tick/run/normal`, a dedicated auth header, verified receiver host/TLS routing, expected
200, and measured probe timeout. The existing TICK-01 configuration helper targets its
own proof path: it does not automatically configure this guest. Keep probe timing evidence
independent of direct client bursts. Collect durable `tick05_evidence` observations since
healthchecks discard response bodies. Intended receiver status does not prove the native
probe received that response before its timeout.

Use coordinated separate locations for a fresh contention cohort. Combine their sanitized
rows and run exported `analyzeBurst(rows, { requests, maxJobsPerTick: 4, mode: 'live' })`.
The analyzer requires complete unique responses and one service/version, rejects duplicate
owners for the same admission attempt and excess store fanout, and distinguishes remote
skipped arrivals from actual contending POPs. A lone client cannot choose or certify POPs.
Even complete observed multi-POP suppression remains an **inconclusive platform verdict**.

To close the integration gate, correlate unique receiver observations with complete backend
operation traces and retained admission/job records. Establish cross-POP CAS through the
TICK-02 proof; inspect stale-owner rejection, ambiguous outcomes, conservative recovery,
fixed horizons, and completed-job replay suppression. Measure native request counts, idle
continuity, deployment gaps, receiver/probe timing, API latency/rate limits, and storage work.
Run an isolated uncooperative timeout and a genuine interrupted-invocation recovery with
record readback. Missing responses, throttling, unknown POPs, or mixed versions are incomplete
evidence. Reference-store savings do not predict Fastly billing or guarantee exactly-once effects.

Retire the dedicated source/receiver and revoke proof credentials when finished. Preserve
sanitized traces and retained proof state; teardown must not reset an active coordination
namespace. There is no publication, production rollout, or live gate pass in this ticket.
