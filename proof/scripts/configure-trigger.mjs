// Creates proof-only resources on an EXISTING, unlocked trigger service version.
// Dry-run by default. Never activates a version, creates services, or prints tokens.
import { pathToFileURL } from 'node:url';

export function triggerPlan({ receiver, intervalMs = 10000, timeoutMs = 2000, token }) {
  const url = new URL(receiver);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('receiver must be an HTTPS origin without credentials, path, or port');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('Invalid interval-ms');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= intervalMs) throw new Error('timeout-ms must be positive and less than interval-ms');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new Error('Set TICK_PROBE_TOKEN (32-256 base64url characters)');
  return {
    healthcheck: { name: 'tick01_probe', host: url.hostname, path: '/__tick/probe',
      method: 'GET', http_version: '1.1', check_interval: intervalMs, timeout: timeoutMs,
      expected_response: 200, initial: 1, threshold: 1, window: 1,
      headers: [`X-Tick-Probe-Token: ${token}`] },
    backend: { name: 'tick01_receiver', address: url.hostname, port: 443,
      use_ssl: true, ssl_check_cert: true, override_host: url.hostname,
      ssl_sni_hostname: url.hostname, ssl_cert_hostname: url.hostname,
      healthcheck: 'tick01_probe' },
  };
}

// Matches Fastly's generated JS client's form encoding (headers collection: csv).
export function encodeForm(body) {
  return new URLSearchParams(Object.entries(body).map(([key, value]) =>
    [key, Array.isArray(value) ? value.join(',') : String(value)]));
}

export function verifyResource(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const got = actual[key];
    const equal = Array.isArray(value)
      ? Array.isArray(got) && JSON.stringify(got) === JSON.stringify(value)
      : typeof value === 'boolean'
        ? (value ? [true, 1, '1', 'true'] : [false, 0, '0', 'false']).includes(got)
        : String(got) === String(value);
    if (!equal) throw new Error(`Fastly readback mismatch for ${key}; inspect configuration (values redacted)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const values = {};
    const allowed = new Set(['service-id', 'receiver-service-id', 'version', 'receiver', 'interval-ms', 'timeout-ms']);
    let apply = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply' && !apply) { apply = true; continue; }
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || key in values) throw new Error('Invalid arguments');
      values[key] = args[++i];
    }
    const serviceId = values['service-id'];
    const receiverServiceId = values['receiver-service-id'];
    if (!/^[A-Za-z0-9]+$/.test(serviceId || '') || !/^[A-Za-z0-9]+$/.test(receiverServiceId || '') || serviceId === receiverServiceId) {
      throw new Error('Supply distinct --service-id and --receiver-service-id (trigger and receiver)');
    }
    if (!/^[1-9][0-9]*$/.test(values.version || '')) throw new Error('Supply an existing unlocked --version');
    const plan = triggerPlan({ receiver: values.receiver, token: process.env.TICK_PROBE_TOKEN,
      intervalMs: Number(values['interval-ms'] || 10000), timeoutMs: Number(values['timeout-ms'] || 2000) });
    const redacted = structuredClone(plan);
    redacted.healthcheck.headers = ['X-Tick-Probe-Token: <redacted>'];
    console.log(JSON.stringify({ serviceId, receiverServiceId, version: values.version, apply, ...redacted }, null, 2));
    if (apply) {
      const apiToken = process.env.FASTLY_API_TOKEN;
      if (!apiToken) throw new Error('Set FASTLY_API_TOKEN to apply');
      const base = `https://api.fastly.com/service/${serviceId}/version/${values.version}`;
      const call = async (url, method = 'GET', body) => {
        const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'Fastly-Key': apiToken, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          ...(body ? { body: encodeForm(body) } : {}) });
        // Error bodies may echo auth-bearing configuration. Never print them.
        if (!response.ok) throw new Error(`Fastly ${method} failed (${response.status}); inspect proof resources in Fastly UI before retrying`);
        try { return await response.json(); } catch { throw new Error('Fastly returned an invalid response (body redacted)'); }
      };
      const version = await call(base);
      if ([true, 1, '1', 'true'].includes(version.active) || [true, 1, '1', 'true'].includes(version.locked)) throw new Error('Refusing to change an active/locked version; clone it first');
      const healthchecks = await call(`${base}/healthcheck`);
      const backends = await call(`${base}/backend`);
      if (healthchecks.some((x) => x.name === plan.healthcheck.name) || backends.some((x) => x.name === plan.backend.name)) {
        throw new Error('Proof resources already exist; inspect/remove on the unlocked version before retrying');
      }
      await call(`${base}/healthcheck`, 'POST', plan.healthcheck);
      verifyResource(await call(`${base}/healthcheck/${plan.healthcheck.name}`), plan.healthcheck);
      await call(`${base}/backend`, 'POST', plan.backend);
      verifyResource(await call(`${base}/backend/${plan.backend.name}`), plan.backend);
      console.log('Proof resources created on unlocked version. Inspect and activate explicitly; this script did not activate it.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
