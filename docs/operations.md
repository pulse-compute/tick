# Experimental Tick operations

Tick needs external arrivals, an atomic conditional store and a measured host budget.
The current adapters and Fastly trigger remain experimental. Local tests do not establish
native probe continuity, global CAS or a usable production latency envelope. Keep the
[architecture](architecture.md) and provider-specific proof gates with every deployment.

## Configuration and observability

Record the exact package commit/tree and Wasm hash; namespace/job IDs; immutable schedule
revision/anchor/interval; admission/job prefixes and physical store; lease/run/retry limits;
clock-skew assumption; host request/backend timeouts; TLS/SNI/Host and cache/retry settings.
Map credentials and application resources explicitly. Do not export secret values,
authorization headers, target response bodies, or raw provider errors into evidence.

Use the sanitized trigger response and operator-owned receiver/backend logs together.
Native health probes generally discard the response body; a complete arrival/POP history
needs durable receiver logging. The monitor's S3 snapshots preserve health, not all
coordination or admission events. A single client does not choose or prove distinct POPs.

| Observation | Interpretation and next action |
| --- | --- |
| Receiver HTTP 200 | Trigger protocol/sweep acknowledgement; inspect the per-job result and health snapshot separately. |
| Admission skipped/conflict, zero job reads | Duplicate suppression; incoming and admission traffic still incur work. |
| Application completed, coordination indeterminate/unresolved/unavailable | An effect may exist; retain state and let a later bounded trigger reconcile/recover. |
| Observation unavailable/retry | Health was not established. Check read permissions, region/Host/signing, throttling and latency. |
| Completed health outcome down/unreachable | The monitor obtained a health result; this is not a scheduler/storage failure. |
| Cancelled/expired | Stop further dispatch; await coordination writes and recover after conservative expiry. Already sent effects can still commit. |
| Configuration mismatch | Stop the affected namespace and inspect retained state/configuration. Never reset records to clear the error. |

Count admission calls, job visits/dispatches, provider latency/throttling, missing native
arrivals, execution retries, and stale/unknown transitions independently. `completed`
application output alone does not prove a stored terminal record. `settled` with
`settlementDeadlineExceeded` preserves a known late write; it grants no new execution
authority. Trigger timeout aborts the runner's parent signal, which carries no reason,
so sampled request exhaustion can appear as runner cancellation.

TICK-09 propagates the original monotonic request timeline through authentication,
admission and every visited job. Lease/schedule timestamps use the conservative effective
epoch when the raw wall clock stalls. Raw clock rollback still fails closed. Timers must
work on that elapsed basis; neither sampled budgets nor timers preempt synchronous code.
No CAS atomically compares server time, and no lease fences a downstream application effect.

## Isolated deployed fault trials

Provision only dedicated proof resources through the existing runbooks. Allocate a new
cohort/prefix for each trial and retain previous state/evidence. Do not point destructive
fault experiments at an active application namespace. These commands are manual,
bounded drivers; they neither deploy nor activate anything. The implementation pass
performed no live trial because no deployment/credentials were supplied.

With `TICK_PROBE_TOKEN` supplied securely, and explicit HTTPS proof endpoints:

```sh
mkdir -p proof/hardening/evidence/live
node proof/kv/run.mjs --url https://KV_PROOF/__tick/kv \
  --experiment FRESH_KV_COHORT --contenders 4 --mode live \
  --out proof/hardening/evidence/live/FRESH_KV_COHORT.json
node proof/s3/run.mjs --target https://S3_PROOF/__tick/s3 \
  --cohort FRESH_S3_COHORT --contenders 4 --mode live \
  --out proof/hardening/evidence/live/FRESH_S3_COHORT.json
node proof/trigger/run.mjs --url https://TRIGGER_PROOF/__tick/run/normal \
  --mode live --requests 100 --concurrency 16 --max-jobs 4 \
  --output proof/hardening/evidence/live/FRESH_BURST.json
```

