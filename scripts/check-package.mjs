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
  assert.equal(metadata.private, true, 'Publishing stays disabled until a deliberate release decision');
  assert.deepEqual(metadata.dependencies ?? {}, {}, 'Contract package must not depend on Pulse, a provider SDK, or Node libraries');
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
  const files = packed.files.map((entry) => entry.path);
  for (const required of ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts',
    'dist/core.js', 'dist/core.d.ts', 'dist/internal/records.js', 'docs/core.md',
    'dist/runner.js', 'dist/runner.d.ts', 'docs/execution.md',
    'dist/adapters/fastly-kv.js', 'dist/adapters/fastly-kv.d.ts', 'docs/architecture.md', 'docs/fastly-kv.md']) {
    assert.ok(files.includes(required), `Missing packed file: ${required}`);
  }
  assert.ok(files.every((path) => ['package.json', 'README.md', 'docs/architecture.md', 'docs/fastly-kv.md', 'docs/core.md', 'docs/execution.md'].includes(path) || path.startsWith('dist/')),
    'Proof tools, credentials, examples and dev dependencies must stay out of the package');
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--offline', join(directory, packed.filename)], consumer);
  await writeFile(join(consumer, 'smoke.mjs'), `import * as tick from '@pulse-compute/tick';
import { createFastlyKvStore } from '@pulse-compute/tick/adapters/fastly-kv';
import { createJobCoordinator, latestSlot } from '@pulse-compute/tick/core';
import { createRunner, JobFailure } from '@pulse-compute/tick/runner';
import assert from 'node:assert/strict';
assert.deepEqual(Object.keys(tick), ['TICK_CONTRACT_VERSION']);
assert.equal(tick.TICK_CONTRACT_VERSION, 1);
assert.equal(typeof createJobCoordinator, 'function');
assert.equal(typeof createRunner, 'function');
assert.equal(new JobFailure('permanent', 'invalid-target').disposition, 'permanent');
assert.equal(latestSlot({ kind: 'interval', anchorMs: 10, everyMs: 20, revision: 'v1', missedWindows: 'skip' }, 51), 50);
const store = createFastlyKvStore({ storeId: 'test', token: async () => 'test', fetch: async () => new Response(null, { status: 404 }) });
assert.deepEqual(await store.read('job'), { status: 'absent' });
`);
  run(process.execPath, ['smoke.mjs'], consumer);
  await writeFile(join(consumer, 'consumer.ts'), `import { TICK_CONTRACT_VERSION } from '@pulse-compute/tick';
import type { CoordinationStore, WriteResult } from '@pulse-compute/tick';
import { createFastlyKvStore } from '@pulse-compute/tick/adapters/fastly-kv';
import { createJobCoordinator } from '@pulse-compute/tick/core';
import type { CoordinatorOptions, JobCoordinator, OwnershipLease, PendingTransition } from '@pulse-compute/tick/core';
import { createRunner } from '@pulse-compute/tick/runner';
import type { ExecutionRuntime, Runner } from '@pulse-compute/tick/runner';
import type { TickDefinition } from '@pulse-compute/tick';
declare const definition: TickDefinition<{ observations: unknown }>;
declare const runtime: ExecutionRuntime;
const runner: Runner = createRunner(definition, runtime);
// @ts-expect-error The host must explicitly bind cancellation and timers.
createRunner(definition);
declare const options: CoordinatorOptions;
const coordinator: JobCoordinator = createJobCoordinator(options);
declare const pending: PendingTransition;
// @ts-expect-error An uncertain transition cannot authorize execution or renewal.
const lease: OwnershipLease = pending;
const httpAdapter: CoordinationStore = createFastlyKvStore({ storeId: 'test', token: async () => 'test', fetch });
const version: 1 = TICK_CONTRACT_VERSION;
declare const adapter: CoordinationStore;
const result: Promise<WriteResult> = adapter.compareAndSwap({
  key: 'job', expected: { kind: 'absent' },
  // @ts-expect-error Runtime records must satisfy the contract, not arbitrary JSON.
  value: { state: 'running' }
});
void [version, result, httpAdapter, coordinator, lease, runner];
`);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext',
    '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.ts'], consumer);
  console.log(`Packed ESM import and TypeScript consumer passed (${files.length} files; zero runtime dependencies).`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
