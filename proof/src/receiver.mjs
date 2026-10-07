const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store, max-age=0',
  'surrogate-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

function tokenMatches(actual, expected) {
  // Fixed work for accepted token lengths; not a claim of JS constant-time execution.
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < 256; i++) {
    difference |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return difference === 0;
}

/** Pure request handler. Host resources are injected, never read at module load. */
export function createReceiver({ experiment, responseDelayMs = 0 }, deps) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(experiment)) throw new Error('Invalid experiment ID');
  if (!Number.isInteger(responseDelayMs) || responseDelayMs < 0 || responseDelayMs > 3000) {
    throw new Error('responseDelayMs must be an integer between 0 and 3000');
  }
  const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { ...HEADERS, ...extra },
  });
  return async (request) => {
    const path = new URL(request.url).pathname;
    const source = path === '/__tick/probe' ? 'healthcheck' : path === '/__tick/manual' ? 'manual' : null;
    if (!source) return reply(404, { error: 'not_found' });
    if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    if (new URL(request.url).search) return reply(400, { error: 'query_not_allowed' });
    const token = request.headers.get('x-tick-probe-token') || '';
    if (!TOKEN.test(token)) return reply(401, { error: 'unauthorized' });
    const receivedAtMs = deps.now();
    const started = deps.monotonic();
    try {
      const expected = await deps.loadToken();
      if (typeof expected !== 'string' || !TOKEN.test(expected)) {
        return reply(503, { error: 'proof_unavailable' });
      }
      if (!tokenMatches(token, expected)) return reply(401, { error: 'unauthorized' });
      if (responseDelayMs) await deps.delay(responseDelayMs);
      const metadata = deps.metadata();
      const record = {
        schema: 'tick.probe.v1', event: 'arrival', experiment, source,
        requestId: deps.requestId(), receivedAtMs,
        receiverPop: metadata.receiverPop,
        serviceVersion: metadata.serviceVersion,
        serviceId: metadata.serviceId,
        responseStatus: 200,
        handlerElapsedMs: Math.max(0, deps.monotonic() - started),
        responseDelayMs,
      };
      // Complete observation within the request lifetime; no detached background work.
      await deps.emit(record);
      return reply(200, { ok: true, ...record });
    } catch {
      // Never serialize host exceptions, request headers, or credentials.
      return reply(503, { error: 'proof_unavailable' });
    }
  };
}
