import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver } from '../src/receiver.mjs';
const token = 'a'.repeat(43);
function setup(overrides = {}, settings = {}) {
  const events = [];
  let calls = 0;
  let elapsed = 10;
  const handle = createReceiver({ experiment: 'test', ...settings }, {
    now: () => 1234000,
    monotonic: () => elapsed,
    loadToken: async () => { calls++; return token; },
    delay: async (ms) => { elapsed += ms; },
    requestId: () => `request-${events.length}`,
    metadata: () => ({ receiverPop: 'TEST', serviceVersion: '2', serviceId: 'service' }),
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { handle, events, calls: () => calls };
}
const request = (path = '/__tick/probe', init = {}) => new Request(`https://example.test${path}`, {
  headers: { 'x-tick-probe-token': token }, ...init,
});

test('route/method/query failures avoid loading secrets and are non-cacheable', async () => {
  const t = setup();
  for (const [req, status] of [[request('/'), 404], [request('/__tick/probe', { method: 'POST' }), 405],
    [request('/__tick/probe?delay=3000'), 400]]) {
    const res = await t.handle(req);
    assert.equal(res.status, status);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('surrogate-control'), /no-store/);
  }
  assert.equal(t.calls(), 0);
});
test('missing, malformed, and wrong tokens fail closed without evidence', async () => {
  const t = setup();
  for (const value of ['', 'short', 'b'.repeat(43), 'a'.repeat(42), 'x'.repeat(257)]) {
    const res = await t.handle(request('/__tick/probe', { headers: { 'x-tick-probe-token': value } }));
    assert.equal(res.status, 401);
  }
  assert.equal(t.events.length, 0);
});
test('missing bindings and sink failures give sanitized 503', async () => {
  for (const overrides of [ { loadToken: async () => undefined }, { loadToken: async () => '' },
    { loadToken: async () => { throw new Error(token); } },
    { emit: () => { throw new Error(token); } } ]) {
    const res = await setup(overrides).handle(request());
    assert.equal(res.status, 503);
    assert.equal(await res.text(), '{"error":"proof_unavailable"}');
  }
});
test('records authenticated arrivals; route fixes source; never records credentials', async () => {
  const t = setup();
  const res = await t.handle(request('/__tick/manual', { headers: {
    'x-tick-probe-token': token, 'x-tick-probe-source': 'healthcheck', 'x-forwarded-for': 'untrusted',
  } }));
  assert.equal(res.status, 200);
  const record = t.events[0];
  assert.equal(record.source, 'manual');
  assert.equal(record.receivedAtMs, 1234000);
  assert.equal(record.receiverPop, 'TEST');
  assert.equal(record.serviceVersion, '2');
  assert.equal(record.schema, 'tick.probe.v1');
  assert.ok(!JSON.stringify(record).includes(token));
  assert.ok(!JSON.stringify(record).includes('untrusted'));
});
test('hold completes before emitting and returning, with bounded configuration', async () => {
  const t = setup({}, { responseDelayMs: 2100 });
  assert.equal((await t.handle(request())).status, 200);
  assert.equal(t.events[0].handlerElapsedMs, 2100);
  assert.equal(t.events[0].responseDelayMs, 2100);
  for (const value of [-1, 3001, NaN, 1.5]) assert.throws(() => setup({}, { responseDelayMs: value }));
});
test('concurrent arrivals all remain visible; TICK-01 does not pretend to coordinate', async () => {
  const t = setup();
  const replies = await Promise.all(Array.from({ length: 100 }, () => t.handle(request())));
  assert.equal(t.events.length, 100);
  assert.equal(new Set(t.events.map((x) => x.requestId)).size, 100);
  assert.ok(replies.every((res) => res.status === 200));
});
