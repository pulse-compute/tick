# Working on Tick

Tick is a standalone repository. Do not add dependencies on the Pulse monorepo.

## Scope and truth

- Read `docs/architecture.md` and the current ticket in `docs/roadmap.md` first.
- TICK-00 is a draft contract and package foundation. TICK-02 adds an explicit HTTP KV
  adapter candidate. TICK-03 adds an experimental per-job ownership core; TICK-04 adds a
  bounded runner with explicit host bindings. There is no autonomous scheduling loop or
  supported native JavaScript KV adapter. Read `docs/core.md` and `docs/execution.md` before
  changing the core; deterministic tests do not clear the pending live gates.
- Read `docs/fastly-kv.md` before changing the adapter or coordination proof. Keep the
  HTTP API and native host paths distinct; preserve full revision strings end to end.
- TICK-01's live gate remains inconclusive until deployed evidence meets its runbook.
  A passing mock, Viceroy run, or declaration check cannot close a production proof gate.
- TICK-02's coordination gate also remains inconclusive without deployed evidence.
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

## Validation and delivery

- Run `npm test`: typechecked examples/rejection cases, packed ESM/TypeScript consumption,
  and the existing focused proof tests.
- Run `npm run proof:build` when changing the proof, Fastly build command, lockfile, or CI.
  Run `npm run proof:kv:build` when changing the KV adapter or its guest proof.
  Use the Viceroy smoke runner when changing guest runtime behavior.
- Preserve historical evidence as historical. Record new results separately and distinguish
  local validation from deployed observations. Do not rewrite a pending gate into a pass.
- Open a reviewable PR with the concrete changes, validation, and remaining proof limitations.
