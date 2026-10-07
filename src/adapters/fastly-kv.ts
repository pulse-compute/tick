import type { ConditionalWrite, CoordinationRecord, CoordinationStore, ReadResult, StoreRevision, WriteResult } from '../index.js';

/** Explicit HTTP API binding. This does not use the native fastly:kv-store module. */
export interface FastlyKvOptions {
  readonly storeId: string;
  readonly token: () => Promise<string>;
  /** Must honor redirect: 'manual' and disable caching; Compute supplies a fixed backend. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Per-invocation cancellation. Transport implementations must honor this signal. */
  readonly signal?: AbortSignal;
}

const MAX_RECORD_BYTES = 16384;
const identifier = /^[A-Za-z0-9._-]{1,80}$/;
const tokenId = /^[A-Za-z0-9._:-]{1,128}$/;
// Zero is not an accepted revision: native Fastly interfaces use it as the no-condition sentinel.
const uint64 = /^[1-9][0-9]{0,19}$/;
const isRevision = (value: unknown): value is string => typeof value === 'string' && uint64.test(value)
  && (value.length < 20 || value <= '18446744073709551615');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

// Validate at the storage boundary. Type assertions alone cannot validate persisted data.
function isRecord(value: unknown): value is CoordinationRecord {
  if (!object(value) || value.contractVersion !== 1 || !matches(value.mutationId, tokenId)
      || !integer(value.attempt) || value.attempt < 1 || !integer(value.runDeadlineMs) || !object(value.run)) return false;
  const run = value.run;
  if (!only(run, ['id', 'namespace', 'jobId', 'scheduleRevision', 'scheduledForMs'])
      || !matches(run.namespace, identifier) || !matches(run.jobId, identifier)
      || !matches(run.scheduleRevision, identifier) || !integer(run.scheduledForMs)
      || run.id !== JSON.stringify(['tick.run.v1', run.namespace, run.jobId, run.scheduleRevision, run.scheduledForMs])) return false;
  const base = ['contractVersion', 'mutationId', 'run', 'attempt', 'runDeadlineMs', 'state'];
  switch (value.state) {
    case 'leased': return only(value, [...base, 'attemptToken', 'leaseExpiresAtMs'])
      && matches(value.attemptToken, tokenId) && integer(value.leaseExpiresAtMs);
    case 'retryable': return only(value, [...base, 'nextAttemptAtMs', 'failureCode'])
      && integer(value.nextAttemptAtMs) && matches(value.failureCode, /^[A-Za-z0-9._:-]{1,80}$/);
    case 'completed': return only(value, [...base, 'completedAtMs']) && integer(value.completedAtMs);
    case 'failed': return only(value, [...base, 'failedAtMs', 'reason']) && integer(value.failedAtMs)
      && ['attempts-exhausted', 'deadline-exceeded', 'permanent-failure'].includes(value.reason as string);
    default: return false;
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !key || key === '.' || key === '..' || /[#;?^|\n\r]/.test(key)
      || key.startsWith('.well-known/acme-challenge/') || new TextEncoder().encode(key).length > 1024) {
    throw new TypeError('Invalid Fastly KV key');
  }
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* A known HTTP outcome stays known. */ }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing record');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECORD_BYTES) throw new Error('Oversized record');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    try { await reader.cancel(); } catch { /* Never surface transport error bodies. */ }
    reader.releaseLock();
  }
}

/**
 * Candidate adapter for Fastly's KV HTTP API, pending deployed TICK-02 evidence.
 * One request per operation; no automatic retry, TTL, deletion, or unconditional write.
 * A lost write response is indeterminate even if the server may have committed it.
 */
export function createFastlyKvStore(options: FastlyKvOptions): CoordinationStore {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.storeId) || typeof options.token !== 'function'
      || typeof options.fetch !== 'function') throw new TypeError('Invalid Fastly KV binding');
  const baseUrl = `https://api.fastly.com/resources/stores/kv/${options.storeId}/keys/`;
  async function request(key: string, method: 'GET' | 'PUT', body?: string, expected?: ConditionalWrite['expected']): Promise<Response> {
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    let suffix = '';
    if (method === 'PUT') {
      if (expected?.kind === 'absent') suffix = '?add=true';
      else if (expected?.kind === 'revision' && isRevision(expected.revision)) headers.set('if-generation-match', expected.revision);
      else throw new TypeError('Missing Fastly KV write condition');
    }
    const url = baseUrl + encodeURIComponent(key) + suffix;
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const credential = await options.token();
    if (typeof credential !== 'string' || !credential || /[^\x21-\x7e]/.test(credential)) throw new Error('Unavailable credential');
    headers.set('Fastly-Key', credential);
    const init: RequestInit = { method, headers, redirect: 'manual', cache: 'no-store' };
    if (body !== undefined) init.body = body;
    if (options.signal !== undefined) init.signal = options.signal;
    return options.fetch(url, init);
  }
  return {
    capabilities: { atomicCreate: true, atomicReplace: true, scope: 'global-per-key', coherentValueRevision: true, reads: 'possibly-stale' },
    async read(key: string): Promise<ReadResult> {
      validateKey(key);
      try {
        const response = await request(key, 'GET');
        if (response.status === 404) { await discard(response); return { status: 'absent' }; }
        const revision = response.headers.get('generation');
        if (response.status !== 200 || response.redirected || !isRevision(revision)) {
          await discard(response); return { status: 'unavailable' };
        }
        const value: unknown = JSON.parse(await readBounded(response));
        return isRecord(value) ? { status: 'found', value, revision: revision as StoreRevision } : { status: 'unavailable' };
      } catch { return { status: 'unavailable' }; }
    },
    async compareAndSwap(write: ConditionalWrite): Promise<WriteResult> {
      // Capture the actual wire operation before any await. JS callers can mutate readonly types.
      let key: string;
      let expected: ConditionalWrite['expected'];
      let body: string;
      try {
        key = write.key;
        validateKey(key);
        const condition = write.expected;
        const kind = condition?.kind;
        if (kind === 'absent') expected = { kind };
        else if (kind === 'revision') {
          const revision = condition.revision;
          if (!isRevision(revision)) throw new TypeError();
          expected = { kind, revision };
        } else throw new TypeError();
        if (!isRecord(write.value)) throw new TypeError();
        body = JSON.stringify(write.value);
        if (new TextEncoder().encode(body).length > MAX_RECORD_BYTES || !isRecord(JSON.parse(body))) throw new TypeError();
      } catch {
        throw new TypeError('Invalid Fastly KV conditional write');
      }
      try {
        const response = await request(key, 'PUT', body, expected);
        const status = response.status;
        const redirected = response.redirected;
        await discard(response);
        if (!redirected && status === 412) return { status: 'conflict' };
        if (!redirected && [200, 201, 204].includes(status)) return { status: 'applied' };
        return { status: 'indeterminate' };
      } catch { return { status: 'indeterminate' }; }
    },
  };
}
