import { createCoordinationBinding } from '../../../dist/bindings.js';
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store, max-age=0', 'surrogate-control': 'no-store' };
const match = (actual, expected) => {
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < 256; i++) difference |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return difference === 0;
};
async function json(request, deadline) {
  if (!request.body) throw new Error();
  const reader = request.body.getReader(), chunks = []; let size = 0;
  deadline.cancelBody = () => { void reader.cancel().catch(() => {}); };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (deadline.exceeded) throw new Error();
      if (done) break;
      size += value.byteLength; if (size > 16384) throw new Error(); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { deadline.cancelBody = undefined; try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

/** Dedicated authenticated storage proof endpoint; no application jobs or scheduler. */
export function createS3Receiver({ cohort, endpoint, deadlineMs = 5000 }, deps) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cohort) || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) throw new Error('Invalid proof settings');
  const prefix = `tick07/${cohort}/`, reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/__tick/s3') return reply(404, { error: 'not_found' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (url.search) return reply(400, { error: 'query_not_allowed' });
    const token = request.headers.get('x-tick-probe-token') || '';
    if (!TOKEN.test(token)) return reply(401, { error: 'unauthorized' });
    const started = deps.now(), deadline = { exceeded: false }, provider = [];
    let timer, injectedFault = null;
    try {
      const controller = deps.createController?.();
      timer = setTimeout(() => { deadline.exceeded = true; controller?.abort(); deadline.cancelBody?.(); }, deadlineMs);
      const expected = await deps.loadToken();
      if (!TOKEN.test(expected || '')) return reply(503, { error: 'proof_unavailable' });
      if (!match(token, expected)) return reply(401, { error: 'unauthorized' });
      let body;
      try { body = await json(request, deadline); } catch { return reply(400, { error: 'invalid_request' }); }
      const key = body?.operation === 'read' ? body.key : body?.write?.key;
      if (body?.cohort !== cohort || typeof key !== 'string' || !key.startsWith(prefix)
        || !/^[A-Za-z0-9/_-]{1,80}$/.test(key.slice(prefix.length)) || !['read', 'compareAndSwap'].includes(body.operation)
        || (body.fault !== undefined && !['lose-write-response', 'unavailable'].includes(body.fault))
        || (body.fault === 'lose-write-response' && body.operation !== 'compareAndSwap')) return reply(400, { error: 'invalid_request' });
      if (deadline.exceeded) return reply(503, { error: 'proof_unavailable' });
      const store = createCoordinationBinding({ name: 'proof', prefix: '' }, { proof: { kind: 's3-http', options: {
        endpoint, ...(controller ? { signal: controller.signal } : {}), fetch: async (url, init) => {
          if (body.fault === 'unavailable') { injectedFault = body.fault; throw new Error(); }
          const response = await deps.fetch(url, init);
          const safeId = (name) => { const value = response.headers.get(name); return value && /^[A-Za-z0-9/+_=-]{1,256}$/.test(value) ? value : null; };
          provider.push({ method: init.method, status: response.status, requestId: safeId('x-amz-request-id'), extendedId: safeId('x-amz-id-2') });
          if (body.fault === 'lose-write-response' && init.method === 'PUT' && response.status === 200 && !response.redirected) {
            injectedFault = body.fault; try { await response.body?.cancel(); } catch {} throw new Error();
          }
          return response;
        },
      } } }).store;
      const result = body.operation === 'read' ? await store.read(key) : await store.compareAndSwap(body.write);
      return reply(200, { schema: 'tick.s3.observation.v1', cohort, operation: body.operation,
        requestId: deps.requestId(), receivedAtMs: started, ...deps.metadata(), transport: 's3-http',
        deadlineExceeded: deadline.exceeded || deps.now() - started >= deadlineMs,
        cancellation: controller ? 'abort-signal' : 'host-timeouts', injectedFault, provider, result });
    } catch (error) {
      return reply(error instanceof TypeError ? 400 : 503, { error: error instanceof TypeError ? 'invalid_request' : 'proof_unavailable' });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
}
