/// <reference types="@fastly/js-compute" />
import { SecretStore } from 'fastly:secret-store';
import { env } from 'fastly:env';
import { Logger } from 'fastly:logger';
import { createReceiver } from './receiver.mjs';
import { settings } from './settings.js';

const handle = createReceiver(settings, {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  loadToken: async () => {
    const entry = await new SecretStore('tick_secrets').get('probe-token');
    return entry?.plaintext();
  },
  requestId: () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join(''),
  metadata: () => ({
    receiverPop: env('FASTLY_POP') || 'unknown',
    serviceVersion: env('FASTLY_SERVICE_VERSION') || 'unknown',
    serviceId: env('FASTLY_SERVICE_ID') || 'unknown',
  }),
  emit: (record) => {
    const line = JSON.stringify(record);
    new Logger('tick_evidence').log(line);
    console.log(line);
  },
});

addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
