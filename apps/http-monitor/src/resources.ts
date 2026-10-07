import type { ExecutionContext, RunIdentity } from '@pulse-compute/tick';
import type { S3Options } from '@pulse-compute/tick/adapters/s3';
import { validObservation, validRun } from './monitor.js';
import type { Observation, ObservationRead, ObservationStore, Probe } from './monitor.js';

export function createHttpProbe(options: { readonly target: string; readonly fetch: S3Options['fetch'] }): Probe {
  let target: string, transport: S3Options['fetch'];
  try {
    const url = new URL(options.target);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || typeof options.fetch !== 'function') throw new TypeError();
    target = url.href; transport = options.fetch.bind(options);
  } catch { throw new TypeError('Invalid monitor probe'); }
  return { async check(context: ExecutionContext) {
    const init: RequestInit = { method: 'GET', headers: { 'cache-control': 'no-store' }, cache: 'no-store', redirect: 'manual' };
    if (context.transportSignal !== undefined) init.signal = context.transportSignal;
    // Only headers/status are observed. Never read, persist or log the response body.
    const response = await transport(target, init);
    const status = response.status, redirected = response.redirected;
    try { await response.body?.cancel(); } catch { /* Header outcome is already known. */ }
    if (redirected) throw new Error('Probe transport followed a redirect');
    return { httpStatus: status };
  } };
}

// A host shim may implement this capability using Pulse. It receives no Tick authority.
export type PulseProbeInvoker = (input: { readonly deadlineMs: number; readonly signal: ExecutionContext['signal']; readonly transportSignal?: AbortSignal }) => Promise<{ readonly httpStatus: number | null }>;
export function createPulseProbe(invoke: PulseProbeInvoker): Probe {
  if (typeof invoke !== 'function') throw new TypeError('Invalid Pulse probe binding');
  return { check: (context) => invoke(Object.freeze({ deadlineMs: context.deadlineMs, signal: context.signal,
    ...(context.transportSignal !== undefined ? { transportSignal: context.transportSignal } : {}) })) };
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function observationKey(prefix: string, run: RunIdentity): string {
  if (!/^[A-Za-z0-9/_-]{1,96}\/$/.test(prefix) || !validRun(run)) throw new TypeError('Invalid observation identity');
  return `${prefix}ns-${run.namespace}/job-${run.jobId}/rev-${run.scheduleRevision}/at-${run.scheduledForMs}.json`;
}
async function discard(response: Response) { try { await response.body?.cancel(); } catch {} }
async function text(response: Response): Promise<string> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4096) throw new Error(); chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

/** Application snapshots, not CoordinationStore records or ownership receipts. */
export function createS3Observations(options: { readonly endpoint: string; readonly prefix: string; readonly fetch: S3Options['fetch'] }): ObservationStore {
  let origin: string, prefix: string, transport: S3Options['fetch'];
  try {
    const endpoint = options.endpoint, selectedPrefix = options.prefix, url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (endpoint !== url.origin && endpoint !== url.origin + '/') || !/^[A-Za-z0-9/_-]{1,96}\/$/.test(selectedPrefix) || typeof options.fetch !== 'function') throw new TypeError();
    origin = url.origin; prefix = selectedPrefix; transport = options.fetch.bind(options);
  } catch { throw new TypeError('Invalid S3 observation binding'); }
  const request = (run: RunIdentity, method: 'GET' | 'PUT', signal?: AbortSignal, body?: string) => {
    const key = observationKey(prefix, run), headers = new Headers({ 'cache-control': 'no-store' });
    const init: RequestInit = { method, headers, cache: 'no-store', redirect: 'manual' };
    if (signal !== undefined) init.signal = signal;
    if (body !== undefined) { headers.set('content-type', 'application/json'); headers.set('if-none-match', '*'); init.body = body; }
    return transport(origin + '/' + key.split('/').map(encode).join('/'), init);
  };
  return {
    async read(run, signal): Promise<ObservationRead> {
      // Capture the identity before host signing yields. Invalid input never opens resources.
      if (!validRun(run)) throw new TypeError('Invalid observation identity');
      const identity = Object.freeze({ ...run });
      try {
        const response = await request(identity, 'GET', signal);
        if (response.redirected || response.headers.get('x-amz-delete-marker') === 'true' || response.headers.has('x-amz-expiration') || response.headers.has('content-range')) {
          await discard(response); return { status: 'unavailable' };
        }
        if (response.status === 404) {
          const missing = /^(?:\s*<\?xml[^<>]*\?>)?\s*<Error(?:\s+xmlns="[^"<>]*")?>\s*<Code>NoSuchKey<\/Code>(?:(?!<Code>|<!)[\s\S])*<\/Error>\s*$/.test(await text(response));
          return { status: missing ? 'absent' : 'unavailable' };
        }
        if (response.status !== 200) { await discard(response); return { status: 'unavailable' }; }
        const value: unknown = JSON.parse(await text(response));
        return validObservation(value) && value.run.id === identity.id ? { status: 'found', value } : { status: 'unavailable' };
      } catch { return { status: 'unavailable' }; }
    },
    async putIfAbsent(value: Observation, signal) {
      let body: string, run: RunIdentity;
      try {
        if (!validObservation(value)) throw new TypeError();
        body = JSON.stringify({ ...value, run: { ...value.run } }); const wire: unknown = JSON.parse(body);
        if (new TextEncoder().encode(body).length > 4096 || !validObservation(wire)) throw new TypeError();
        run = Object.freeze({ ...wire.run });
      } catch { throw new TypeError('Invalid monitor observation'); }
      try {
        const response = await request(run, 'PUT', signal, body), status = response.status, redirected = response.redirected;
        await discard(response);
        return { status: !redirected && status === 200 ? 'saved' as const : !redirected && status === 412 ? 'exists' as const : 'indeterminate' as const };
      } catch { return { status: 'indeterminate' as const }; }
    },
  };
}
