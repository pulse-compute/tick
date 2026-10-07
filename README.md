# Tick

[![CI](https://github.com/pulse-compute/tick/actions/workflows/ci.yml/badge.svg)](https://github.com/pulse-compute/tick/actions/workflows/ci.yml)

Run bounded interval work from duplicated, unreliable triggers. Tick coordinates through
conditional writes in KV or S3, with application resources supplied through logical
bindings. It is a standalone TypeScript/ESM package with **zero runtime dependencies**
and no dependency on the Pulse monorepo.

Useful for uptime checks, periodic reconciliation and other small jobs invoked by an
external request or health probe. Tick runs work when a trigger arrives; it does not
create a scheduler or guarantee that a trigger will arrive.

**Experimental:** local contracts, race/fault tests and Wasm fixtures are covered.
Deployed Fastly trigger, KV, S3 and monitor proof gates remain inconclusive. Leases do
not provide exactly-once execution or undo external effects. See [guarantees](docs/architecture.md)
and [operations](docs/operations.md) before choosing a production provider.

## Install

Node 22+ is required for the Node example. ESM and TypeScript declarations are included.
Once a versioned beta is published, install it with:

```sh
npm install @pulse-compute/tick@beta
```

The npm bootstrap reserves version `0.0.0`; it does not create a `beta` dist-tag.
Until the first beta, use a private review tarball from the manual **Private Tick package artifact**
workflow, or build one from a clean committed checkout:

```sh
npm ci
npm run package:artifact -- --output pkg/preview
npm install /absolute/path/to/pulse-compute-tick-0.0.0.tgz
```

The development manifest stays `private: true`. Manual npm publishing prepares a separate
versioned tarball; see [release setup](docs/release.md).

## One job, one invocation

This Node example checks a page once in the latest eligible minute. It maps the logical
`state` binding to an existing Fastly KV store, injects the host clock/IDs/timers, and
logs the HTTP result. Set `FASTLY_KV_STORE_ID` and `FASTLY_API_TOKEN` in the environment,
then save this as `quickstart.mjs` and run `node quickstart.mjs` after installing Tick.
Use a fresh retained prefix; the token needs access to the selected KV store.

```js
import { randomUUID } from 'node:crypto';
import { createBindings } from '@pulse-compute/tick/bindings';
import { createRunner } from '@pulse-compute/tick/runner';

// Keep credentials in host bindings; the definition contains logical resource names.
const storeId = process.env.FASTLY_KV_STORE_ID;
const token = process.env.FASTLY_API_TOKEN;
if (!storeId || !token) throw new Error('Set FASTLY_KV_STORE_ID and FASTLY_API_TOKEN');

const runner = createRunner({
  contractVersion: 1,
  namespace: 'quickstart',
  bindings: createBindings({
    coordination: { name: 'state', prefix: 'quickstart/jobs/' },
    stores: { state: { kind: 'fastly-kv-http', options: {
      storeId, token: async () => token,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(2_000) }),
    } } },
    clock: { nowMs: Date.now, monotonicMs: () => performance.now() },
    ids: { newAttemptToken: randomUUID, newMutationId: randomUUID },
    resources: { target: 'https://example.com/' },
  }),
  limits: {
    maxJobsPerTick: 1, maxAttemptsPerRun: 3, leaseMs: 6_000,
    runTimeoutMs: 30_000, retryDelayMs: 1_000,
    maxClockSkewMs: 1_000, deadlineSafetyMs: 500,
  },
  jobs: [{
    id: 'homepage',
    schedule: { kind: 'interval', anchorMs: 0, everyMs: 60_000,
      revision: 'v1', missedWindows: 'skip' },
    async execute(context, resources) {
      const response = await fetch(resources.target, {
        signal: AbortSignal.any([context.transportSignal, AbortSignal.timeout(2_000)]),
        redirect: 'manual', cache: 'no-store',
      });
      await response.body?.cancel();
      if (!context.signal.aborted) console.log({ run: context.run.id, httpStatus: response.status });
    },
  }],
}, {
  createCancellationController() {
    const controller = new AbortController();
    return { signal: controller.signal, nativeSignal: controller.signal,
      abort: () => controller.abort() };
  },
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

// One bounded invocation. An external request/probe calls this again when needed.
const result = await runner.tick({ requestId: randomUUID(),
  deadlineMs: Date.now() + 8_000, signal: AbortSignal.timeout(8_000) });
console.log(result);
```

The same logical interval is skipped after settlement; retries can occur on a later
trigger. KV failures decline execution. A transport failure retries; an HTTP 503 is
logged as a completed observation. Keep externally visible effects idempotent using
`context.run.id`; the example does not persist observation history.

Replace the `state` mapping with `{ kind: 'provided', store: yourConditionalStore }` or
an explicit `s3-http` mapping, and put application dependencies in `resources`.
Coordination state and observations can use different stores. See [binding configuration](docs/bindings.md).

For a practical authenticated endpoint with KV admission, S3 snapshots and Node/Fastly
hosts, use the [HTTP monitor application](https://github.com/pulse-compute/tick/tree/main/apps/http-monitor).
On Fastly, bind the host transport, backend timeouts and cooperative cancellation
explicitly; the Node host code above uses native Node APIs. Native Fastly JS KV is not a
supported lossless-revision adapter; the current KV mapping uses the explicit HTTP API.

## Public exports

| Import | Purpose |
| --- | --- |
| `@pulse-compute/tick` | Contract version and TypeScript interfaces |
| `@pulse-compute/tick/bindings` | Logical coordination/resource mappings |
| `@pulse-compute/tick/runner` | Bounded sequential execution |
| `@pulse-compute/tick/core` | Claims, settlement and reconciliation |
| `@pulse-compute/tick/cancellation` | Cooperative cancellation controller |
| `@pulse-compute/tick/adapters/fastly-trigger` | Authentication and admission before scanning jobs |
| `@pulse-compute/tick/adapters/fastly-kv` | Conditional KV HTTP adapter candidate |
| `@pulse-compute/tick/adapters/s3` | Conditional S3 HTTP adapter candidate; host supplies signing |
| `@pulse-compute/tick/testing/conformance` | Bounded isolated adapter checks |

## Develop and validate

```sh
npm ci
npm run check                   # full local tests, packed imports/types and Node smoke
npm run build                   # ESM and declarations in dist/
npm run monitor:node            # practical app; see its setup guide first
npm run proof:build             # Fastly receiver Wasm
npm run proof:kv:build
npm run proof:trigger:build
npm run proof:s3:build
npm run monitor:guest:build
```

PR checks run on Node 22 and 24 without compiling Wasm. Main and manual artifact/publish
workflows also compile all five guests. Tests use isolated local fixtures and do not
provision or deploy provider resources. The packed artifact contains modules, declarations
and usage/contract notes; application, proof, credentials and development tools stay out.

## Documentation

- [Architecture](docs/architecture.md), [core](docs/core.md) and [execution](docs/execution.md): ownership, budgets, recovery and effects.
- [Bindings](docs/bindings.md), [Fastly KV](docs/fastly-kv.md) and [S3](docs/s3.md): dependency mapping and explicit transports.
- [Trigger admission](docs/trigger.md): authentication, scan bounds and duplicate amplification.
- [Conformance](docs/conformance.md) and [operations](docs/operations.md): isolated checks, failure outcomes and retained state.
- [Manual npm publishing](docs/release.md): setup, dry runs and versioned tarballs.
- [Roadmap and proof status](https://github.com/pulse-compute/tick/blob/main/docs/roadmap.md): implemented work and remaining live gates.
- [Examples](https://github.com/pulse-compute/tick/tree/main/examples) and [contributor rules](https://github.com/pulse-compute/tick/blob/main/AGENTS.md).
