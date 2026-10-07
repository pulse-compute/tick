import { open, access } from 'node:fs/promises';
import { analyzeBurst } from './analyze.mjs';
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--url', '--output', '--mode', '--requests', '--concurrency', '--max-jobs'].includes(args[index]) || !args[index + 1]
    || options[args[index]]) throw new Error('Usage: run.mjs --url URL --output NEW_FILE --mode live|synthetic --max-jobs N [--requests N] [--concurrency N]');
  options[args[index]] = args[index + 1];
}
const url = new URL(options['--url']), output = options['--output'], mode = options['--mode'];
const requests = Number(options['--requests'] ?? 100), concurrency = Number(options['--concurrency'] ?? 16), maxJobsPerTick = Number(options['--max-jobs']);
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
if (!output || !['live', 'synthetic'].includes(mode) || url.username || url.password || url.search || url.hash
  || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && mode === 'synthetic'))
  || !Number.isSafeInteger(requests) || requests < 1 || requests > 256 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32
  || !Number.isSafeInteger(maxJobsPerTick) || maxJobsPerTick < 1 || maxJobsPerTick > 64) throw new Error('Invalid driver configuration');
const token = process.env.TICK_PROBE_TOKEN;
if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Missing proof token');
try { await access(output); throw new Error('Evidence output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
// Reserve output before networking; never overwrite an earlier trace or print the token.
const file = await open(output, 'wx');
const rows = new Array(requests); let next = 0;
const text = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : undefined;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next < requests) {
      const index = next++;
      try {
        const response = await fetch(url, { headers: { 'x-tick-probe-token': token }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const reader = response.body?.getReader();
        const chunks = []; let size = 0;
        try { if (reader) while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 131_072) throw new Error('Oversized observation'); chunks.push(value);
        } } finally { await reader?.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        // Persist only protocol fields; never arbitrary error/upstream response payloads.
        rows[index] = { index, httpStatus: response.status, observation: { schema: text(value.schema), requestId: text(value.requestId),
          receivedAtMs: count(value.receivedAtMs), receiverPop: text(value.receiverPop), serviceId: text(value.serviceId), serviceVersion: text(value.serviceVersion),
          admission: { status: text(value.admission?.status), scheduledForMs: count(value.admission?.scheduledForMs), attempt: count(value.admission?.attempt) },
          metrics: value.metrics ? Object.fromEntries(['admissionReads', 'admissionWrites', 'jobReads', 'jobWrites', 'visited', 'executions']
            .map((key) => [key, count(value.metrics[key])])) : undefined } };
      } catch { rows[index] = { index, httpStatus: null, error: 'request_unavailable' }; }
    }
  }));
  const report = analyzeBurst(rows, { requests, maxJobsPerTick, mode });
  await file.writeFile(JSON.stringify({ report, rows }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await file.close(); }
