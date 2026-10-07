# TICK-06 explicit resource bindings

`@pulse-compute/tick/bindings` exports `createBindings(options)` and
`createCoordinationBinding(reference, stores)`. They resolve one logical name and capture
validated callable bindings. Construction performs no storage reads/writes, token loading,
clock sampling, ID generation, timer scheduling, or provider discovery. The application
chooses request-scoped construction when its host requires it.

```ts
import { createBindings, createCoordinationBinding } from '@pulse-compute/tick/bindings';

const stores = {
  'scheduler-state': {
    kind: 'fastly-kv-http' as const,
    options: { storeId, token: loadApiToken, fetch: fixedApiTransport },
  },
};
const bindings = createBindings({
  coordination: { name: 'scheduler-state', prefix: 'uptime/jobs/' },
  stores, clock, ids,
  resources: { observations: s3Observations, check: httpProbe },
  validateResources: (value) => typeof value.observations?.save === 'function'
    && typeof value.check === 'function',
});
const admission = createCoordinationBinding(
  { name: 'scheduler-state', prefix: 'uptime/admission/' }, stores,
);
```

The example's transport, secret resolver, clock, IDs, and application resources are host
supplied. The [typechecked example](../examples/provider-bindings.ts) preserves the
monitor's resource type. Application observations can use S3 independently of KV
coordination; this ticket adds no S3 coordination adapter or observation deduplication
guarantee. Job code still receives application-owned resources.

## Mapping choices

| Mapping | Required configuration | Meaning |
| --- | --- | --- |
| `provided` | `store: CoordinationStore` | An explicitly supplied custom adapter. |
| `fastly-kv-http` | `options: FastlyKvOptions` | Construct the HTTP adapter with a store ID, token resolver, transport, and optional native signal. |

Only the exact own property named by the reference is resolved. Missing aliases,
inherited mappings, unknown kinds, weak adapters, and malformed provider options fail
with sanitized `TypeError`. There is no native/HTTP fallback, environment probing,
implicit credential discovery, provisioning, prefix rewriting, or shared adapter cache.
Unselected mappings are not instantiated or validated. Resource guards are application
code: they must return `true` synchronously; false or exceptions reject.

Aliases now match `[A-Za-z0-9._-]{1,80}` in **all** construction paths, including direct
core/runner/trigger use. This tightens the private draft's previously loose nonempty name
check. Prefixes retain `[A-Za-z0-9/_-]{0,128}`. The core applies the literal prefix exactly
once; adapters receive the full key. Admission and jobs require distinct prefixes even
when they map the same physical store. Mappings do not provide a cross-key transaction.

## Validation and capture

Shared declaration checks require callable reads/CAS and the five coordination capability
literals, both clock functions, both ID-source functions, and callable optional telemetry.
The runner and trigger additionally capture the cancellation factory and timer function.
Getters encountered during binding validation cannot expose their exception payloads.
Methods retain their original `this`; later replacement of configuration fields cannot
change captured callables. Clock state, ID counters, adapter state, and application resource
contents remain application-owned and can change normally. Binding objects and capability
declarations are frozen; resource objects are neither cloned nor frozen.

`createBindings` requires an explicit `resources` property and preserves its inferred type
and identity. An optional guard checks resource shape; generic types alone cannot validate
resource handles or side-effect semantics. Definitions/jobs/limits remain validated by their
existing constructors. Clock values and emitted IDs are checked when used, not sampled as
a startup diagnostic. Declared global CAS scope and ID uniqueness still require evidence.

Controllers are checked when the runtime factory is actually invoked. They must produce
fresh, active signals with abort notification methods and a callable abort function.
Signals cannot be reused by a captured runtime. A claimed native signal must be the same
signal controlled by that controller and expose the native signal methods; unrelated or
cooperative-only signals reject. Structural checks do not certify a native brand, timer
accuracy, cancellation delivery, or a transport honoring the signal. Host bindings remain
responsible for working cancellation and asynchronous timers with valid cleanup functions.
Validation does not undo host side effects or a previously acquired job lease if a later
factory invocation fails.

The HTTP adapter captures token/transport callables and its optional native signal once.
Cooperative signals cannot masquerade as its native signal. Fastly SDK 3.45.0 has no native
fetch cancellation; use the [cooperative recipe](execution.md) and verified backend
timeouts. Neither mapping helpers nor capability validation proves provider semantics.
TICK-01/02/05 live gates remain pending.

Use the [conformance suite](conformance.md) explicitly on isolated retained test keys.
It is never run implicitly by these helpers or by application startup.
