# TICK-06 reusable adapter conformance

`@pulse-compute/tick/testing/conformance` exports `runStoreConformance(options)` and
its typed report/options. TICK-07's [S3 proof](../proof/s3/README.md) runs the same suite
through independent signed Fastly invocations and adds stale-owner authority cases.
The harness imports no Node APIs, test framework, provider SDK, timers,
or credentials. An adapter author can invoke it from a test, a controlled host, or an
operator-owned driver. **Calling it writes retained records**; construction helpers and
application startup never run it automatically.

```ts
import { runStoreConformance } from '@pulse-compute/tick/testing/conformance';

const report = await runStoreConformance({
  writers: [firstBinding, secondBinding],
  prefix: 'conformance/UNIQUE_COHORT/',
  suiteId: 'UNIQUE_COHORT',
  mode: 'synthetic',
  readRounds: 4,
  faults: { lostReply: lostReplyBinding, unavailable: unavailableBinding },
});
```

## Harness preconditions

Supply 2–8 writer bindings addressing **the same backing store and key domain**. Use an
operator-allocated fresh prefix exclusively for this invocation, never an active job or
admission prefix. The suite checks initial absence, but stale reads alone cannot establish
freshness; allocation/isolation are harness responsibilities. Records remain after the
run. Never clear keys, add TTL, or reset retained revisions to obtain a successful rerun.
Allocate a new cohort instead. The suite has no cleanup/delete/unconditional-write method.

Prefix format is `[A-Za-z0-9/_-]{1,96}/`; `suiteId` is a unique non-secret identifier using
`[A-Za-z0-9._-]{1,40}`. Cases use synthetic contract-v1 records, canonical run identities,
and distinct mutation content. They exercise adapter serialization/conditions rather than
the scheduler's state-transition policy or real job effects.

Optional fault bindings also address the same store. Inject lost replies **after an actual
successful conditional mutation at the adapter transport boundary**. Merely rewriting an
already applied adapter result does not validate transport classification. The unavailable
binding injects read/write transport failure. Keep fixture faults labeled; injected faults
are not observations of naturally occurring platform faults. Missing fault bindings leave
the corresponding cases inconclusive.

## Cases and reports

| Case | Required observation |
| --- | --- |
| `create-race` | One acknowledged conditional creator; all other writers conflict; exact winner readback. |
| `replace-race` | One acknowledged replacement from a shared revision; exact winner readback. |
| `stale-revision` | Original revision rejects after replacement; replacement remains observable. |
| `revision-on-missing` | A real observed revision cannot create another missing key. |
| `retained-records` | Leased, retryable, completed, and failed formats round trip via conditional writes. |
| `lost-reply` | Committed reply loss is indeterminate; matching readback precedes a positive CAS revalidation and readback. |
| `unavailable-transport` | Read failure is unavailable; write failure is indeterminate. |

Revisions are nonempty opaque strings, passed unchanged to CAS. They are never parsed,
compared numerically, or treated as fencing tokens. The suite remembers value/revision
pairs and rejects the same key/revision describing different validated values. Missing
or stale readback is inconclusive because the store contract permits stale reads.

Each case returns `observed`, `failed`, or `inconclusive`, plus a non-secret reason and
adapter-method call counts. Multiple acknowledged winners, a stale accepted condition,
numeric/malformed revisions, incorrect fault classification, and incoherent pairs fail.
Unavailable reads, unknown writes, thrown operations, exhausted readback, used prefixes,
or missing prerequisites are inconclusive. Failure dominates the aggregate; otherwise
any inconclusive case keeps the aggregate inconclusive. Reports contain no record contents,
revisions, keys, credentials, or thrown payloads.

The report always says `certified: false`. `mode: live` is only an operator-supplied evidence
label. An observed finite cohort does not prove cross-POP scope, perpetual global CAS,
clock bounds, lease non-overlap, transport timeouts, native host support, or exactly-once
effects. Correlate complete backend traces and retained readback with deployment/POP
identity before interpreting live results. Keep TICK-01/02/05's deployed runbooks and gates.

## Bounds and local checks

Readback permits 1–8 rounds (default 4) without sleeps. Writes are never retried. All
contending writes are awaited, including when another writer throws. Given `W` writers
and `Q` read rounds, the upper bound is `9WQ + 5W + 1` reads and `2W + 9` writes.
These count adapter methods, not hidden transport retries or provider billing. Backend
timeouts/cancellation must bound I/O latency; the harness does not abandon in-flight writes.

`npm run test:conformance` runs the public suite against the actual HTTP adapter with an
atomic HTTP fixture and an independent opaque-revision reference adapter. Adversarial
fixtures include a read/put emulation, reused revisions, conditional creation on a missing
key, malformed outcomes, stale readback, and lost-response misclassification. These local
observations do not clear a live gate. See [TICK-06 validation](../proof/bindings/STATUS.md).
