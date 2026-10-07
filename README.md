# Tick

Experimental interval coordination from unreliable triggers, independent of the
Pulse monorepo. Package naming (`tick` or `fastly-tick`) remains provisional and publishing
is disabled.

## What exists

- **TICK-00:** TypeScript interfaces, explicit resource bindings, protocol rules, and an
  importable ESM package exporting `TICK_CONTRACT_VERSION` and declarations.
- **TICK-01:** A Fastly trigger proof with an authenticated receiver and evidence tools.
  The implementation is merged; **live trigger viability remains INCONCLUSIVE**.
- **TICK-02:** An explicit Fastly KV HTTP adapter and coordination proof harness.
  **Live coordination viability remains INCONCLUSIVE.** The pinned native JS SDK
  cannot supply a lossless generation round trip; see [the adapter notes](docs/fastly-kv.md).
- **TICK-03:** A per-job coordinator for anchored intervals, conditional claims, renewal,
  settlement, and ambiguous-write reconciliation, with deterministic adversarial tests.
- **TICK-04:** A bounded sequential runner with explicit runtime bindings, application
  failure policy, deadline/cancellation propagation, and recovery tests.
- **TICK-05:** An authenticated Fastly receiver with retained admission before job scanning,
  deterministic scan rotation, and duplicate-amplification evidence tools.
  **Live integration remains INCONCLUSIVE.**
- **TICK-06:** Shared runtime binding validation, explicit logical provider mappings,
  and a bounded adapter conformance suite with labeled fault bindings.
- **TICK-07:** An explicit S3 conditional-write adapter, `s3-http` mapping, and a signed
  Fastly conformance receiver covering lost replies and stale-owner rejection.
  **Live S3 coordination remains INCONCLUSIVE.**

The experimental core is exported from `@pulse-compute/tick/core` and the runner from
`@pulse-compute/tick/runner`. The experimental receiver is exported from
`@pulse-compute/tick/adapters/fastly-trigger`; applications can also invoke the runner directly.
Local tests establish state-machine behavior under the store contract; the deployed
trigger and storage gates remain open.

## Resource binding

The application supplies dependencies using logical names:

```ts
import type { CoordinationBinding } from '@pulse-compute/tick';

// `adapter` is supplied by the application. Its deployed semantics still need proof.
const coordination: CoordinationBinding = {
  name: 'scheduler-state',
  prefix: 'uptime/',
  store: adapter,
};
```

Coordination storage is separate from job resources: one application can coordinate through
KV and store observations in S3. The core takes an explicit conditional-write adapter, a
clock, and an ID source. The broader contract also declares optional telemetry and typed
application resources. The runner also accepts explicit host cancellation/timer bindings.
Credentials and host handles stay inside the adapter. See the typechecked [binding example](examples/bindings.ts),
[core example](examples/core.ts), [runner example](examples/runner.ts), and
[trigger example](examples/trigger.ts). The [provider mapping example](examples/provider-bindings.ts)
uses `@pulse-compute/tick/bindings` to map a logical name to a provided or explicit HTTP
adapter, preserve typed resources, and optionally check resource shape. Admission has its own logical binding/prefix;
individual jobs still require claims. Cancellation bindings distinguish cooperative
notification from optional native transport cancellation.

## Build and check

Node 22+ and npm are used for development:

```sh
npm ci
npm test                 # bindings, conformance, contracts, core, runner, trigger, adapters and proofs
npm run build            # ESM modules + declarations in dist/
npm run proof:build      # existing Fastly receiver -> bin/main.wasm
npm run proof:smoke      # Node-only receiver smoke; synthetic evidence
npm run proof:kv:build   # separate KV proof guest -> proof/kv/bin/main.wasm
npm run proof:trigger:build # integrated receiver -> proof/trigger/bin/main.wasm
npm run proof:trigger:burst # bounded reference comparison; synthetic evidence
npm run proof:s3:build   # signed S3 conformance guest -> proof/s3/bin/main.wasm
```

`fastly compute build` uses `proof:build` via `fastly.toml`. `npm pack` builds the package;
only `dist/`, this README, and the architecture/core/execution/adapter/trigger/binding/conformance notes are included. The package has **zero
runtime dependencies**; the Fastly SDK is only a development dependency for the proof.

## Read next

- [Architecture and guarantees](docs/architecture.md): identities, ownership, time, recovery.
- [Interval and ownership core](docs/core.md): API, bounded operations, receipts, and recovery.
- [Bounded execution](docs/execution.md): runtime bindings, retries, deadlines, and application effects.
- [Fastly trigger admission](docs/trigger.md): bounded sweeps, rotation, authentication, and counters.
- [Binding configuration](docs/bindings.md): logical mappings, resource guards, and runtime checks.
- [Adapter conformance](docs/conformance.md): framework-neutral cases on isolated retained keys.
- [Integration proof runbook](proof/trigger/README.md): compiled guest and burst evidence.
- [Fastly KV adapter](docs/fastly-kv.md): explicit HTTP transport and native SDK limitation.
- [S3 adapter](docs/s3.md): conditional PUT, opaque ETags and explicit signed transport.
- [S3 proof runbook](proof/s3/README.md): conformance, stale owners, SigV4 and evidence.
- [Coordination proof runbook](proof/kv/README.md): deployment, bounded cases, and evidence.
- [Ticket roadmap](docs/roadmap.md): scope, model/effort assignments, and proof gates.
- [Contributor rules](AGENTS.md): preserve the boundaries while implementing later tickets.
- [Fastly proof runbook](proof/README.md): deploy, capture, analyze, and tear down.
- [TICK-01 evidence status](proof/evidence/STATUS.md): local validation and missing live checks.

The contract intentionally promises no exactly-once execution, perpetual clock, automatic
side-effect rollback, or cross-key transaction. Conditional writes reject stale revisions;
applications must separately handle duplicate effects and external commit authority.
