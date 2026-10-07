// Standalone Node host: externally invoked, with explicit environment-to-resource wiring.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMonitorApp } from './build/app.js';
import { createHttpProbe, createS3Observations } from './build/resources.js';
import { createSignedFetch } from './build/sigv4.js';
import { settings } from './settings.mjs';
const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; };
const target = required('TICK08_TARGET'), storeId = required('TICK08_KV_STORE_ID'), endpoint = required('TICK08_S3_ENDPOINT'), region = required('TICK08_S3_REGION');
required('TICK08_PROBE_TOKEN'); required('TICK08_FASTLY_API_TOKEN'); required('TICK08_AWS_ACCESS_KEY_ID'); required('TICK08_AWS_SECRET_ACCESS_KEY');
// Per-operation native timeouts bound provider I/O. Neither wrapper adds request retries.
const transport = (url, init) => fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
const signed = createSignedFetch({ region, fetch: transport, credentials: async () => ({ accessKeyId: required('TICK08_AWS_ACCESS_KEY_ID'),
  secretAccessKey: required('TICK08_AWS_SECRET_ACCESS_KEY'), ...(process.env.TICK08_AWS_SESSION_TOKEN ? { sessionToken: process.env.TICK08_AWS_SESSION_TOKEN } : {}) }) });
const app = createMonitorApp(settings.monitor, {
  kv: { storeId, token: async () => required('TICK08_FASTLY_API_TOKEN'), fetch: transport },
  clock: { nowMs: () => Date.now(), monotonicMs: () => performance.now() }, ids: { newAttemptToken: randomUUID, newMutationId: randomUUID },
  runtime: { createCancellationController() { const c = new AbortController(); return { signal: c.signal, nativeSignal: c.signal, abort: () => c.abort() }; },
    setTimer(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } },
  resources: { probe: createHttpProbe({ target, fetch: transport }), observations: createS3Observations({ endpoint, prefix: settings.observationsPrefix, fetch: signed }) },
  loadToken: async () => required('TICK08_PROBE_TOKEN'), requestId: randomUUID,
});
const server = createServer(async (incoming, outgoing) => {
  const cancellation = new AbortController();
  const disconnected = () => { if (!outgoing.writableFinished) cancellation.abort(); };
  outgoing.once('close', disconnected);
  try {
    if (incoming.method !== 'GET') { outgoing.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }).end(); incoming.resume(); return; }
    if (incoming.headers['content-length'] !== undefined || incoming.headers['transfer-encoding'] !== undefined) { outgoing.writeHead(400, { 'cache-control': 'no-store' }).end(); incoming.resume(); return; }
    const request = new Request(new URL(incoming.url, 'http://127.0.0.1'), { signal: cancellation.signal, headers: { 'x-tick-probe-token': incoming.headers['x-tick-probe-token'] || '' } });
    const response = await app.handle(request); outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
  } catch { if (!outgoing.destroyed) outgoing.writeHead(503, { 'cache-control': 'no-store' }).end(); }
  finally { outgoing.off('close', disconnected); }
});
server.requestTimeout = 12000; server.headersTimeout = 10000;
server.listen(8080, '127.0.0.1', () => console.log('Monitor accepts authenticated external triggers on 127.0.0.1:8080/__tick/run'));
