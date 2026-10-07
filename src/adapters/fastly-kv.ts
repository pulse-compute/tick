import { isCoordinationRecord as isRecord } from '../internal/records.js';
import { isNativeSignal } from '../internal/bindings.js';
import type { ConditionalWrite, CoordinationStore, ReadResult, StoreRevision, WriteResult } from '../index.js';

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
// Positive full-width decimal revisions, without Number conversion.
const uint64 = /^[1-9][0-9]{0,19}$/;
const isRevision = (value: unknown): value is string => typeof value === 'string' && uint64.test(value)
  && (value.length < 20 || value <= '18446744073709551615');

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
  let storeId: string, token: FastlyKvOptions['token'], transport: FastlyKvOptions['fetch'], signal: AbortSignal | undefined;
  try {
    storeId = options.storeId;
    if (typeof storeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(storeId) || typeof options.token !== 'function'
      || typeof options.fetch !== 'function') throw new TypeError();
    token = options.token.bind(options); transport = options.fetch.bind(options); signal = options.signal;
    if (signal !== undefined && !isNativeSignal(signal)) throw new TypeError();
  } catch { throw new TypeError('Invalid Fastly KV binding'); }
  const baseUrl = `https://api.fastly.com/resources/stores/kv/${storeId}/keys/`;
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
    const credential = await token();
    if (typeof credential !== 'string' || !credential || /[^\x21-\x7e]/.test(credential)) throw new Error('Unavailable credential');
    headers.set('Fastly-Key', credential);
    const init: RequestInit = { method, headers, redirect: 'manual', cache: 'no-store' };
    if (body !== undefined) init.body = body;
    if (signal !== undefined) init.signal = signal;
    return transport(url, init);
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
