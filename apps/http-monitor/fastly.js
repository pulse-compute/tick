/// <reference types="@fastly/js-compute" />
import { SecretStore } from 'fastly:secret-store';
import { CacheOverride } from 'fastly:cache-override';
import { env } from 'fastly:env';
import { createCooperativeController } from '@pulse-compute/tick/cancellation';
import { createMonitorApp } from './build/app.js';
import { createHttpProbe, createS3Observations } from './build/resources.js';
import { createSignedFetch } from './build/sigv4.js';
import { settings } from './settings.mjs';

const secret = async (key) => (await new SecretStore('tick08_secrets').get(key))?.plaintext();
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const fixed = (backend) => (url, init) => fetch(url, { ...init, backend, cacheOverride: new CacheOverride('pass'), redirect: 'manual' });
const s3 = createSignedFetch({ region: settings.s3Region, fetch: fixed('observations'), credentials: async () => {
  const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
    secret('aws-access-key-id'), secret('aws-secret-access-key'), secret('aws-session-token'),
  ]);
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
} });
const app = createMonitorApp(settings.monitor, {
  kv: { storeId: settings.storeId, token: () => secret('fastly-api-token'), fetch: fixed('fastly_api') },
  clock: { nowMs: () => Date.now(), monotonicMs: () => performance.now() }, ids: { newAttemptToken: id, newMutationId: id },
  runtime: { createCancellationController: createCooperativeController, setTimer(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } },
  resources: { probe: createHttpProbe({ target: settings.target, fetch: fixed('monitored') }),
    observations: createS3Observations({ endpoint: settings.s3Endpoint, prefix: settings.observationsPrefix, fetch: s3 }) },
  loadToken: () => secret('probe-token'), requestId: id,
  metadata: () => ({ receiverPop: env('FASTLY_POP') || 'unknown', serviceId: env('FASTLY_SERVICE_ID') || 'unknown', serviceVersion: env('FASTLY_SERVICE_VERSION') || 'unknown' }),
});
addEventListener('fetch', (event) => event.respondWith(app.handle(event.request)));
