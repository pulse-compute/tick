import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from '../../proof/trigger/reference.mjs';

test('bounded HTTP driver captures sanitized evidence and refuses to overwrite before networking', async () => {
  const f = fixture(); let arrivals = 0;
  const server = createServer(async (request, response) => {
    arrivals++;
    const result = await f.handler(new Request(`http://localhost${request.url}`, { headers: request.headers }));
    const value = await result.json();
    value.secret = 'private-payload';
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  const directory = await mkdtemp(join(tmpdir(), 'tick-trigger-driver-'));
  try {
    const output = join(directory, 'burst.json');
    const args = [resolve('proof/trigger/run.mjs'), '--url', `http://127.0.0.1:${server.address().port}/__tick/run`,
      '--output', output, '--mode', 'synthetic', '--max-jobs', '4', '--requests', '4', '--concurrency', '2'];
    const run = () => promisify(execFile)(process.execPath, args, { env: { ...process.env, TICK_PROBE_TOKEN: 't'.repeat(40) } });
    const result = await run();
    const evidence = await readFile(output, 'utf8');
    const { report, rows } = JSON.parse(evidence);
    assert.equal(arrivals, 4); assert.equal(rows.length, 4);
    assert.equal(report.completeTrace, true); assert.equal(report.admittedSweeps, 1);
    assert.equal(report.verdict, 'inconclusive');
    assert.equal(evidence.includes('private-payload'), false);
    assert.equal(evidence.includes('t'.repeat(40)), false);
    assert.equal(result.stdout.includes('t'.repeat(40)), false);
    await assert.rejects(run, /Evidence output already exists/);
    assert.equal(arrivals, 4);
    assert.equal(await readFile(output, 'utf8'), evidence);
  } finally {
    await new Promise((yes) => server.close(yes));
    await rm(directory, { recursive: true, force: true });
  }
});
