import assert from 'node:assert/strict';
import { createFastlyKvStore } from '../../dist/adapters/fastly-kv.js';

// Oracle is this test fixture, not the provider. Preserve full decimal generations.
export function atomicHttp() {
  const rows = new Map(), calls = [];
  let generation = 18446744073709550000n;
  function transport({ lostReply = false, unavailable = false, readHook, missingRevisionCreates = false, reuseRevision = false } = {}) {
    return async (url, init) => {
      if (unavailable) throw new Error('private-transport-payload');
      const target = new URL(url);
      assert.equal(target.origin, 'https://api.fastly.com');
      assert.ok(target.pathname.startsWith('/resources/stores/kv/test-store/keys/'));
      assert.equal(init.headers.get('Fastly-Key'), 'fixture-credential');
      const key = decodeURIComponent(target.pathname.split('/keys/')[1]);
      calls.push({ key, method: init.method, revision: init.headers.get('if-generation-match') });
      const current = rows.get(key);
      if (init.method === 'GET') {
        if (readHook) { const response = readHook(key, current); if (response) return response; }
        return current ? new Response(JSON.stringify(current.value), { headers: { generation: current.revision } }) : new Response(null, { status: 404 });
      }
      assert.equal(init.method, 'PUT');
      const condition = init.headers.get('if-generation-match');
      assert.ok(target.search === '?add=true' || condition);
      assert.equal(init.headers.has('time_to_live_sec'), false);
      if (target.search === '?add=true' ? !!current : !(missingRevisionCreates && !current) && current?.revision !== condition) {
        return new Response(null, { status: 412 });
      }
      rows.set(key, { value: JSON.parse(init.body), revision: reuseRevision && current ? current.revision : String(++generation) });
      if (lostReply) throw new Error('private-lost-reply'); // After the actual conditional fixture write.
      return new Response(null, { status: 204 });
    };
  }
  const store = (options = {}) => createFastlyKvStore({ storeId: 'test-store', token: async () => 'fixture-credential', fetch: transport(options) });
  return { rows, calls, store };
}
