// Actual Fastly Wasm guest and signed transport against a local atomic fixture, not AWS.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runS3Proof } from './scenarios.mjs';
import { settings } from './src/settings.js';

if (process.argv.length !== 4 || process.argv[2] !== '--viceroy') throw new Error('Usage: smoke.mjs --viceroy /path/to/viceroy');
const token = randomBytes(32).toString('base64url'), accessId = randomBytes(10).toString('hex'), secretKey = randomBytes(32).toString('hex'), sessionToken = randomBytes(32).toString('base64url');
const directory = await mkdtemp(join(tmpdir(), 'tick07-guest-'));
const rows = new Map(), calls = []; let signatureFailures = 0;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const api = createServer(async (request, response) => {
  if (request.url === '/' && !request.headers.authorization) { response.writeHead(200).end(); return; }
  try {
    const url = new URL(request.url, settings.endpoint), key = decodeURIComponent(url.pathname.slice(1));
    assert.ok(key.startsWith(`tick07/${settings.cohort}/`)); assert.equal(url.search, '');
    let body = ''; for await (const chunk of request) { body += chunk; assert.ok(Buffer.byteLength(body) <= 16384); }
    // Independent Node HMAC verifier checks the wire path, host, condition, session and body.
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+),SignedHeaders=([^,]+),Signature=([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    assert.ok(match); assert.equal(match[1], accessId);
    const [date, region, service, terminal] = match[2].split('/');
    assert.equal(region, settings.region); assert.equal(service, 's3'); assert.equal(terminal, 'aws4_request');
    assert.equal(request.headers['x-amz-security-token'], sessionToken); assert.equal(request.headers['x-amz-content-sha256'], sha(body));
    assert.equal(request.headers.host, new URL(settings.endpoint).host);
    const names = match[3].split(';'); assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes('x-amz-security-token')); assert.ok(names.includes('host'));
    if (request.method === 'PUT') assert.ok(names.includes('if-match') || names.includes('if-none-match'));
    const canonical = [request.method, url.pathname, '', names.map((name) => `${name}:${request.headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''), match[3], sha(body)].join('\n');
    let signingKey = hmac('AWS4' + secretKey, date);
    for (const part of [region, service, terminal]) signingKey = hmac(signingKey, part);
    assert.equal(hmac(signingKey, `AWS4-HMAC-SHA256\n${request.headers['x-amz-date']}\n${match[2]}\n${sha(canonical)}`).toString('hex'), match[4]);
    calls.push({ method: request.method, key });
    const headers = { 'x-amz-request-id': `fixture-${calls.length}`, 'x-amz-id-2': 'local-fixture-id', 'content-type': 'application/xml' };
    const error = (code, status) => response.writeHead(status, headers).end(`<Error><Code>${code}</Code><Message>fixture</Message></Error>`);
    const current = rows.get(key);
    if (request.method === 'GET') {
      if (!current) return error('NoSuchKey', 404);
      response.writeHead(200, { ...headers, 'content-type': 'application/json', etag: current.revision }).end(current.body); return;
    }
    assert.equal(request.method, 'PUT');
    const absent = request.headers['if-none-match'] === '*', revision = request.headers['if-match'];
    assert.ok(absent !== !!revision);
    if (!absent && !current) return error('NoSuchKey', 404);
    if (absent ? !!current : current.revision !== revision) return error('PreconditionFailed', 412);
    const next = { body, revision: '"' + createHash('md5').update(body).digest('hex') + '"' };
    rows.set(key, next); response.writeHead(200, { ...headers, etag: next.revision }).end();
  } catch { signatureFailures++; response.writeHead(500).end(); }
});
let guest, launchError = false;
try {
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = 17679, target = `http://127.0.0.1:${port}/__tick/s3`, config = join(directory, 'fastly.toml');
  await writeFile(config, `manifest_version = 3\nname = "tick07-local-fixture"\nlanguage = "javascript"\n
[local_server.backends.s3]\nurl = "http://127.0.0.1:${api.address().port}"\n
[[local_server.secret_stores.tick07_secrets]]\nkey = "probe-token"\nenv = "TICK_PROBE_TOKEN"\n
[[local_server.secret_stores.tick07_secrets]]\nkey = "aws-access-key-id"\nenv = "TICK07_AWS_ACCESS_KEY_ID"\n
[[local_server.secret_stores.tick07_secrets]]\nkey = "aws-secret-access-key"\nenv = "TICK07_AWS_SECRET_ACCESS_KEY"\n
[[local_server.secret_stores.tick07_secrets]]\nkey = "aws-session-token"\nenv = "TICK07_AWS_SESSION_TOKEN"\n`);
  guest = spawn(process.argv[3], ['-C', config, '--addr', `127.0.0.1:${port}`, resolve('proof/s3/bin/main.wasm')], {
    env: { ...process.env, TICK_PROBE_TOKEN: token, TICK07_AWS_ACCESS_KEY_ID: accessId, TICK07_AWS_SECRET_ACCESS_KEY: secretKey, TICK07_AWS_SESSION_TOKEN: sessionToken }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  guest.on('error', () => { launchError = true; }); guest.stdout.on('data', () => {}); guest.stderr.on('data', () => {});
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (launchError || guest.exitCode !== null) throw new Error('Viceroy failed to start');
    try { const response = await fetch(target, { signal: AbortSignal.timeout(1000) }); ready = response.status === 405; await response.body?.cancel(); if (ready) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Guest readiness budget exhausted');
  const send = async (body, supplied = token, method = 'POST', url = target) => {
    const response = await fetch(url, { method, headers: { 'x-tick-probe-token': supplied, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(7000) });
    assert.match(response.headers.get('cache-control'), /no-store/); return { status: response.status, body: await response.json() };
  };
  const valid = { cohort: settings.cohort, operation: 'read', key: `tick07/${settings.cohort}/missing` };
  assert.equal((await send(valid, '')).status, 401); assert.equal((await send(valid, 'x'.repeat(40))).status, 401);
  assert.equal((await send(undefined, token, 'GET')).status, 405); assert.equal((await send(valid, token, 'POST', target + '?x=1')).status, 400);
  assert.equal((await send({ ...valid, key: 'application/key' })).status, 400); assert.equal(calls.length, 0);
  const report = await runS3Proof({ cohort: settings.cohort, contenders: 4, mode: 'synthetic', call: async (body) => {
    const response = await send(body); assert.equal(response.status, 200, JSON.stringify(response)); return response.body;
  } });
  assert.equal(signatureFailures, 0, 'All signed wire requests must verify independently');
  assert.equal(report.conformance.status, 'observed', JSON.stringify(report)); assert.ok(report.cases.every((c) => c.status === 'observed'));
  assert.equal(report.evidence.completeTrace, true); assert.equal(report.status, 'inconclusive'); assert.equal(rows.size, 5);
  console.log(JSON.stringify({ schema: 'tick.s3.guest-smoke.v1', mode: 'synthetic', runtime: 'viceroy', passed: true,
    signatureVerification: 'Independent Node HMAC verification of each guest request including session token, conditions, host, path and payload',
    authAndRouting: [200, 401, 405, 400], providerCalls: calls.length, retainedKeys: rows.size,
    conformance: report.conformance, cases: report.cases, evidence: report.evidence, status: report.status, certified: false,
    note: 'Actual Wasm guest, Secret Store, WebCrypto SigV4 and fixed backend against a local atomic S3 fixture. No deployed AWS evidence.' }, null, 2));
} finally {
  if (guest && guest.exitCode === null) { guest.kill('SIGTERM'); await new Promise((resolve) => guest.once('exit', resolve)); }
  api.closeAllConnections(); await new Promise((resolve) => api.close(resolve)); await rm(directory, { recursive: true, force: true });
}
