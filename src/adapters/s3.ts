import { isCoordinationRecord as isRecord, serializeCoordinationRecord } from '../internal/records.js';
import { isNativeSignal } from '../internal/bindings.js';
import type { ConditionalWrite, CoordinationStore, ReadResult, StoreRevision, WriteResult } from '../index.js';

/** Single-object GET/conditional PUT against an explicitly selected bucket origin. */
export interface S3Options {
  /** HTTPS virtual-hosted bucket origin, e.g. https://state.s3.us-east-1.amazonaws.com. */
  readonly endpoint: string;
  /**
   * Host-owned SigV4 signing AND transport. Preserve the URL, method, body and conditions;
   * sign the condition headers and payload; disable caching, redirects and ALL retries.
   * Compute supplies a fixed backend with verified timeouts. No credential discovery.
   */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Optional native transport cancellation, captured per invocation. */
  readonly signal?: AbortSignal;
}

const MAX_BYTES = 16384;
// One strong quoted HTTP entity tag. Never accept wildcards, weak tags or tag lists.
const isRevision = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 1024 && /^"[\x21\x23-\x7e]+"$/.test(value);

function encodeKey(key: string): string {
  try {
    if (typeof key !== 'string' || !key || /[\x00-\x1f\x7f]/.test(key)
      || new TextEncoder().encode(key).length > 1024
      || key.split('/').some((part) => part === '.' || part === '..')) throw new TypeError();
    // Retain slashes and empty segments. URL normalization must not change the object key.
    return key.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g,
      (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
  } catch { throw new TypeError('Invalid S3 key'); }
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* A known HTTP outcome stays known. */ }
}

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    try { await reader.cancel(); } catch { /* Never expose error bodies. */ }
    reader.releaseLock();
  }
}

async function isMissingKey(response: Response): Promise<boolean> {
  // Fail closed on generic proxy 404s, NoSuchBucket, delete markers, malformed/large errors.
  // Recognize the documented S3 Error envelope only, never a Code buried in Message.
  if (response.headers.get('x-amz-delete-marker') === 'true' || response.headers.has('content-range')
    || response.headers.has('x-amz-expiration')) { await discard(response); return false; }
  const text = await boundedText(response);
  return /^(?:\s*<\?xml[^<>]*\?>)?\s*<Error(?:\s+xmlns="[^"<>]*")?>\s*<Code>NoSuchKey<\/Code>(?:(?!<Code>|<!)[\s\S])*<\/Error>\s*$/.test(text);
}

/**
 * Candidate S3 adapter. One transport call per operation; no retry, HEAD, version reads,
 * multipart upload, delete, TTL, or read/unconditional-put lock. Live proof remains required.
 */
export function createS3Store(options: S3Options): CoordinationStore {
  let origin: string, transport: S3Options['fetch'], signal: AbortSignal | undefined;
  try {
    const endpoint = options.endpoint, url = new URL(endpoint);
    if (typeof endpoint !== 'string' || url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash
      || (endpoint !== url.origin && endpoint !== url.origin + '/') || typeof options.fetch !== 'function') throw new TypeError();
    origin = url.origin;
    transport = options.fetch.bind(options); signal = options.signal;
    if (signal !== undefined && !isNativeSignal(signal)) throw new TypeError();
  } catch { throw new TypeError('Invalid S3 binding'); }
  const request = (path: string, method: 'GET' | 'PUT', body?: string, condition?: string): Promise<Response> => {
    const headers = new Headers({ 'cache-control': 'no-store' });
    const init: RequestInit = { method, headers, redirect: 'manual', cache: 'no-store' };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      headers.set(condition === '*' ? 'if-none-match' : 'if-match', condition!);
      init.body = body;
    }
    if (signal !== undefined) init.signal = signal;
    return transport(origin + '/' + path, init);
  };
  return {
    capabilities: { atomicCreate: true, atomicReplace: true, scope: 'global-per-key', coherentValueRevision: true, reads: 'possibly-stale' },
    async read(key: string): Promise<ReadResult> {
      const path = encodeKey(key);
      try {
        const response = await request(path, 'GET');
        if (response.redirected) { await discard(response); return { status: 'unavailable' }; }
        if (response.status === 404) return { status: await isMissingKey(response) ? 'absent' : 'unavailable' };
        const revision = response.headers.get('etag');
        if (response.status !== 200 || !isRevision(revision) || response.headers.has('content-range')
          || response.headers.has('x-amz-expiration') || response.headers.get('x-amz-delete-marker') === 'true') {
          await discard(response); return { status: 'unavailable' };
        }
        const value: unknown = JSON.parse(await boundedText(response));
        return isRecord(value) ? { status: 'found', value, revision: revision as StoreRevision } : { status: 'unavailable' };
      } catch { return { status: 'unavailable' }; }
    },
    async compareAndSwap(write: ConditionalWrite): Promise<WriteResult> {
      let path: string, condition: string, body: string;
      try {
        path = encodeKey(write.key);
        const expected = write.expected, kind = expected?.kind;
        if (kind === 'absent') condition = '*';
        else if (kind === 'revision') {
          const revision = expected.revision;
          if (!isRevision(revision)) throw new TypeError();
          condition = revision;
        }
        else throw new TypeError();
        body = serializeCoordinationRecord(write.value);
        if (new TextEncoder().encode(body).length > MAX_BYTES || !isRecord(JSON.parse(body))) throw new TypeError();
      } catch { throw new TypeError('Invalid S3 conditional write'); }
      try {
        const response = await request(path, 'PUT', body, condition);
        if (response.redirected) { await discard(response); return { status: 'indeterminate' }; }
        // AWS rejects If-Match on a missing current object with 404 NoSuchKey, not 412.
        if (response.status === 404 && condition !== '*') {
          return { status: await isMissingKey(response) ? 'conflict' : 'indeterminate' };
        }
        const status = response.status;
        await discard(response);
        if (status === 412) return { status: 'conflict' };
        if (status === 200) return { status: 'applied' };
        // Includes 409, auth/region errors, throttling, 202, other 2xx, and server failures.
        return { status: 'indeterminate' };
      } catch { return { status: 'indeterminate' }; }
    },
  };
}
