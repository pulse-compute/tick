// Compile and invoke copied application sources outside this repo using the packed package.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'tick08-standalone-')), root = process.cwd();
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
  assert.ok(packed.files.every((file) => !file.path.startsWith('apps/')), 'Consumer application stays outside the Tick package');
  const consumer = join(directory, 'consumer'); await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await cp('apps/http-monitor/src', join(consumer, 'src'), { recursive: true });
  await cp('apps/http-monitor/node.mjs', join(consumer, 'node.mjs')); await cp('apps/http-monitor/settings.mjs', join(consumer, 'settings.mjs'));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(directory, packed.filename)], consumer);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--strict', '--exactOptionalPropertyTypes', '--noUncheckedIndexedAccess',
    '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', '--rootDir', 'src', '--outDir', 'build',
    'src/app.ts', 'src/monitor.ts', 'src/resources.ts', 'src/sigv4.ts'], consumer);
  await writeFile(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
import { createMonitorApp } from './build/app.js';
import { createHttpProbe, createS3Observations } from './build/resources.js';
import { settings } from './settings.mjs';
const rows = new Map(), snapshots = new Map(); let probes = 0, generation = 9007199254740993n, id = 0;
const kv = async (url, init) => {
  const target = new URL(url), key = decodeURIComponent(target.pathname.split('/keys/')[1]), current = rows.get(key);
  if (init.method === 'GET') return current ? new Response(current.body, { headers: { generation: current.revision } }) : new Response(null, { status: 404 });
  const absent = target.search === '?add=true', revision = init.headers.get('if-generation-match');
  assert.ok(absent || revision); if (absent ? !!current : current?.revision !== revision) return new Response(null, { status: 412 });
  rows.set(key, { body: init.body, revision: String(++generation) }); return new Response();
};
const s3 = async (url, init) => {
  if (init.method === 'GET') return snapshots.has(url) ? new Response(snapshots.get(url)) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  assert.equal(init.headers.get('if-none-match'), '*'); if (snapshots.has(url)) return new Response(null, { status: 412 });
  snapshots.set(url, init.body); return new Response();
};
const app = createMonitorApp(settings.monitor, {
  kv: { storeId: 'isolated', token: async () => 'fixture-credential', fetch: kv },
  clock: { nowMs: () => 1000, monotonicMs: () => performance.now() }, ids: { newAttemptToken: () => 'attempt-' + ++id, newMutationId: () => 'mutation-' + ++id },
  runtime: { createCancellationController() { const c = new AbortController(); return { signal: c.signal, nativeSignal: c.signal, abort: () => c.abort() }; },
    setTimer(fn, ms) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } },
  resources: { probe: createHttpProbe({ target: 'https://target.example/health', fetch: async () => { probes++; return new Response(null, { status: 503 }); } }),
    observations: createS3Observations({ endpoint: 'https://observations.example', prefix: 'observations/', fetch: s3 }) },
  loadToken: async () => 'x'.repeat(40), requestId: () => 'request-' + ++id,
});
const request = () => new Request('https://receiver.example/__tick/run', { headers: { 'x-tick-probe-token': 'x'.repeat(40) } });
const first = await app.handle(request()); assert.equal(first.status, 200); assert.equal((await first.json()).tick.results[0].record.state, 'completed');
assert.equal((await app.handle(request())).status, 200); assert.equal(probes, 1); assert.equal(snapshots.size, 1);
const saved = JSON.parse([...snapshots.values()][0]); assert.equal(saved.outcome, 'down'); assert.equal(saved.httpStatus, 503);
`);
  run(process.execPath, ['smoke.mjs'], consumer);
  const dependencies = JSON.parse(run('npm', ['ls', '--all', '--json'], consumer));
  assert.deepEqual(Object.keys(dependencies.dependencies), ['@pulse-compute/tick']);
  assert.deepEqual(dependencies.dependencies['@pulse-compute/tick'].dependencies ?? {}, {});
  console.log(JSON.stringify({ schema: 'tick.monitor.standalone.v1', passed: true, mode: 'synthetic',
    installed: '@pulse-compute/tick@0.0.0', pulseDependencies: 0, providerSdkDependencies: 0, probes: 1, retainedObservations: 1,
    note: 'Copied TypeScript sources compiled and ran with only the offline packed Tick package in an isolated consumer.' }));
} finally { await rm(directory, { recursive: true, force: true }); }
