// Actual Wasm guest against a local HTTP API fixture. Not native KV or deployed evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProof } from './scenarios.mjs';
import { settings } from './src/settings.js';

if (process.argv.length !== 4 || process.argv[2] !== '--viceroy') throw new Error('Usage: smoke.mjs --viceroy /path/to/viceroy');
const probeToken = randomBytes(32).toString('base64url');
const apiToken = randomBytes(32).toString('base64url');
const directory = await mkdtemp(join(tmpdir(), 'tick02-guest-'));
const rows = new Map();
let generation = 9007199254740993n;
let apiCalls = 0;
const api = createServer(async (request, response) => {
  // Local backend readiness traffic is separate from authenticated KV operations.
  if (request.method === 'GET' && request.url === '/' && !request.headers['fastly-key']) {
    response.writeHead(200).end(); return;
  }
  apiCalls++;
  try {
    assert.equal(request.headers['fastly-key'], apiToken);
    const url = new URL(request.url, 'http://fixture');
    assert.ok(url.pathname.startsWith(`/resources/stores/kv/${settings.storeId}/keys/`));
    const key = decodeURIComponent(url.pathname.split('/keys/')[1]);
    assert.ok(key.startsWith(`tick02/${settings.experiment}/`));
    if (request.method === 'GET') {
      const row = rows.get(key);
      if (!row) { response.writeHead(404).end(); return; }
      response.writeHead(200, { generation: row.revision, 'content-type': 'application/json' }).end(row.body);
      return;
    }
    assert.equal(request.method, 'PUT');
    let body = '';
    for await (const chunk of request) { body += chunk; assert.ok(body.length <= 4096); }
    const current = rows.get(key);
    const expected = request.headers['if-generation-match'];
    assert.ok(url.search === '?add=true' || typeof expected === 'string', 'fixture refuses unconditional writes');
    if ((url.search === '?add=true' && current) || (expected !== undefined && current?.revision !== expected)) {
      response.writeHead(412).end(); return;
    }
    rows.set(key, { body, revision: String(++generation) });
    response.writeHead(200).end();
  } catch { response.writeHead(500).end(); }
});
let guest;
let launchError = false;
try {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = 17677;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = join(directory, 'fastly.toml');
  await writeFile(config, `manifest_version = 3\nname = "tick02-local-fixture"\nlanguage = "javascript"\n
[local_server.backends.fastly_api]\nurl = "http://127.0.0.1:${api.address().port}"\n
[[local_server.secret_stores.tick02_secrets]]\nkey = "probe-token"\nenv = "TICK_PROBE_TOKEN"\n
[[local_server.secret_stores.tick02_secrets]]\nkey = "fastly-api-token"\nenv = "TICK02_FASTLY_API_TOKEN"\n`);
  guest = spawn(process.argv[3], ['-C', config, '--addr', `127.0.0.1:${port}`, resolve('proof/kv/bin/main.wasm')], {
    env: { ...process.env, TICK_PROBE_TOKEN: probeToken, TICK02_FASTLY_API_TOKEN: apiToken }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  guest.on('error', () => { launchError = true; });
  guest.stdout.on('data', () => {});
  guest.stderr.on('data', () => {});
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (launchError || guest.exitCode !== null) throw new Error('Viceroy failed to start');
    try {
      const response = await fetch(`${baseUrl}/__tick/kv`, { signal: AbortSignal.timeout(1000) });
      ready = response.status === 405;
      await response.body?.cancel();
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Viceroy readiness budget exhausted');
  const send = async (path, body, token = probeToken, method = 'POST') => {
    const response = await fetch(baseUrl + path, { method, headers: { 'x-tick-probe-token': token,
      'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(7000) });
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = { status: response.status, body: await response.json() };
    return result;
  };
  const request = { experiment: settings.experiment, operation: 'read', key: `tick02/${settings.experiment}/missing` };
  assert.equal((await send('/__tick/kv', request, '')).status, 401);
  assert.equal((await send('/__tick/kv', request, 'x'.repeat(40))).status, 401);
  assert.equal((await send('/__tick/kv', undefined, probeToken, 'GET')).status, 405);
  assert.equal((await send('/wrong', request)).status, 404);
  assert.equal((await send('/__tick/kv?x=1', request)).status, 400);
  assert.equal(apiCalls, 0);
  const report = await runProof({ experiment: settings.experiment, mode: 'synthetic', pollDelayMs: 0,
    call: async (body) => {
      const response = await send('/__tick/kv', body);
      assert.equal(response.status, 200);
      return response.body;
    } });
  assert.ok(report.cases.every((c) => c.verdict === 'observed'), JSON.stringify(report.cases));
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.evidence.completeTrace, true);
  console.log(JSON.stringify({ schema: 'tick.kv.guest-smoke.v1', mode: 'synthetic', runtime: 'viceroy',
    passed: true, authAndRouting: [200, 401, 405, 404, 400], apiCalls, cases: report.cases,
    evidence: report.evidence, note: 'Actual Wasm guest and Secret Store/backend bindings against a local HTTP API fixture. No deployed/native KV evidence.' }, null, 2));
} finally {
  if (guest && guest.exitCode === null) {
    guest.kill('SIGTERM');
    await new Promise((resolve) => guest.once('exit', resolve));
  }
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
