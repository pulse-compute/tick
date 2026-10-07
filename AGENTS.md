# Working on Tick

Tick is a standalone repository. Do not add dependencies on the Pulse monorepo.

## Scope and truth

- Read `docs/architecture.md` and the current ticket in `docs/roadmap.md` first.
- TICK-00 is a draft contract and package foundation. TICK-02 adds an explicit HTTP KV
  adapter candidate. TICK-03 adds an experimental per-job ownership core; TICK-04 adds a
  bounded runner with explicit host bindings. TICK-05 adds authenticated admission before
  job scanning; read `docs/trigger.md` before changing the receiver. There is no autonomous scheduling loop or
  supported native JavaScript KV adapter. Read `docs/core.md` and `docs/execution.md` before
  changing the core; deterministic tests do not clear the pending live gates.
- Read `docs/fastly-kv.md` before changing the adapter or coordination proof. Keep the
  HTTP API and native host paths distinct; preserve full revision strings end to end.
- TICK-06 adds logical mapping helpers, shared binding capture, and a bounded conformance
  harness. Read `docs/bindings.md` and `docs/conformance.md` before changing those APIs.
  Declaration checks perform no provider I/O. Conformance runs write only explicit fresh
  isolated keys, retain them, await all writes, and never certify a provider from a mode label.
- TICK-01's live gate remains inconclusive until deployed evidence meets its runbook.
  A passing mock, Viceroy run, or declaration check cannot close a production proof gate.
- TICK-02's coordination gate also remains inconclusive without deployed evidence.
- TICK-07 adds an explicit S3 HTTP candidate and signed proof guest. Read `docs/s3.md`
  and `proof/s3/README.md` before changes. Keep ETags opaque/quoted, capture exact write
  conditions before awaits, and preserve unknown outcomes. Signing is a host binding;
  disable transport retries, caching and redirects. S3 live evidence is still pending.
- TICK-08 adds `apps/http-monitor`, a public-export consumer with KV coordination and
  application-owned immutable S3 observations. Read its README before changes. Keep
  probe health failures separate from execution/storage failure; a saved first snapshot
  is recoverable across attempts, not exactly-once probing or an owner-fenced effect.
  The optional Pulse shim is a capability contract, not a tested Pulse SDK integration.
- TICK-09 records adversarial regressions, original monotonic timeline propagation and
  data-only record capture. Read `proof/hardening/REVIEW.md`, `docs/operations.md` and
  `docs/release.md` before changes. Implementation audit is not independent sign-off.
  Package artifact preparation must retain privacy, zero runtime dependencies, committed
  source hashes and a fresh output; no mode/manifest/local pass grants release authority.
- Keep changes within the named ticket. Do not add queues, cron syntax, workflow engines,
  dashboard UI, background daemons, or an Uptime Kuma port as incidental work.
- Package naming is provisional. Keep `private: true`; no publication/release is authorized
  by an ordinary implementation ticket. Do not merge a PR without the user's instruction.

## Invariants

- Require atomic create-if-absent and revision-conditional replacement per key. Never
  implement ownership with a read followed by an unconditional write.
- Keep logical run ID, attempt token, mutation ID, and storage revision distinct. Revisions
  are opaque strings, not JavaScript numbers or ordered downstream fencing tokens.
- Writes can be indeterminate. A transport timeout is not proof of conflict or failure.
- Leases and cooperative cancellation do not prevent physical overlap or undo side effects.
- Never claim atomic server-clock checks from a provider CAS primitive. Follow the documented
  clock assumptions and recovery rules; surface unsupported capabilities.
- Keep application resources separate from coordination state. No credentials in definitions,
  logs, examples, source, committed configuration, or packed files.
- Terminal coordination records are retained; deleting them can allow old triggers to run again.
- Telemetry is observational; it cannot grant ownership or decide application actions.
- The runner must not dispatch without a usable positive claim, loop on contention, or
  detach coordination writes. Job cancellation is cooperative; late job outcomes cannot settle.
- Admission and jobs use distinct prefixes and retained records. A gate lease does not
  authorize job execution. Preserve bounded per-request counters and scan rotation.
- Cooperative cancellation signals are not native fetch signals. Bind native transport
  cancellation explicitly where supported; otherwise use verified backend timeouts.

## Validation and delivery

- Run `npm test`: typechecked examples/rejection cases, packed ESM/TypeScript consumption,
  and the existing focused proof tests.
- Run `npm run proof:build` when changing the proof, Fastly build command, lockfile, or CI.
  Run `npm run proof:kv:build` when changing the KV adapter or its guest proof.
  Run `npm run proof:trigger:build` when changing the integrated trigger or its guest.
  Run `npm run proof:s3:build` when changing the S3 adapter, mapping, signer or guest.
  Use the Viceroy smoke runner when changing guest runtime behavior.
- Run `npm run test:monitor` for monitor changes (also included in `npm test`). Build
  `monitor:guest:build` and run its actual Viceroy smoke for guest/host behavior changes.
  Keep the app/signer out of the packed Tick artifact and verify isolated public imports.
- Preserve historical evidence as historical. Record new results separately and distinguish
  local validation from deployed observations. Do not rewrite a pending gate into a pass.
- Open a reviewable PR with the concrete changes, validation, and remaining proof limitations.
