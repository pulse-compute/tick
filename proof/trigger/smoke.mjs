// Real Fastly Wasm guest; atomic HTTP fixture. Does not certify deployed Fastly KV.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { settings } from './src/settings.js';

if (process.argv.length !== 4 || process.argv[2] !== '--viceroy') throw new Error('Usage: smoke.mjs --viceroy /path/to/viceroy');
const probeToken = randomBytes(32).toString('base64url'), apiToken = randomBytes(32).toString('base64url');
const directory = await mkdtemp(join(tmpdir(), 'tick05-guest-'));
const rows = new Map(), calls = [];
let revision = 9007199254740993n;
const api = createServer(async (request, response) => {
  if (request.url === '/' && !request.headers['fastly-key']) { response.writeHead(200).end(); return; }
  try {
    assert.equal(request.headers['fastly-key'], apiToken);
    const url = new URL(request.url, 'http://fixture');
    assert.ok(url.pathname.startsWith(`/resources/stores/kv/${settings.storeId}/keys/`));
    const key = decodeURIComponent(url.pathname.split('/keys/')[1]);
    assert.match(key, /^tick05\/(normal|lost|crash|timeout)\/(admission|jobs)\//);
    calls.push({ method: request.method, key });
    if (request.method === 'GET') {
      const row = rows.get(key);
      if (!row) { response.writeHead(404).end(); return; }
      response.writeHead(200, { generation: row.revision, 'content-type': 'application/json' }).end(row.body); return;
    }
    assert.equal(request.method, 'PUT');
    let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 16_384); }
    const current = rows.get(key), expected = request.headers['if-generation-match'];
    assert.ok(url.search === '?add=true' || typeof expected === 'string');
    if (url.search === '?add=true' ? !!current : current?.revision !== expected) { response.writeHead(412).end(); return; }
    rows.set(key, { body, revision: String(++revision) }); response.writeHead(200).end();
  } catch { response.writeHead(500).end(); }
});
let guest, launchError = false;
try {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = 17678, baseUrl = `http://127.0.0.1:${port}`;
  const config = join(directory, 'fastly.toml');
  await writeFile(config, `manifest_version = 3\nname = "tick05-local-fixture"\nlanguage = "javascript"\n
[local_server.backends.fastly_api]\nurl = "http://127.0.0.1:${api.address().port}"\n
[[local_server.secret_stores.tick05_secrets]]\nkey = "probe-token"\nenv = "TICK_PROBE_TOKEN"\n
[[local_server.secret_stores.tick05_secrets]]\nkey = "fastly-api-token"\nenv = "TICK05_FASTLY_API_TOKEN"\n`);
  guest = spawn(process.argv[3], ['-C', config, '--addr', `127.0.0.1:${port}`, resolve('proof/trigger/bin/main.wasm')], {
    env: { ...process.env, TICK_PROBE_TOKEN: probeToken, TICK05_FASTLY_API_TOKEN: apiToken }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  guest.on('error', () => { launchError = true; });
  guest.stdout.on('data', (value) => { output = (output + value).slice(-4_096); });
  guest.stderr.on('data', (value) => { output = (output + value).slice(-4_096); });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (launchError || guest.exitCode !== null) throw new Error('Viceroy failed to start');
    try { const response = await fetch(`${baseUrl}/__tick/run/normal`, { signal: AbortSignal.timeout(1_000) });
      ready = response.status === 401; await response.body?.cancel(); if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Guest readiness failed: ${output}`);
  const send = async (scenario, supplied = probeToken, method = 'GET', suffix = '') => {
    const response = await fetch(`${baseUrl}/__tick/run/${scenario}${suffix}`, { method,
      headers: { 'x-tick-probe-token': supplied }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    assert.match(response.headers.get('cache-control'), /no-store/);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await send('normal', '')).status, 401);
  assert.equal((await send('normal', 'x'.repeat(40))).status, 401);
  assert.equal((await send('normal', probeToken, 'POST')).status, 405);
  assert.equal((await send('normal', probeToken, 'GET', '?invalid=1')).status, 400);
  assert.equal(calls.length, 0);
  const burst = await Promise.all(Array.from({ length: 16 }, () => send('normal')));
  assert.equal(burst.every((row) => row.status === 200), true, JSON.stringify(burst));
  const winners = burst.filter((row) => row.body.admission?.status === 'owned');
  assert.equal(winners.length, 1);
  assert.equal(winners[0].body.metrics.visited, 4); assert.equal(winners[0].body.metrics.executions, 4);
  for (const row of burst.filter((row) => row.body.admission.status !== 'owned')) assert.equal(row.body.metrics.jobReads, 0);
  const normalCalls = calls.filter((call) => call.key.startsWith('tick05/normal/'));
  const lost = await send('lost');
  assert.equal(lost.status, 200); assert.equal(lost.body.metrics.admissionWrites, 3);
  assert.equal(lost.body.metrics.executions, 4);
  const seedAt = Date.now() - 4_000;
  const seed = (jobId, everyMs, key) => {
    const slot = Math.floor(seedAt / everyMs) * everyMs;
    const run = { id: JSON.stringify(['tick.run.v1', 'tick05-crash', jobId, 'v1', slot]),
      namespace: 'tick05-crash', jobId, scheduleRevision: 'v1', scheduledForMs: slot };
    rows.set(key, { revision: String(++revision), body: JSON.stringify({ contractVersion: 1, mutationId: 'crashed-mutation',
      run, attempt: 1, runDeadlineMs: seedAt + 10_000, state: 'leased', attemptToken: 'crashed-attempt', leaseExpiresAtMs: seedAt + 3_000 }) });
  };
  seed('trigger-admission', settings.gateEveryMs, 'tick05/crash/admission/["tick.job.v1","tick05-crash","trigger-admission"]');
  for (let index = 0; index < settings.jobCount; index++) seed(`job-${index}`, settings.jobEveryMs, `tick05/crash/jobs/["tick.job.v1","tick05-crash","job-${index}"]`);
  const crash = await send('crash');
  assert.equal(crash.status, 200); assert.equal(crash.body.admission.attempt, 2);
  assert.equal(crash.body.tick.results.every((row) => row.attempt === 2 && row.record.state === 'completed'), true);
  const timeout = await send('timeout');
  assert.equal(timeout.status, 503); assert.equal(timeout.body.tick.status, 'expired');
  assert.equal(timeout.body.metrics.executions, 1); assert.equal(timeout.body.cancellation, 'cooperative-only');
  assert.equal((await send('timeout')).body.metrics.jobReads, 0);
  console.log(JSON.stringify({ schema: 'tick.trigger.guest-smoke.v1', mode: 'synthetic', runtime: 'viceroy', passed: true,
    burst: { requests: 16, admittedSweeps: 1, visited: 4, executions: 4, apiCalls: normalCalls.length,
      admissionCalls: normalCalls.filter((call) => call.key.includes('/admission/')).length,
      jobCalls: normalCalls.filter((call) => call.key.includes('/jobs/')).length },
    cases: ['auth-routing', 'duplicate-burst', 'lost-admission-reply', 'crash-recovery', 'cooperative-timeout'],
    totalApiCalls: calls.length, distributed: false, verdict: 'inconclusive',
    note: 'Actual Wasm guest, HTTP KV adapter, cooperative timers and Secret Store against a local atomic HTTP fixture; no deployed/native KV evidence.' }, null, 2));
} finally {
  if (guest && guest.exitCode === null) { guest.kill('SIGTERM'); await new Promise((resolve) => guest.once('exit', resolve)); }
  api.closeAllConnections(); await new Promise((resolve) => api.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
