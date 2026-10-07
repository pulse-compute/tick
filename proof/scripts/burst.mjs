import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function runBurst({ url, token, count = 100, concurrency = 10, timeoutMs = 5000 }) {
  const target = new URL('/__tick/manual', url);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
    throw new Error('Use HTTPS, or HTTP on loopback for local tests');
  }
  if (target.username || target.password) throw new Error('URL credentials are not allowed');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new Error('Set TICK_PROBE_TOKEN (32-256 base64url characters)');
  for (const [name, value, max] of [['count', count, 1000], ['concurrency', concurrency, 100], ['timeoutMs', timeoutMs, 30000]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  }
  const results = [];
  const events = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      next++;
      const start = performance.now();
      try {
        const response = await fetch(target, {
          headers: { 'x-tick-probe-token': token, 'cache-control': 'no-cache' },
          redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        });
        const record = await response.json();
        const valid = response.status === 200 && record.schema === 'tick.probe.v1' &&
          record.source === 'manual' && typeof record.requestId === 'string';
        results.push({ status: response.status, elapsedMs: performance.now() - start,
          valid, cacheHeader: response.headers.get('x-cache') });
        if (valid) { const { ok, ...event } = record; events.push(event); }
      } catch {
        results.push({ status: 0, elapsedMs: performance.now() - start, valid: false });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
  const durations = results.map((x) => x.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
  return { events, summary: {
    schema: 'tick.burst.v1', mode: 'synthetic', requested: count, concurrency,
    completed: results.length, successful: results.filter((x) => x.valid).length,
    uniqueRequestIds: new Set(events.map((x) => x.requestId)).size,
    clientLatencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: durations.at(-1) },
    statuses: results.reduce((map, x) => ({ ...map, [x.status]: (map[x.status] || 0) + 1 }), {}),
    cacheHeaders: [...new Set(results.map((x) => x.cacheHeader).filter(Boolean))],
    note: 'Synthetic manual requests; not native healthcheck or multi-POP evidence.',
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const values = {};
    const allowed = new Set(['url', 'count', 'concurrency', 'timeout-ms', 'events']);
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !allowed.has(key) || !args[i + 1] || key in values) throw new Error('Invalid arguments');
      values[key] = args[i + 1];
    }
    if (!values.url) throw new Error('Usage: burst.mjs --url <origin> [--count 100] [--concurrency 10] [--timeout-ms 5000] [--events file.ndjson]');
    const { events, summary } = await runBurst({
      url: values.url, token: process.env.TICK_PROBE_TOKEN,
      count: Number(values.count || 100), concurrency: Number(values.concurrency || 10),
      timeoutMs: Number(values['timeout-ms'] || 5000),
    });
    if (values.events) await writeFile(values.events, events.map((e) => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.successful !== summary.requested || summary.uniqueRequestIds !== summary.requested) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
