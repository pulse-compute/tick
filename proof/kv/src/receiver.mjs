const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'private, no-store, max-age=0',
  'surrogate-control': 'no-store', 'x-content-type-options': 'nosniff' };

function tokenMatches(actual, expected) {
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < 256; i++) difference |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return difference === 0;
}

async function boundedJson(request, deadline) {
  if (!request.body) throw new Error('missing body');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  deadline.cancelBody = cancel;
  try {
    if (deadline.exceeded) throw new Error('deadline');
    while (true) {
      const { value, done } = await reader.read();
      if (deadline.exceeded) throw new Error('deadline');
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('body too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    deadline.cancelBody = undefined;
    void reader.cancel().catch(() => {});
  }
}

function validOperation(body, experiment) {
  if (!body || typeof body !== 'object' || body.experiment !== experiment) return false;
  if (body.fault !== undefined && body.fault !== 'lose-write-response') return false;
  const key = body.operation === 'read' ? body.key : body.write?.key;
  if (typeof key !== 'string' || !key.startsWith(`tick02/${experiment}/`)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(key.slice(`tick02/${experiment}/`.length))) return false;
  if (body.operation === 'read') return body.fault === undefined;
  if (body.operation !== 'compareAndSwap') return false;
  const { expected, value } = body.write;
  if (!expected || !(expected.kind === 'absent' || (expected.kind === 'revision'
    && typeof expected.revision === 'string' && /^[0-9]{1,20}$/.test(expected.revision)))) return false;
  // The adapter validates the complete record; only proof fixture states enter this endpoint.
  return value?.contractVersion === 1 && ['leased', 'completed'].includes(value.state);
}

/** No resources or secrets are opened at module initialization. */
export function createKvReceiver({ experiment, deadlineMs = 5000 }, deps) {
  if (!ID.test(experiment) || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) {
    throw new Error('Invalid proof settings');
  }
  const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { ...HEADERS, ...extra },
  });
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/__tick/kv') return reply(404, { error: 'not_found' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    if (url.search) return reply(400, { error: 'query_not_allowed' });
    const token = request.headers.get('x-tick-probe-token') || '';
    if (!TOKEN.test(token)) return reply(401, { error: 'unauthorized' });
    const deadline = { exceeded: false, cancelBody: undefined };
    let timeout;
    const receivedAtMs = deps.now();
    try {
      const controller = deps.createAbortController ? deps.createAbortController()
        : typeof AbortController === 'function' ? new AbortController() : undefined;
      timeout = setTimeout(() => {
        deadline.exceeded = true;
        controller?.abort();
        deadline.cancelBody?.();
      }, deadlineMs);
      const expected = await deps.loadToken();
      if (typeof expected !== 'string' || !TOKEN.test(expected)) return reply(503, { error: 'proof_unavailable' });
      if (!tokenMatches(token, expected)) return reply(401, { error: 'unauthorized' });
      let body;
      try { body = await boundedJson(request, deadline); }
      catch { return reply(400, { error: 'invalid_request' }); }
      if (!validOperation(body, experiment)) return reply(400, { error: 'invalid_request' });
      if (deadline.exceeded) return reply(503, { error: 'proof_unavailable' });
      let injectedFault = null;
      const store = deps.createStore({ ...(controller ? { signal: controller.signal } : {}), fetch: async (url, init) => {
        const response = await deps.fetch(url, init);
        if (body.fault === 'lose-write-response' && init.method === 'PUT'
          && [200, 201, 204].includes(response.status)) {
          injectedFault = body.fault;
          void response.body?.cancel().catch(() => {});
          throw new Error('Injected response loss after successful PUT');
        }
        return response;
      } });
      const result = body.operation === 'read' ? await store.read(body.key) : await store.compareAndSwap(body.write);
      return reply(200, { schema: 'tick.kv.observation.v1', experiment, operation: body.operation,
        requestId: deps.requestId(), receivedAtMs, ...deps.metadata(), transport: 'fastly-kv-http',
        injectedFault, deadlineExceeded: deadline.exceeded || deps.now() - receivedAtMs >= deadlineMs,
        cancellation: controller ? 'abort-signal' : 'host-timeouts', result });
    } catch {
      return reply(503, { error: 'proof_unavailable' });
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  };
}
