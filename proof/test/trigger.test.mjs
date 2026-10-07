import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerPlan, encodeForm, verifyResource } from '../scripts/configure-trigger.mjs';
import { runBurst } from '../scripts/burst.mjs';
const token = 'a'.repeat(43);
test('plan fixes TLS and host routing to receiver and isolates a static healthcheck', () => {
  const plan = triggerPlan({ receiver: 'https://receiver.example.test', token });
  assert.equal(plan.backend.address, 'receiver.example.test');
  assert.equal(plan.backend.override_host, plan.healthcheck.host);
  assert.equal(plan.backend.ssl_sni_hostname, plan.backend.ssl_cert_hostname);
  assert.equal(plan.backend.healthcheck, plan.healthcheck.name);
  assert.equal(plan.healthcheck.path, '/__tick/probe');
  assert.equal(plan.healthcheck.check_interval, 10000);
});
test('rejects unsafe receiver URLs and invalid timing/auth', () => {
  for (const receiver of ['http://example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?token=x']) {
    assert.throws(() => triggerPlan({ receiver, token }));
  }
  assert.throws(() => triggerPlan({ receiver: 'https://example.test', token, timeoutMs: 10000 }));
  assert.throws(() => triggerPlan({ receiver: 'https://example.test', token: '' }));
});
test('burst refuses cleartext remote tokens and unbounded requests before networking', async () => {
  await assert.rejects(runBurst({ url: 'http://example.test', token }));
  await assert.rejects(runBurst({ url: 'https://example.test', token, count: 1001 }));
  await assert.rejects(runBurst({ url: 'https://example.test', token, concurrency: 101 }));
});

test('Fastly form serialization keeps the dedicated auth header intact and verifies readback', () => {
  const plan = triggerPlan({ receiver: 'https://receiver.example.test', token });
  const encoded = encodeForm(plan.healthcheck);
  assert.equal(encoded.get('headers'), `X-Tick-Probe-Token: ${token}`);
  assert.equal(encoded.get('check_interval'), '10000');
  verifyResource({ ...plan.backend, port: '443', use_ssl: '1' }, plan.backend);
  assert.throws(() => verifyResource({ ...plan.healthcheck, headers: [] }, plan.healthcheck), /headers/);
  assert.throws(() => verifyResource({ ...plan.backend, ssl_check_cert: false }, plan.backend), /ssl_check_cert/);
});
