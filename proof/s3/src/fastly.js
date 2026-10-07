/// <reference types="@fastly/js-compute" />
import { SecretStore } from 'fastly:secret-store';
import { env } from 'fastly:env';
import { CacheOverride } from 'fastly:cache-override';
import { createSignedFetch } from '../sigv4.mjs';
import { createS3Receiver } from './receiver.mjs';
import { settings } from './settings.js';

const secret = async (name) => (await new SecretStore('tick07_secrets').get(name))?.plaintext();
const handle = createS3Receiver(settings, {
  now: () => Date.now(), loadToken: () => secret('probe-token'),
  // SDK 3.45 has no native fetch signal. Await all writes and configure backend timeouts.
  createController: () => undefined,
  fetch: createSignedFetch({ region: settings.region, credentials: async () => {
    const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
      secret('aws-access-key-id'), secret('aws-secret-access-key'), secret('aws-session-token'),
    ]);
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }, fetch: (url, init) => fetch(url, { ...init, backend: 's3', redirect: 'manual', cacheOverride: new CacheOverride('pass') }) }),
  requestId: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  metadata: () => ({ receiverPop: env('FASTLY_POP') || 'unknown', serviceId: env('FASTLY_SERVICE_ID') || 'unknown', serviceVersion: env('FASTLY_SERVICE_VERSION') || 'unknown' }),
});
addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
