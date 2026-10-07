# TICK-05 evidence status

**Live integration gate: INCONCLUSIVE.** TICK-01 trigger viability and TICK-02 deployed
coordination also remain inconclusive. No live Fastly request, deployment, activation,
resource creation, or production KV write was performed for this ticket.

## Executed locally — 2026-10-07 UTC

- `npm test` passed 127 tests: 32 core, 29 runner, 22 integration/evidence, 10 adapter,
  24 TICK-01 proof, and 10 TICK-02 proof tests. Typechecked examples/rejection cases
  and isolated packed ESM/TypeScript consumption passed (21 files; zero runtime dependencies).
- All three Fastly guests built using SDK 3.45.0 and TypeScript 5.9.3. Local Node was
  24.19.0; CI targets Node 22. The existing Node receiver smoke also passed.
- The [reference comparison](local-burst.json) sent 100 requests against 16 jobs in
  each configuration. Ungated runner: 1,600 visits, 16 executions, 3,167 store calls.
  Admitted receiver: one sweep, 16 visits/executions, 202 admission calls plus 64 job
  calls = 266 total. This is a **91.6% local storage-call reduction**. Incoming request
  count remains 100. The fixture's atomicity and concurrency ordering are test assumptions.
- The [actual Wasm guest](local-guest.json) passed in Viceroy 0.21.1 against a local
  atomic HTTP API fixture with full uint64 generation strings. Its 16-request burst
  admitted one four-job sweep: 23 admission calls plus 16 job calls = 39 API calls.
  Exact loser CAS counts vary with arrival ordering. The complete smoke made 86 calls,
  including lost-reply revalidation, seeded crashed leases, and cooperative timeout.
  This establishes neither deployed KV behavior nor a native platform crash observation.
- Integrated guest: 11,807,121 bytes; SHA-256
  `e418e59a8610879c2a22c310f8f28bcb78b63326779a13959351abe5adc762ff`.

The guest uses real host timers, Secret Store, and the explicit HTTP adapter. SDK 3.45.0
does not supply native AbortController/fetch cancellation. Cooperative cancellation stops
the runner's wait/scan and rejects late settlement; verified backend timeouts must bound
network I/O. None of these checks proves physical non-overlap or exactly-once effects.

## Remaining gate

Follow the [dedicated runbook](../README.md) with verified TLS, scoped credentials,
backend timeouts, and retained records. Measure native probe continuity and cross-POP
contention, correlate unique observations to complete backend operation traces/readback,
establish deployed CAS through TICK-02, and capture interrupted-invocation recovery.
Measure API latency, rate limits, probe/receiver lifetime, and actual amplification.
An isolated manual burst, a mode label, or Viceroy cannot establish these properties.

The bounded driver/analyzer deliberately reports **inconclusive** even for complete
multi-POP observations; excess fanout or duplicate owners fail the observed check.
Earlier TICK-01/02 evidence remains historical and unchanged.
