/// <reference types="@fastly/js-compute" />
import { SecretStore } from 'fastly:secret-store';
import { CacheOverride } from 'fastly:cache-override';
import { env } from 'fastly:env';
import { Logger } from 'fastly:logger';
import { createFastlyKvStore } from '../../../dist/adapters/fastly-kv.js';
import { createFastlyTrigger } from '../../../dist/adapters/fastly-trigger.js';
import { createCooperativeController } from '../../../dist/cancellation.js';
import { settings } from './settings.js';

const secret = async (name) => (await new SecretStore('tick05_secrets').get(name))?.plaintext();
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const runtime = { createCancellationController: createCooperativeController, setTimer(callback, ms) {
  const handle = setTimeout(callback, ms); return () => clearTimeout(handle);
} };
const transport = (url, init) => fetch(url, { ...init, backend: 'fastly_api', cacheOverride: new CacheOverride('pass'), redirect: 'error' });
function handler(scenario) {
  let lost = false;
  const base = `tick05/${scenario}/`;
  const jobsStore = createFastlyKvStore({ storeId: settings.storeId, token: () => secret('fastly-api-token'), fetch: transport });
  const gateStore = createFastlyKvStore({ storeId: settings.storeId, token: () => secret('fastly-api-token'), fetch: async (url, init) => {
    const response = await transport(url, init);
    if (scenario === 'lost' && !lost && init.method === 'PUT' && [200, 201, 204].includes(response.status)) {
      lost = true;
      await response.body?.cancel();
      throw new Error('Injected successful admission response loss');
    }
    return response;
  } });
  const limits = { maxAttemptsPerRun: 3, leaseMs: 3_000, runTimeoutMs: 10_000,
    retryDelayMs: 100, maxClockSkewMs: 20, deadlineSafetyMs: 20 };
  return createFastlyTrigger({ requestTimeoutMs: settings.requestTimeoutMs, path: `/__tick/run/${scenario}`,
    runtime, loadToken: () => secret('probe-token'), requestId: id,
    metadata: () => ({ receiverPop: env('FASTLY_POP') || 'unknown', serviceId: env('FASTLY_SERVICE_ID') || 'unknown',
      serviceVersion: env('FASTLY_SERVICE_VERSION') || 'unknown' }),
    admission: { coordination: { name: 'admission', prefix: `${base}admission/`, store: gateStore }, limits,
      schedule: { kind: 'interval', anchorMs: 0, everyMs: settings.gateEveryMs, revision: 'v1', missedWindows: 'skip' } },
    definition: { contractVersion: 1, namespace: `tick05-${scenario}`,
      bindings: { coordination: { name: 'jobs', prefix: `${base}jobs/`, store: jobsStore },
        clock: { nowMs: () => Date.now(), monotonicMs: () => performance.now() },
        ids: { newAttemptToken: id, newMutationId: id }, resources: {} },
      limits: { ...limits, maxJobsPerTick: settings.maxJobsPerTick, leaseMs: scenario === 'timeout' ? 150 : 1_500 },
      jobs: Array.from({ length: settings.jobCount }, (_, index) => ({ id: `job-${index}`,
        schedule: { kind: 'interval', anchorMs: 0, everyMs: settings.jobEveryMs, revision: 'v1', missedWindows: 'skip' },
        // Proof-only application: no external effects. The timeout case deliberately ignores cancellation.
        execute: async () => { if (scenario === 'timeout') await new Promise(() => {}); },
      })),
    },
  });
}
addEventListener('fetch', (event) => {
  const name = new URL(event.request.url).pathname.split('/').at(-1);
  if (!['normal', 'lost', 'crash', 'timeout'].includes(name)) {
    event.respondWith(new Response(JSON.stringify({ error: 'not_found' }), { status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'surrogate-control': 'no-store' } }));
    return;
  }
  event.respondWith(handler(name)(event.request).then(async (response) => {
    // Native healthchecks discard response bodies. Persist only this receiver's bounded
    // protocol observation; logging is awaited and never grants execution authority.
    try {
      const value = await response.clone().json();
      if (value.schema === 'tick.trigger.observation.v1') {
        const line = JSON.stringify({ httpStatus: response.status, observation: value });
        try { new Logger('tick05_evidence').log(line); } catch { /* Optional local endpoint. */ }
        console.log(line);
      }
    } catch { /* Observational logging cannot change the receiver response. */ }
    return response;
  }));
});
