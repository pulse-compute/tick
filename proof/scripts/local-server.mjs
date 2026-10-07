import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReceiver } from '../src/receiver.mjs';

const handle = createReceiver({
  experiment: process.env.TICK_EXPERIMENT || 'tick-01-local',
  responseDelayMs: Number(process.env.TICK_RESPONSE_DELAY_MS || 0),
}, {
  now: Date.now,
  monotonic: () => performance.now(),
  loadToken: async () => process.env.TICK_PROBE_TOKEN,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestId: randomUUID,
  metadata: () => ({ receiverPop: 'local', serviceVersion: 'local', serviceId: 'local' }),
  emit: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
});
const server = http.createServer(async (req, res) => {
  try {
    const result = await handle(new Request(new URL(req.url, 'http://localhost'), {
      method: req.method, headers: req.headers,
    }));
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(await result.text());
  } catch {
    res.writeHead(400, { 'cache-control': 'no-store' });
    res.end();
  }
});
server.listen(Number(process.env.PORT || 7676), '127.0.0.1', () => {
  process.stderr.write('Local receiver ready (synthetic evidence only)\n');
});
