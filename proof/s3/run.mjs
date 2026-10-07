import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { runS3Proof } from './scenarios.mjs';
const { values } = parseArgs({ options: { target: { type: 'string' }, cohort: { type: 'string' }, out: { type: 'string' }, mode: { type: 'string', default: 'live' }, contenders: { type: 'string', default: '4' } } });
if (!values.target || !values.cohort || !values.out) throw new Error('Usage: proof:s3 -- --target https://proof.example/__tick/s3 --cohort FRESH_COHORT --out NEW_FILE.json [--mode live|synthetic]');
const url = new URL(values.target), token = process.env.TICK_PROBE_TOKEN;
if (url.username || url.password || url.search || url.hash || url.pathname !== '/__tick/s3'
  || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS (or loopback HTTP), exact path and no URL credentials/query/fragment');
if (!/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new Error('Set TICK_PROBE_TOKEN');
// Reserve output before any live write; never overwrite prior evidence.
const output = await open(values.out, 'wx', 0o600), started = Date.now();
try {
  const report = await runS3Proof({ cohort: values.cohort, mode: values.mode, contenders: Number(values.contenders), call: async (body) => {
    if (Date.now() - started >= 120000) throw new Error('Proof budget exhausted');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tick-probe-token': token },
      body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(7000) });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('Observation unavailable'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) throw new Error('Oversized observation'); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  } });
  await output.writeFile(JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.conformance.cases.length + report.cases.length, operations: report.evidence.operations, output: values.out }));
  process.exitCode = report.status === 'observed' ? 0 : report.status === 'failed' ? 1 : 2;
} finally { await output.close(); }
