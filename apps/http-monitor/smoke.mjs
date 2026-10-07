// Isolated backing domains. Real Wasm/app/SDK, fixture provider semantics only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { settings } from './settings.mjs';
import { observationKey } from './build/resources.js';
if (process.argv.length !== 4 || process.argv[2] !== '--viceroy') throw new Error('Usage: smoke.mjs --viceroy /path/to/viceroy');
const results = [];
const sha = (s) => createHash('sha256').update(s).digest('hex'), hmac = (key, s) => createHmac('sha256', key).update(s).digest();
for (const scenario of ['up-burst', 'down', 'unreachable', 'lost-save', 'crash-after-save', 'access-denied', 'kv-throttle', 'late-save']) {
  const token = randomBytes(32).toString('base64url'), apiToken = randomBytes(32).toString('base64url');
  const access = randomBytes(10).toString('hex'), secret = randomBytes(32).toString('hex'), session = randomBytes(32).toString('base64url');
  const directory = await mkdtemp(join(tmpdir(), 'tick08-guest-')), kv = new Map(), snapshots = new Map();
  let generation = 9007199254740993n, kvCalls = 0, s3Calls = 0, probes = 0, signatureFailures = 0, dropped = false, delayed = false, lateCommit, successorProbe, lateTimer;
  const committedLate = new Promise((resolve) => { lateCommit = resolve; });
  const successorProbing = new Promise((resolve) => { successorProbe = resolve; });
  const api = createServer(async (request, response) => {
    if (request.url === '/' && !request.headers['fastly-key']) { response.writeHead(200).end(); return; }
    kvCalls++;
    try {
      assert.equal(request.headers['fastly-key'], apiToken);
      if (scenario === 'kv-throttle') { response.writeHead(429).end(); return; }
      const url = new URL(request.url, 'http://fixture'), key = decodeURIComponent(url.pathname.split('/keys/')[1]);
      assert.ok(key.startsWith(settings.monitor.coordinationPrefix) || key.startsWith(settings.monitor.admissionPrefix));
      const current = kv.get(key);
      if (request.method === 'GET') {
        if (!current) { response.writeHead(404).end(); return; }
        response.writeHead(200, { generation: current.revision }).end(current.body); return;
      }
      assert.equal(request.method, 'PUT'); let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 16384); }
      const absent = url.search === '?add=true', expected = request.headers['if-generation-match']; assert.ok(absent || expected);
      if (absent ? !!current : current?.revision !== expected) { response.writeHead(412).end(); return; }
      kv.set(key, { body, revision: String(++generation) }); response.writeHead(200).end();
    } catch { response.writeHead(500).end(); }
  });
  const target = createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(200).end(); return; }
    probes++; assert.equal(request.url, '/health'); assert.equal(request.method, 'GET');
    if (scenario === 'unreachable') { request.socket.destroy(); return; }
    if (scenario === 'late-save' && probes === 2) { successorProbe(); await committedLate; response.writeHead(503).end(); return; }
    response.writeHead(scenario === 'down' ? 503 : 200, { 'content-type': 'text/plain' }).end('private-health-body');
  });
  const s3 = createServer(async (request, response) => {
    if (request.url === '/' && !request.headers.authorization) { response.writeHead(200).end(); return; }
    s3Calls++;
    try {
      const url = new URL(request.url, settings.s3Endpoint); assert.ok(url.pathname.startsWith('/' + settings.observationsPrefix)); assert.equal(url.search, '');
      let body = ''; for await (const chunk of request) { body += chunk; assert.ok(Buffer.byteLength(body) <= 4096); }
      const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+),SignedHeaders=([^,]+),Signature=([a-f0-9]{64})$/.exec(request.headers.authorization || '');
      assert.ok(auth); assert.equal(auth[1], access); assert.equal(request.headers.host, new URL(settings.s3Endpoint).host);
      assert.equal(request.headers['x-amz-security-token'], session); assert.equal(request.headers['x-amz-content-sha256'], sha(body));
      const [date, region, service, suffix] = auth[2].split('/'); assert.equal(region, settings.s3Region); assert.equal(service, 's3'); assert.equal(suffix, 'aws4_request');
      const names = auth[3].split(';'); assert.deepEqual(names, [...names].sort());
      if (request.method === 'PUT') { assert.ok(names.includes('if-none-match')); assert.equal(request.headers['if-none-match'], '*'); assert.equal(request.headers['if-match'], undefined); }
      const canonical = [request.method, url.pathname, '', names.map((name) => `${name}:${request.headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''), auth[3], sha(body)].join('\n');
      let key = hmac('AWS4' + secret, date); for (const part of [region, service, suffix]) key = hmac(key, part);
      assert.equal(hmac(key, `AWS4-HMAC-SHA256\n${request.headers['x-amz-date']}\n${auth[2]}\n${sha(canonical)}`).toString('hex'), auth[4]);
      if (request.method === 'GET') {
        if (scenario === 'access-denied') { response.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>'); return; }
        if (!snapshots.has(url.pathname)) { response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
        response.writeHead(200).end(snapshots.get(url.pathname)); return;
      }
      assert.equal(request.method, 'PUT');
      if (scenario === 'late-save' && !delayed) {
        delayed = true;
        // The provider has the full body; cancellation cannot retract a later commit.
        await new Promise((resolve) => {
          lateTimer = setTimeout(resolve, 18000); // Bounded fixture fallback, not an application retry timer.
          successorProbing.then(() => { clearTimeout(lateTimer); resolve(); });
        });
      }
      if (snapshots.has(url.pathname)) { response.writeHead(412).end(); return; }
      snapshots.set(url.pathname, body);
      if (scenario === 'late-save') lateCommit();
      if (scenario === 'lost-save' && !dropped) { dropped = true; request.socket.destroy(); return; } // Real commit, no HTTP reply.
      response.writeHead(200).end();
    } catch { signatureFailures++; response.writeHead(500).end(); }
  });
  let guest, launchError = false;
  try {
    await Promise.all([api, target, s3].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
    if (scenario === 'crash-after-save') {
      // Fresh domain fixture: old attempt saved S3 then disappeared with a retained expired KV lease.
      const now = Date.now(), started = now - 4000, slot = Math.floor(started / settings.monitor.schedule.everyMs) * settings.monitor.schedule.everyMs;
      const revision = settings.monitor.schedule.revision;
      const run = { id: JSON.stringify(['tick.run.v1', settings.monitor.namespace, settings.monitor.monitorId, revision, slot]),
        namespace: settings.monitor.namespace, jobId: settings.monitor.monitorId, scheduleRevision: revision, scheduledForMs: slot };
      kv.set(settings.monitor.coordinationPrefix + JSON.stringify(['tick.job.v1', settings.monitor.namespace, settings.monitor.monitorId]), {
        revision: String(++generation), body: JSON.stringify({ contractVersion: 1, mutationId: 'fixture-crashed-mutation', run,
          attempt: 1, state: 'leased', attemptToken: 'fixture-crashed-owner', leaseExpiresAtMs: now - 1000, runDeadlineMs: started + 30000 }) });
      snapshots.set('/' + observationKey(settings.observationsPrefix, run), JSON.stringify({ schema: 'tick.http.observation.v1', run, attempt: 1,
        startedAtMs: started, observedAtMs: started + 10, durationMs: 10, httpStatus: 200, outcome: 'up' }));
    }
    const config = join(directory, 'fastly.toml'), port = 17680, url = `http://127.0.0.1:${port}/__tick/run`;
    const secretEntries = [['probe-token', 'TICK08_PROBE_TOKEN'], ['fastly-api-token', 'TICK08_FASTLY_API_TOKEN'], ['aws-access-key-id', 'TICK08_AWS_ACCESS_KEY_ID'], ['aws-secret-access-key', 'TICK08_AWS_SECRET_ACCESS_KEY'], ['aws-session-token', 'TICK08_AWS_SESSION_TOKEN']];
    await writeFile(config, `manifest_version = 3\nname = "tick08-local-${scenario}"\nlanguage = "javascript"\n
[local_server.backends.fastly_api]\nurl = "http://127.0.0.1:${api.address().port}"\n
[local_server.backends.monitored]\nurl = "http://127.0.0.1:${target.address().port}"\n
[local_server.backends.observations]\nurl = "http://127.0.0.1:${s3.address().port}"\n
${secretEntries.map(([key, name]) => `[[local_server.secret_stores.tick08_secrets]]\nkey = "${key}"\nenv = "${name}"\n`).join('\n')}`);
    guest = spawn(process.argv[3], ['-C', config, '--addr', `127.0.0.1:${port}`, resolve('apps/http-monitor/bin/main.wasm')], {
      env: { ...process.env, TICK08_PROBE_TOKEN: token, TICK08_FASTLY_API_TOKEN: apiToken, TICK08_AWS_ACCESS_KEY_ID: access, TICK08_AWS_SECRET_ACCESS_KEY: secret, TICK08_AWS_SESSION_TOKEN: session }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    guest.on('error', () => { launchError = true; }); guest.stdout.on('data', () => {}); guest.stderr.on('data', () => {});
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (launchError || guest.exitCode !== null) throw new Error('Viceroy failed to start');
      try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); ready = r.status === 401; await r.body?.cancel(); if (ready) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Readiness budget exhausted');
    const send = async (supplied = token, suffix = '') => {
      const r = await fetch(url + suffix, { headers: { 'x-tick-probe-token': supplied }, signal: AbortSignal.timeout(12000) });
      assert.match(r.headers.get('cache-control'), /no-store/); return { status: r.status, body: await r.json() };
    };
    assert.equal((await send('')).status, 401); assert.equal((await send('x'.repeat(40))).status, 401); assert.equal((await send(token, '?x=1')).status, 400);
    assert.equal(kvCalls + s3Calls + probes, 0);
    // Keep the duplicate burst within one admission window, independent of launch timing.
    if (scenario === 'up-burst') {
      const remaining = settings.monitor.admissionSchedule.everyMs - Date.now() % settings.monitor.admissionSchedule.everyMs;
      if (remaining < 2500) await new Promise((resolve) => setTimeout(resolve, remaining + 100));
    }
    const requests = scenario === 'up-burst' ? 16 : 1;
    const replies = await Promise.all(Array.from({ length: requests }, () => send()));
    if (scenario === 'kv-throttle') {
      assert.equal(replies[0].status, 503); assert.equal(replies[0].body.admission.status, 'unavailable');
      assert.equal(replies[0].body.metrics.jobReads, 0); assert.equal(probes + s3Calls, 0);
      results.push({ scenario, passed: true, requests, probes, kvCalls, s3Calls, snapshots: snapshots.size, admission: 'unavailable' });
      continue;
    }
    assert.ok(replies.every((r) => r.status === (scenario === 'late-save' ? 503 : 200)), JSON.stringify(replies));
    const winner = replies.find((r) => r.body.admission?.status === 'owned'); assert.ok(winner);
    let job = winner.body.tick.results[0];
    if (scenario === 'late-save') {
      assert.ok(['deadline-exceeded', 'cancelled'].includes(job.outcome)); assert.equal(job.coordination, 'expired');
      const expiry = Math.max(...[...kv.values()].map((row) => JSON.parse(row.body)).filter((value) => value.state === 'leased').map((value) => value.leaseExpiresAtMs));
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, expiry + settings.monitor.limits.maxClockSkewMs + 100 - Date.now())));
      const recovered = await send(); assert.equal(recovered.status, 200); job = recovered.body.tick.results[0]; assert.equal(job.attempt, 2);
    }
    if (scenario === 'lost-save') {
      assert.equal(job.outcome, 'retry'); assert.equal(job.failureCode, 'observation-indeterminate');
      const wait = Math.max(1100, winner.body.admission.scheduledForMs + settings.monitor.admissionSchedule.everyMs + 100 - Date.now());
      await new Promise((resolve) => setTimeout(resolve, wait));
      const recovered = await send(); assert.equal(recovered.status, 200); job = recovered.body.tick.results[0]; assert.equal(job.attempt, 2);
    }
    if (scenario === 'access-denied') {
      assert.equal(job.outcome, 'retry'); assert.equal(job.failureCode, 'observation-unavailable'); assert.equal(job.record.state, 'retryable');
      assert.equal(probes, 0); assert.equal(snapshots.size, 0); assert.equal(signatureFailures, 0);
      results.push({ scenario, passed: true, requests, probes, kvCalls, s3Calls, snapshots: 0, outcome: 'retry', recordState: 'retryable' });
      continue;
    }
    assert.equal(job.record.state, 'completed'); assert.equal(snapshots.size, 1); assert.equal(signatureFailures, 0);
    const saved = JSON.parse([...snapshots.values()][0]); assert.equal(saved.outcome, scenario === 'down' ? 'down' : scenario === 'unreachable' ? 'unreachable' : 'up');
    assert.equal(JSON.stringify(saved).includes('private-health-body'), false); assert.equal(JSON.stringify(saved).includes(settings.target), false);
    assert.equal(probes, scenario === 'crash-after-save' ? 0 : scenario === 'late-save' ? 2 : 1);
    if (scenario === 'late-save') { assert.equal(saved.attempt, 1); assert.equal(saved.httpStatus, 200); }
    if (scenario === 'crash-after-save') { assert.equal(job.attempt, 2); assert.equal(saved.attempt, 1); }
    if (scenario === 'up-burst') { assert.equal(replies.filter((r) => r.body.admission.status === 'owned').length, 1);
      assert.ok(replies.filter((r) => r.body.admission.status !== 'owned').every((r) => r.body.metrics.jobReads === 0)); }
    results.push({ scenario, passed: true, requests: requests + (['lost-save', 'late-save'].includes(scenario) ? 1 : 0), probes, kvCalls, s3Calls, snapshots: snapshots.size, outcome: saved.outcome, completedAttempt: job.attempt, storedAttempt: saved.attempt });
  } finally {
    clearTimeout(lateTimer); successorProbe(); lateCommit();
    if (guest && guest.exitCode === null) { guest.kill('SIGTERM'); await new Promise((resolve) => guest.once('exit', resolve)); }
    await Promise.all([api, target, s3].map(async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }));
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ schema: 'tick.monitor.guest-smoke.v1', mode: 'synthetic', runtime: 'viceroy', passed: true, certified: false, cases: results,
  signing: 'Every S3 wire request independently verified with Node HMAC, including session/host/path/payload/condition.',
  note: 'Actual consumer Wasm and host bindings in eight isolated atomic fixture domains. Late-save commits a received PUT after its guest request expired, while the successor probes. No deployed KV/S3, cross-POP or native probe continuity evidence.' }, null, 2));
