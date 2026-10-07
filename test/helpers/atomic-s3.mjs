import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createS3Store } from '../../dist/adapters/s3.js';

export const endpoint = 'https://state.s3.us-east-1.amazonaws.com';
export const errorResponse = (code, status = 404, headers = {}) => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fixture</Message></Error>`, { status, headers });
export const record = (changes = {}) => ({ contractVersion: 1, mutationId: 'mutation-1',
  run: { id: JSON.stringify(['tick.run.v1', 'test', 'job', 'v1', 0]), namespace: 'test', jobId: 'job', scheduleRevision: 'v1', scheduledForMs: 0 },
  state: 'leased', attempt: 1, attemptToken: 'owner-1', leaseExpiresAtMs: 1000, runDeadlineMs: 5000, ...changes });

// Atomic fixture oracle only. Content-derived ETags intentionally model repeatable content.
export function atomicS3() {
  const rows = new Map(), calls = [];
  function transport({ lostReply = false, unavailable = false, readHook, missingRevisionCreates = false } = {}) {
    return async (url, init) => {
      if (unavailable) throw new Error('private-transport-payload');
      const target = new URL(url);
      assert.equal(target.origin, endpoint);
      assert.equal(target.search, '');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.cache, 'no-store');
      const key = decodeURIComponent(target.pathname.slice(1));
      const current = rows.get(key);
      calls.push({ key, method: init.method, revision: init.headers.get('if-match') });
      if (init.method === 'GET') {
        if (readHook) { const response = readHook(key, current); if (response) return response; }
        return current ? new Response(current.body, { headers: { etag: current.revision } }) : errorResponse('NoSuchKey');
      }
      assert.equal(init.method, 'PUT');
      const absent = init.headers.get('if-none-match') === '*', revision = init.headers.get('if-match');
      assert.ok(absent !== !!revision, 'Exactly one condition required');
      if (absent ? !!current : !current && !missingRevisionCreates) return errorResponse(!current ? 'NoSuchKey' : 'PreconditionFailed', !current ? 404 : 412);
      if (!absent && current && current.revision !== revision) return errorResponse('PreconditionFailed', 412);
      const next = { body: init.body, value: JSON.parse(init.body), revision: '"' + createHash('md5').update(init.body).digest('hex') + '"' };
      rows.set(key, next);
      if (lostReply) throw new Error('private-lost-reply-after-commit');
      return new Response(null, { headers: { etag: next.revision } });
    };
  }
  const store = (options = {}) => createS3Store({ endpoint, fetch: transport(options) });
  return { rows, calls, store, transport };
}
