# Tick

Draft contracts for coordinated scheduling from unreliable triggers, independent of the
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

There is no scheduler or `createScheduler()` export yet. The adapter performs conditional
storage operations; it does not certify a store or enforce the ownership state machine.

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
clock, an ID source, optional telemetry, and typed application resources. Credentials and
host handles stay inside the adapter. See the [typechecked wiring example](examples/bindings.ts).

## Build and check

Node 22+ and npm are used for development:

```sh
npm ci
npm test                 # contracts, packed consumers, adapter and proof tests
npm run build            # ESM contract module + declarations in dist/
npm run proof:build      # existing Fastly receiver -> bin/main.wasm
npm run proof:smoke      # Node-only receiver smoke; synthetic evidence
npm run proof:kv:build   # separate KV proof guest -> proof/kv/bin/main.wasm
```

`fastly compute build` uses `proof:build` via `fastly.toml`. `npm pack` builds the package;
only `dist/`, this README, and the architecture/adapter notes are included. The package has **zero
runtime dependencies**; the Fastly SDK is only a development dependency for the proof.

## Read next

- [Architecture and guarantees](docs/architecture.md): identities, ownership, time, recovery.
- [Fastly KV adapter](docs/fastly-kv.md): explicit HTTP transport and native SDK limitation.
- [Coordination proof runbook](proof/kv/README.md): deployment, bounded cases, and evidence.
- [Ticket roadmap](docs/roadmap.md): scope, model/effort assignments, and proof gates.
- [Contributor rules](AGENTS.md): preserve the boundaries while implementing later tickets.
- [Fastly proof runbook](proof/README.md): deploy, capture, analyze, and tear down.
- [TICK-01 evidence status](proof/evidence/STATUS.md): local validation and missing live checks.

The contract intentionally promises no exactly-once execution, perpetual clock, automatic
side-effect rollback, or cross-key transaction. Conditional writes reject stale revisions;
applications must separately handle duplicate effects and external commit authority.
