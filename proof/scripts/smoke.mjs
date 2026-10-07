// Start server and clients together so isolated execution environments can use loopback.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { runBurst } from './burst.mjs';
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--viceroy')) {
  throw new Error('Usage: smoke.mjs [--viceroy /path/to/viceroy]');
}
const token = randomBytes(32).toString('base64url');
const viceroy = args.length > 0;
const port = 17676;
const url = `http://127.0.0.1:${port}`;
const child = viceroy
  ? spawn(args[1], ['-C', 'fastly.toml', '--addr', `127.0.0.1:${port}`, 'bin/main.wasm'], {
    env: { ...process.env, TICK_PROBE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  : spawn(process.execPath, ['proof/scripts/local-server.mjs'], {
    env: { ...process.env, PORT: String(port), TICK_PROBE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
let launchError = false;
child.on('error', () => { launchError = true; });
// Drain output. Do not reprint engine/host diagnostics that could contain request data.
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
try {
  let ready = false;
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (launchError || child.exitCode !== null) throw new Error('Local server failed to start');
    try {
      const response = await fetch(`${url}/__tick/manual`, { signal: AbortSignal.timeout(1000) });
      ready = response.status === 401;
      await response.arrayBuffer();
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Local server did not become ready');
  const request = async (path, method, value) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: value ? { 'x-tick-probe-token': value } : {}, redirect: 'error',
    });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('surrogate-control'), /no-store/);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/__tick/manual', 'GET')).status, 401);
  assert.equal((await request('/__tick/manual', 'GET', 'b'.repeat(43))).status, 401);
  assert.equal((await request('/__tick/manual', 'POST', token)).status, 405);
  assert.equal((await request('/unknown', 'GET', token)).status, 404);
  const native = await request('/__tick/probe', 'GET', token);
  assert.equal(native.status, 200);
  assert.equal(native.body.source, 'healthcheck');
  const { summary } = await runBurst({ url, token, count: 100, concurrency: 20 });
  assert.equal(summary.successful, 100);
  assert.equal(summary.uniqueRequestIds, 100);
  console.log(JSON.stringify({ schema: 'tick.smoke.v1', mode: 'synthetic',
    runtime: viceroy ? 'viceroy' : 'node', passed: true,
    authAndRouting: [200, 401, 405, 404], burst: summary,
    note: 'Local guest/handler validation only; no native Fastly probe or idle evidence.',
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
