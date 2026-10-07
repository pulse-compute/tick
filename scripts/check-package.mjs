// Exercise the packed artifact from an isolated consumer, not a source-path import.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'tick-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(metadata.private, true, 'Source stays private; manual publication uses a staged artifact');
  assert.deepEqual(metadata.dependencies ?? {}, {}, 'Contract package must not depend on Pulse, a provider SDK, or Node libraries');
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
  const files = packed.files.map((entry) => entry.path);
  for (const required of ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts',
    'dist/core.js', 'dist/core.d.ts', 'dist/internal/records.js', 'docs/core.md',
    'dist/runner.js', 'dist/runner.d.ts', 'docs/execution.md',
    'dist/cancellation.js', 'dist/cancellation.d.ts', 'docs/trigger.md',
    'dist/bindings.js', 'dist/bindings.d.ts', 'docs/bindings.md', 'docs/conformance.md',
    'dist/internal/bindings.js', 'dist/testing/conformance.js', 'dist/testing/conformance.d.ts',
    'dist/adapters/fastly-trigger.js', 'dist/adapters/fastly-trigger.d.ts',
    'dist/adapters/fastly-kv.js', 'dist/adapters/fastly-kv.d.ts', 'docs/architecture.md', 'docs/fastly-kv.md', 'dist/adapters/s3.js', 'dist/adapters/s3.d.ts', 'docs/s3.md', 'docs/operations.md', 'docs/release.md']) {
    assert.ok(files.includes(required), `Missing packed file: ${required}`);
  }
  assert.ok(files.every((path) => ['package.json', 'README.md', 'docs/architecture.md', 'docs/fastly-kv.md', 'docs/core.md', 'docs/execution.md', 'docs/trigger.md', 'docs/bindings.md', 'docs/conformance.md', 'docs/s3.md', 'docs/operations.md', 'docs/release.md'].includes(path) || path.startsWith('dist/')),
    'Proof tools, credentials, examples and dev dependencies must stay out of the package');
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--offline', join(directory, packed.filename)], consumer);
  await writeFile(join(consumer, 'smoke.mjs'), `import * as tick from '@pulse-compute/tick';
import { createFastlyKvStore } from '@pulse-compute/tick/adapters/fastly-kv';
import { createS3Store } from '@pulse-compute/tick/adapters/s3';
import { createJobCoordinator, latestSlot } from '@pulse-compute/tick/core';
import { createRunner, JobFailure } from '@pulse-compute/tick/runner';
import { createFastlyTrigger } from '@pulse-compute/tick/adapters/fastly-trigger';
import { createCooperativeController } from '@pulse-compute/tick/cancellation';
import { createBindings, createCoordinationBinding } from '@pulse-compute/tick/bindings';
import { runStoreConformance } from '@pulse-compute/tick/testing/conformance';
import assert from 'node:assert/strict';
assert.deepEqual(Object.keys(tick), ['TICK_CONTRACT_VERSION']);
assert.equal(tick.TICK_CONTRACT_VERSION, 1);
assert.equal(typeof createS3Store, 'function');
assert.equal(typeof createJobCoordinator, 'function');
assert.equal(typeof createRunner, 'function');
assert.equal(typeof createFastlyTrigger, 'function');
const controller = createCooperativeController();
controller.abort();
assert.equal(controller.signal.aborted, true);
assert.equal(controller.nativeSignal, undefined);
assert.equal(new JobFailure('permanent', 'invalid-target').disposition, 'permanent');
assert.equal(latestSlot({ kind: 'interval', anchorMs: 10, everyMs: 20, revision: 'v1', missedWindows: 'skip' }, 51), 50);
const store = createFastlyKvStore({ storeId: 'test', token: async () => 'test', fetch: async () => new Response(null, { status: 404 }) });
assert.deepEqual(await store.read('job'), { status: 'absent' });
const s3 = createS3Store({ endpoint: 'https://state.s3.us-east-1.amazonaws.com', fetch: async () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }) });
assert.deepEqual(await s3.read('missing'), { status: 'absent' });
const bindings = createBindings({ coordination: { name: 'state', prefix: 'jobs/' }, stores: { state: { kind: 'provided', store } },
  clock: { nowMs: () => 1000, monotonicMs: () => 0 }, ids: { newAttemptToken: () => 'attempt', newMutationId: () => 'mutation' }, resources: {} });
assert.equal(bindings.coordination.prefix, 'jobs/');
assert.equal(typeof createCoordinationBinding, 'function');
assert.equal(typeof runStoreConformance, 'function');
`);
  run(process.execPath, ['smoke.mjs'], consumer);
  // Execute the exact README code through an installed package against an atomic HTTP fixture.
  const quickstart = await readFile('examples/quickstart.mjs', 'utf8');
  const readme = await readFile('README.md', 'utf8');
  assert.equal(readme.match(/```js\n([\s\S]*?)\n```/)?.[1], quickstart.trimEnd(), 'README and runnable example drifted');
  await writeFile(join(consumer, 'quickstart.mjs'), quickstart);
  await writeFile(join(consumer, 'example-smoke.mjs'), `import assert from 'node:assert/strict';
import { atomicHttp } from ${JSON.stringify(new URL('../test/helpers/atomic-http.mjs', import.meta.url).href)};
const fixture = atomicHttp(), transport = fixture.transport();
let probes = 0;
process.env.FASTLY_KV_STORE_ID = 'test-store';
process.env.FASTLY_API_TOKEN = 'fixture-credential';
globalThis.fetch = async (url, init) => {
  assert.ok(init.signal instanceof AbortSignal);
  if (String(url) === 'https://example.com/') { probes++; return new Response(null, { status: 503 }); }
  return transport(url, init);
};
await import('./quickstart.mjs');
assert.equal(probes, 1);
assert.equal(fixture.rows.size, 1);
assert.equal([...fixture.rows.values()][0].value.state, 'completed');
`);
  run(process.execPath, ['example-smoke.mjs'], consumer);
  await writeFile(join(consumer, 'consumer.ts'), `import { TICK_CONTRACT_VERSION } from '@pulse-compute/tick';
import type { CoordinationStore, WriteResult } from '@pulse-compute/tick';
import { createFastlyKvStore } from '@pulse-compute/tick/adapters/fastly-kv';
import { createS3Store } from '@pulse-compute/tick/adapters/s3';
import type { S3Options } from '@pulse-compute/tick/adapters/s3';
import { createJobCoordinator } from '@pulse-compute/tick/core';
import type { CoordinatorOptions, JobCoordinator, OwnershipLease, PendingTransition } from '@pulse-compute/tick/core';
import { createRunner } from '@pulse-compute/tick/runner';
import type { ExecutionRuntime, Runner } from '@pulse-compute/tick/runner';
import { createFastlyTrigger } from '@pulse-compute/tick/adapters/fastly-trigger';
import type { FastlyTriggerOptions } from '@pulse-compute/tick/adapters/fastly-trigger';
import { createCooperativeController } from '@pulse-compute/tick/cancellation';
import { createBindings } from '@pulse-compute/tick/bindings';
import type { BindingOptions } from '@pulse-compute/tick/bindings';
import { runStoreConformance } from '@pulse-compute/tick/testing/conformance';
import type { ConformanceOptions, ConformanceReport } from '@pulse-compute/tick/testing/conformance';
import type { TickDefinition } from '@pulse-compute/tick';
declare const definition: TickDefinition<{ observations: unknown }>;
declare const runtime: ExecutionRuntime;
declare const bindingOptions: BindingOptions<{ observations: unknown }>;
const bindings: TickDefinition<{ observations: unknown }>['bindings'] = createBindings(bindingOptions);
declare const conformanceOptions: ConformanceOptions;
const conformance: Promise<ConformanceReport> = runStoreConformance(conformanceOptions);
const runner: Runner = createRunner(definition, runtime);
declare const triggerOptions: FastlyTriggerOptions<{ observations: unknown }>;
const receiver: (request: Request) => Promise<Response> = createFastlyTrigger(triggerOptions);
const cooperative = createCooperativeController();
// @ts-expect-error Cooperative notification is not a native fetch AbortSignal.
const native: AbortSignal = cooperative.signal;
// @ts-expect-error The host must explicitly bind cancellation and timers.
createRunner(definition);
declare const options: CoordinatorOptions;
const coordinator: JobCoordinator = createJobCoordinator(options);
declare const pending: PendingTransition;
// @ts-expect-error An uncertain transition cannot authorize execution or renewal.
const lease: OwnershipLease = pending;
declare const s3Options: S3Options;
const s3Adapter: CoordinationStore = createS3Store(s3Options);
const httpAdapter: CoordinationStore = createFastlyKvStore({ storeId: 'test', token: async () => 'test', fetch });
const version: 1 = TICK_CONTRACT_VERSION;
declare const adapter: CoordinationStore;
const result: Promise<WriteResult> = adapter.compareAndSwap({
  key: 'job', expected: { kind: 'absent' },
  // @ts-expect-error Runtime records must satisfy the contract, not arbitrary JSON.
  value: { state: 'running' }
});
void [version, result, httpAdapter, s3Adapter, coordinator, lease, runner, receiver, native, bindings, conformance];
`);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext',
    '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.ts'], consumer);
  console.log(`Packed ESM import and TypeScript consumer passed (${files.length} files; zero runtime dependencies).`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
