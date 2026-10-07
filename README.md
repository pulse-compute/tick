# Tick

Experimental coordinated scheduling from unreliable triggers, independent of the Pulse monorepo.
The final package name (`tick` or `fastly-tick`) is undecided. Publishing is disabled.

## Current scope: TICK-01

This repository currently contains a **Fastly trigger viability proof**, not a scheduler.
It records authenticated healthcheck arrivals, measures gaps and duplicate trigger volume,
and separates native-route observations from manually generated requests.

- [Proof runbook](proof/README.md): local use, deployment, capture, experiments, teardown.
- [Evidence status](proof/evidence/STATUS.md): local results and outstanding live gates.
- [Example manifest](proof/fixtures/manifest.example.json): explicit experiment boundaries.

```sh
npm ci
npm test
npm run build
```

Build output: `bin/main.wasm`. Node 22+ is used for the tooling. The Fastly SDK is pinned
in the lockfile; the receiver itself runs in Fastly Compute, not Node.

The repository was empty when TICK-01 started. Only the scaffolding required for this proof
has been added. TICK-00's package/coordination contract, TICK-02's storage proof, and the
scheduler implementation remain separate work. No KV claims or exactly-once guarantees
are implemented here.
