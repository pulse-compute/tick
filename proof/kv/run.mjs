import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runProof } from './scenarios.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, experiment: { type: 'string' },
  out: { type: 'string' }, mode: { type: 'string', default: 'live' }, contenders: { type: 'string', default: '4' } } });
if (!values.url || !values.experiment || !values.out) throw new Error('Required: --url --experiment --out');
const url = new URL(values.url);
if (url.username || url.password || url.search || url.hash || url.pathname !== '/__tick/kv'
  || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
  throw new Error('Use HTTPS (or loopback HTTP), exact /__tick/kv path, and no URL credentials/query/fragment');
}
const token = process.env.TICK_PROBE_TOKEN;
if (!/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new Error('Set TICK_PROBE_TOKEN');
// Reserve evidence storage before any live operation; never discover EEXIST after writes.
const output = await open(values.out, 'wx', 0o600);
try {
const started = Date.now();
const report = await runProof({ experiment: values.experiment, mode: values.mode, contenders: Number(values.contenders),
  call: async (body) => {
    if (Date.now() - started > 120000) throw new Error('Proof budget exhausted');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-tick-probe-token': token }, body: JSON.stringify(body), cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(7000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Proof request unavailable'); }
    const reader = response.body.getReader();
    let text = '', size = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) throw new Error('Oversized observation');
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { await reader.cancel(); }
  } });
await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ verdict: report.verdict, operations: report.evidence.operations, output: values.out }));
process.exitCode = report.verdict === 'observed' ? 0 : report.verdict === 'fail' ? 1 : 2;
} finally { await output.close(); }
