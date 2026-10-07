/// <reference types="@fastly/js-compute" />
import { SecretStore } from 'fastly:secret-store';
import { env } from 'fastly:env';
import { CacheOverride } from 'fastly:cache-override';
import { createFastlyKvStore } from '../../../dist/adapters/fastly-kv.js';
import { createKvReceiver } from './receiver.mjs';
import { settings } from './settings.js';

const secret = async (name) => (await new SecretStore('tick02_secrets').get(name))?.plaintext();
const handle = createKvReceiver(settings, {
  now: () => Date.now(), loadToken: () => secret('probe-token'),
  // SDK 3.45.0 has no AbortController/fetch signal support; use configured host timeouts.
  createAbortController: () => undefined,
  createStore: ({ signal, fetch: transport }) => createFastlyKvStore({
    storeId: settings.storeId, token: () => secret('fastly-api-token'), fetch: transport, signal,
  }),
  fetch: (url, init) => fetch(url, { ...init, backend: 'fastly_api',
    cacheOverride: new CacheOverride('pass'), redirect: 'error' }),
  requestId: () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join(''),
  metadata: () => ({ receiverPop: env('FASTLY_POP') || 'unknown',
    serviceVersion: env('FASTLY_SERVICE_VERSION') || 'unknown', serviceId: env('FASTLY_SERVICE_ID') || 'unknown' }),
});
addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
