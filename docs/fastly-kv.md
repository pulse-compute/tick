# TICK-02: Fastly KV coordination candidate

**Live verdict: INCONCLUSIVE.** This ticket provides an HTTP KV adapter and a bounded
proof harness. No deployed concurrency result has been collected. The native JavaScript
SDK path is unsupported by the pinned SDK; the HTTP path is explicit, not an automatic
fallback. TICK-03 still requires the deployed trigger and coordination gates.

## Why the HTTP path

In `@fastly/js-compute` 3.45.0, `KVStore.put` accepts `gen` as a JavaScript number, while
`KVStoreEntry` exposes no generation getter. The implementation discards the lookup's
generation. A full unsigned 64-bit revision cannot reliably round trip through a number.
Do not manufacture revisions from metadata or infer a generation from record contents.

The Fastly KV HTTP API returns a `generation` header with the value and accepts the exact
string in `if-generation-match`. The adapter calls that API with an injected transport
and token resolver. This adds an API credential, outbound backend, latency, and API rate
limits; it is not the native KV host binding or a production performance recommendation.
A future lossless native binding can implement the same contract independently.

```ts
import { createFastlyKvStore } from '@pulse-compute/tick/adapters/fastly-kv';

const coordination = createFastlyKvStore({
  storeId: 'operator-supplied-store-id',
  token: async () => loadApiToken(), // host Secret Store; never a job resource or log field
  fetch: (url, init) => fetchThroughFixedFastlyApiBackend(url, init),
  signal: invocationSignal,
});
```

The example's helpers are application supplied. Construct the adapter inside the request
when the host bindings require request context. The transport must preserve the method,
body, conditions, cancellation signal, manual redirect policy, and cache bypass. Compute's
proof entry supplies the named `fastly_api` backend and `CacheOverride('pass')` explicitly.
There is no imported provider SDK or Node dependency in the packed adapter.
The pinned Fastly guest has no AbortController/fetch-signal support. Its proof binding
omits the optional signal, awaits the host operation, and reports deadline overruns;
backend timeouts must be configured separately. A local deadline cannot retract a write.

## Mapping and failure behavior

All requests target `https://api.fastly.com/resources/stores/kv/{storeId}/keys/{encodedKey}`.
Keys are percent encoded as a single path component; the adapter adds no application prefix.
Use an exclusively managed coordination namespace: all writers must follow this contract,
and external tools must not expire, delete, or reset its records.

| Contract | HTTP operation / interpretation |
| --- | --- |
| Read | GET; 200 requires valid JSON and a canonical positive unsigned 64-bit decimal `generation` from the same response. |
| Absent | GET 404; this alone never grants ownership. |
| Create if absent | PUT with `?add=true`. |
| Replace expected revision | PUT with unchanged `if-generation-match`; no numeric conversion. |
| Applied | Successful PUT response (200, 201, or 204). |
| Conflict | PUT 412 only; no broad exception/message matching. |
| Indeterminate | Any other write response, redirect, cancellation, or transport exception. |
| Unavailable | Failed read, unsupported record/version, malformed/missing generation, or invalid/oversized data. |

Each operation makes at most one HTTP request. There are no hidden retries, TTLs, deletes,
list operations, unconditional writes, or clock conditions. In particular, 429/5xx never
count as contention evidence, and a 202 response cannot establish completed application.
Transport/auth failures are sanitized; upstream error bodies and credentials are not emitted.
Invalid caller keys/records/preconditions throw a sanitized TypeError before storage I/O.

The adapter validates contract-v1 record shape, canonical run identity, nonnegative safe
integer timestamps, positive attempts, and bounded IDs/failure codes. Mutation and attempt
tokens use `[A-Za-z0-9._:-]{1,128}`; failure codes use that alphabet with an 80-character
limit. Reads are capped at 16 KiB. Configuration/schedule policy validation is still TICK-06;
checking the record shape does not authorize any transition or execution.

## What the proof must establish

Use the dedicated Compute proof and operator-owned KV test store described in
[`proof/kv/README.md`](../proof/kv/README.md). Every experiment uses fresh keys, retained
after the run. The harness records each input, response, identity, and receiver POP.

- Concurrent creates: one known winner; other contenders definitively conflict.
- Concurrent replacements from one shared revision: one known winner.
- Retained stale revisions: stale renewal/completion must fail after a successor writes.
- Simulated crashed owner: seed an expired lease, conditionally take over, reject the former
  revision. The store does not evaluate lease time, and this is not a scheduler recovery proof.
- Lost reply: deliberately discard a successful PUT reply through the transport, observe
  `indeterminate`, and require positive conditional revalidation before considering ownership.
- Superseded ambiguous claim: a held old snapshot cannot revalidate after another writer wins.

Injected reply loss and held old snapshots are labeled fault scenarios, not naturally
observed platform faults. Multiple successful contenders or a stale successful replacement
are failures. Missing results, transient errors, throttling, or insufficient POP diversity
are inconclusive. Synthetic runs cannot pass a live gate. A finite live pass describes only
the measured API path and experiment; it does not prove perpetual global correctness or
native host semantics. Review the complete trace and selected deployment before TICK-03.

Viceroy 0.21.1 is useful for guest integration, but is not the conditional-write oracle:
its local object-store generation/add check precedes a separate mutation lock, and a
generation condition on a missing key is not rejected there. HTTP fixture results are
also local implementation checks, not evidence about deployed Fastly KV.

## Sources checked for this ticket

- [Pinned SDK declarations](https://github.com/fastly/js-compute-runtime/blob/v3.45.0/types/kv-store.d.ts)
  and [runtime implementation](https://github.com/fastly/js-compute-runtime/blob/v3.45.0/runtime/fastly/builtins/kv-store.cpp).
- [Fastly KV API reference](https://www.fastly.com/documentation/reference/api/services/resources/kv-store-item/)
  and [official generated API path/header implementation](https://github.com/fastly/fastly-js/blob/main/src/api/KvStoreItemApi.js).
- Official HTTP fixtures: [successful writes](https://github.com/fastly/go-fastly/blob/main/fastly/fixtures/kv_store/create-keys.yaml),
  [add conflict](https://github.com/fastly/go-fastly/blob/main/fastly/fixtures/kv_store/insert-item-add-failure.yaml),
  [generation conflict](https://github.com/fastly/go-fastly/blob/main/fastly/fixtures/kv_store/insert-item-generation-match-failure.yaml).
- [Viceroy 0.21.1 local implementation](https://github.com/fastly/Viceroy/blob/v0.21.1/src/object_store.rs).
- [Pinned fetch declarations](https://github.com/fastly/js-compute-runtime/blob/v3.45.0/types/globals.d.ts)
  and [CLI 16.1.0 setup schema](https://github.com/fastly/cli/blob/v16.1.0/pkg/manifest/setup.go).