Select the intended deployment's dedicated token before each command; it is not a shared
cross-service credential. KV/S3 drivers cap contenders/operations and their 120-second
client start budget, with per-call timeouts. The trigger driver allows at most 256 requests
and 32 workers; its bounds are by count/per-request timeout, not a 120-second total limit.
All reserve fresh output before networking. `mode: live` is a label, not certification.
S3 coordination trials are needed when selecting S3 as a coordination provider; they
do not replace the monitor's separate application-observation trial.

| Fault/gate | Required deployed evidence | Existing entry point |
| --- | --- | --- |
| Native arrivals while idle, deployment gaps, POP amplification | Correlated source/receiver timing and arrival logs across idle/deployment windows | [TICK-01 topology and sequence](../proof/README.md) |
| KV create/replacement races and stale owner | Independent contending POPs, exact revisions and retained readback, rejected former-owner write | [KV proof](../proof/kv/README.md) |
| Lost coordination reply after commit | Provider trace proves actual conditional commit; outcome remains indeterminate; positive revalidation precedes dispatch | KV/S3 proof lost-reply cases; label injected response loss |
| Admission burst and late/crashed sweep | Complete per-request counters and service/version/POP data; bounded scan and per-job claims | [Trigger proof](../proof/trigger/README.md), `/normal`, `/lost`, `/crash`, `/timeout` |
| S3 stale ETag and missing current object | Exact signed conditions; conditional loser/missing replacement rejection; retained current keys | [S3 proof](../proof/s3/README.md) |
| Monitor access error/throttle | 403/429 causes unavailable/retry and no health request; measure with the exact principal/backend | Dedicated monitor and controlled permissions/backend fault |
| Monitor save then interrupted settlement | Same logical key; attempt two reuses attempt one's saved snapshot, with no new probe | [Monitor runbook](../apps/http-monitor/README.md); interrupt a real invocation and capture both stores |
| Late monitor PUT after cancellation/takeover | Capture accepted PUT body, cancellation/expiry, successor probe and final first-writer object | Controlled delayed provider transport; physical overlap and first-winner policy are expected |
| Independent review | Reviewer identity, findings/disposition and exact reviewed tree | [TICK-09 audit and handoff](../proof/hardening/REVIEW.md) |

Local/seeded fault cases must retain those labels. An expired fixture is not an observed
process crash, and a delayed local provider is not evidence of deployed backend lifetime.
Missing replies, unknown POPs or mixed versions leave evidence incomplete. Keep actual
storage traces alongside sanitized reports; a finite observed report is never a certificate.

## Retention, recovery and stopping

Retain job highwater/terminal records and admission records. Never delete, expire, restore
old bytes or unconditionally rewrite them to force another run. Mutation/attempt IDs must
remain unique across restarts. Older leased/retryable runs block new slots until recovered
or terminalized; retry requires a later trigger and never extends the fixed run horizon.

For S3, retain current objects without lifecycle expiry/delete markers or writes from a
replica/other principal. Versioning does not preserve a current highwater by itself.
Coordination needs conditional replacement; immutable observations require conditional
first creation. Policies must enforce the appropriate condition per prefix and prevent
external deletion/unconditional overwrite. KMS/encryption policies are separate host
requirements. `s3:GetObject`/`s3:PutObject` need the selected object scope, and missing-key
GET requires `s3:ListBucket` on the bucket to yield observable 404 rather than 403. Verify
the exact deployed policy; the monitor never interprets permission errors as absence.
See [AWS GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
and [conditional-write enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).

When stopping, disable the external source/ingress first, then account for already
admitted invocations and in-flight provider writes using measured host/backend lifetime.
Retain the stores and evidence. Revoke dedicated credentials after the trial; do not
erase an active coordination namespace as teardown. A caller timeout does not prove a
request did not commit. Coordinate target/schedule/provider changes through a separate
migration plan; changing a revision on existing retained state fails closed, and reusing
a revision with new semantics silently violates the contract. Garbage collection and
automatic migration remain deferred.

For dependency failures, stop work or leave the bounded retained attempt for recovery.
Do not add a read/unconditional-write lock, switch providers implicitly, spin on CAS,
detach coordination writes, or claim a successful health measurement from an unavailable
observation. Select proven provider semantics and budgets before supported operation.
