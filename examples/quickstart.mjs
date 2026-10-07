import { randomUUID } from 'node:crypto';
import { createBindings } from '@pulse-compute/tick/bindings';
import { createRunner } from '@pulse-compute/tick/runner';

// Keep credentials in host bindings; the definition contains logical resource names.
const storeId = process.env.FASTLY_KV_STORE_ID;
const token = process.env.FASTLY_API_TOKEN;
if (!storeId || !token) throw new Error('Set FASTLY_KV_STORE_ID and FASTLY_API_TOKEN');

const runner = createRunner({
  contractVersion: 1,
  namespace: 'quickstart',
  bindings: createBindings({
    coordination: { name: 'state', prefix: 'quickstart/jobs/' },
    stores: { state: { kind: 'fastly-kv-http', options: {
      storeId, token: async () => token,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(2_000) }),
    } } },
    clock: { nowMs: Date.now, monotonicMs: () => performance.now() },
    ids: { newAttemptToken: randomUUID, newMutationId: randomUUID },
    resources: { target: 'https://example.com/' },
  }),
  limits: {
    maxJobsPerTick: 1, maxAttemptsPerRun: 3, leaseMs: 6_000,
    runTimeoutMs: 30_000, retryDelayMs: 1_000,
    maxClockSkewMs: 1_000, deadlineSafetyMs: 500,
  },
  jobs: [{
    id: 'homepage',
    schedule: { kind: 'interval', anchorMs: 0, everyMs: 60_000,
      revision: 'v1', missedWindows: 'skip' },
    async execute(context, resources) {
      const response = await fetch(resources.target, {
        signal: AbortSignal.any([context.transportSignal, AbortSignal.timeout(2_000)]),
        redirect: 'manual', cache: 'no-store',
      });
      await response.body?.cancel();
      if (!context.signal.aborted) console.log({ run: context.run.id, httpStatus: response.status });
    },
  }],
}, {
  createCancellationController() {
    const controller = new AbortController();
    return { signal: controller.signal, nativeSignal: controller.signal,
      abort: () => controller.abort() };
  },
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

// One bounded invocation. An external request/probe calls this again when needed.
const result = await runner.tick({ requestId: randomUUID(),
  deadlineMs: Date.now() + 8_000, signal: AbortSignal.timeout(8_000) });
console.log(result);
