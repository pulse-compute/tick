import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { signRequest } from '../sigv4.mjs';
import { createS3Receiver } from '../src/receiver.mjs';
import { runS3Proof } from '../scenarios.mjs';
import { atomicS3, endpoint } from '../../../test/helpers/atomic-s3.mjs';

// Public AWS documentation test vectors, not usable credentials.
const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
test('proof signer matches AWS published GET and encoded PUT signatures', async () => {
  const timestamp = Date.parse('2013-05-24T00:00:00Z');
  const get = await signRequest('https://examplebucket.s3.amazonaws.com/test.txt', { method: 'GET', headers: { range: 'bytes=0-9' } }, credentials, 'us-east-1', timestamp);
  assert.match(get.headers.get('authorization'), /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const put = await signRequest('https://examplebucket.s3.amazonaws.com/test%24file.text', { method: 'PUT', body: 'Welcome to Amazon S3.',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } }, credentials, 'us-east-1', timestamp);
  assert.match(put.headers.get('authorization'), /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('proof signer signs exact ETag, payload and session token without normalizing encoded or repeated path segments', async () => {
  const init = { method: 'PUT', body: 'é', headers: { 'if-match': '"opaque-2"', 'cache-control': 'no-store', 'content-type': 'application/json' } };
  const signed = await signRequest(endpoint + '/a//%25%21%C3%A9/', init, { ...credentials, sessionToken: 'fixture/session+token=' }, 'us-east-1', 0);
  assert.match(signed.headers.get('authorization'), /SignedHeaders=cache-control;content-type;host;if-match;x-amz-content-sha256;x-amz-date;x-amz-security-token/);
  assert.equal(signed.headers.get('if-match'), '"opaque-2"'); assert.equal(signed.headers.get('x-amz-security-token'), 'fixture/session+token=');
  assert.equal(signed.headers.get('x-amz-content-sha256'), createHash('sha256').update('é').digest('hex'));
  assert.equal(new Headers(init.headers).has('authorization'), false);
  for (const url of ['http://bucket/key', endpoint + '/key?versionId=old', 'https://user:secret@bucket/key']) {
    await assert.rejects(signRequest(url, init, credentials, 'us-east-1'), /Signing unavailable/);
  }
});

function fixture({ metadata, transport } = {}) {
  const atomic = atomicS3(); let requests = 0;
  const receiver = createS3Receiver({ cohort: 'test-proof', endpoint, deadlineMs: 5000 }, {
    now: () => Date.now(), loadToken: async () => 'x'.repeat(40), requestId: () => `request-${++requests}`,
    metadata: metadata ?? (() => ({ receiverPop: 'LOCAL', serviceId: 'local', serviceVersion: 'local' })),
    fetch: async (url, init) => {
      const response = await (transport ?? atomic.transport())(url, init);
      response.headers.set('x-amz-request-id', `fixture-${atomic.calls.length}`); return response;
    },
  });
  const call = async (body) => {
    const response = await receiver(new Request('https://proof.example/__tick/s3', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-tick-probe-token': 'x'.repeat(40) } }));
    assert.equal(response.status, 200); return response.json();
  };
  return { atomic, receiver, call };
}

test('proof receiver authenticates and confines writes to selected fresh cohort before storage access', async () => {
  const f = fixture();
  for (const [path, method, token, body, status] of [
    ['/wrong', 'POST', 'x'.repeat(40), {}, 404], ['/__tick/s3', 'GET', 'x'.repeat(40), undefined, 405],
    ['/__tick/s3?query=1', 'POST', 'x'.repeat(40), {}, 400], ['/__tick/s3', 'POST', '', {}, 401],
    ['/__tick/s3', 'POST', 'y'.repeat(40), {}, 401],
    ['/__tick/s3', 'POST', 'x'.repeat(40), { cohort: 'test-proof', operation: 'read', key: 'application/jobs/key' }, 400],
    ['/__tick/s3', 'POST', 'x'.repeat(40), { cohort: 'old', operation: 'read', key: 'tick07/test-proof/key' }, 400],
    ['/__tick/s3', 'POST', 'x'.repeat(40), { cohort: 'test-proof', operation: 'read', key: 'tick07/test-proof/../escape' }, 400],
  ]) {
    const response = await f.receiver(new Request('https://proof.example' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'x-tick-probe-token': token } }));
    assert.equal(response.status, status); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(f.atomic.calls.length, 0);
});

test('proof runs reusable conformance plus stale owner and superseded unknown write, retaining records and limiting work', async () => {
  const f = fixture(), report = await runS3Proof({ cohort: 'test-proof', mode: 'synthetic', contenders: 2, call: f.call });
  assert.equal(report.conformance.status, 'observed', JSON.stringify(report)); assert.equal(report.conformance.cases.length, 7);
  assert.ok(report.cases.every((c) => c.status === 'observed')); assert.equal(report.status, 'inconclusive'); assert.equal(report.certified, false);
  assert.equal(report.evidence.completeTrace, true); assert.equal(report.evidence.distributed, false);
  assert.equal(report.evidence.providerTrace, true); assert.ok(report.trace.length <= report.limits.maxRequests);
  assert.equal(f.atomic.rows.size, 5); assert.equal(report.trace.filter((r) => r.injectedFault === 'lose-write-response').length, 2);
  assert.ok(!JSON.stringify(report).includes('secretAccessKey')); assert.ok(!JSON.stringify(report.trace).includes('revision'));
});

test('live label alone does not clear distributed evidence; missing request IDs and failed faults stay inconclusive', async () => {
  const f = fixture(); const report = await runS3Proof({ cohort: 'test-proof', mode: 'live', contenders: 2, call: f.call });
  assert.equal(report.status, 'inconclusive');
  const g = fixture({ metadata: () => ({ receiverPop: 'IAD', serviceId: 'SERVICE0123456789', serviceVersion: '1' }) });
  const bad = await runS3Proof({ cohort: 'test-proof', mode: 'live', contenders: 2, call: async (body) => {
    const response = await g.call(body); for (const p of response.provider) p.requestId = null; return response;
  } });
  assert.equal(bad.status, 'inconclusive'); assert.equal(bad.evidence.providerTrace, false);
  const h = fixture(); const fault = await runS3Proof({ cohort: 'test-proof', contenders: 2, call: async (body) => {
    const response = await h.call(body); if (body.fault) response.injectedFault = null; return response;
  } });
  assert.equal(fault.status, 'inconclusive'); assert.equal(fault.evidence.completeTrace, false);
});

test('proof stale accepted conditions are failure even when live metadata is incomplete', async () => {
  const atomic = atomicS3();
  const f = fixture({ transport: async (url, init) => {
    if (init.method === 'PUT' && init.headers.has('if-match')) {
      // Deliberately defective provider accepts every stale precondition.
      const key = decodeURIComponent(new URL(url).pathname.slice(1)), current = atomic.rows.get(key);
      if (current) init.headers.set('if-match', current.revision);
    }
    return atomic.transport()(url, init);
  } });
  const report = await runS3Proof({ cohort: 'test-proof', contenders: 2, call: f.call });
  assert.equal(report.status, 'failed'); assert.ok(report.cases.some((c) => c.status === 'failed'));
});

test('proof receiver awaits an in-flight write that outlives its deadline and records expiry without changing the known outcome', async () => {
  let release, entered; const started = new Promise((resolve) => { entered = resolve; });
  const receiver = createS3Receiver({ cohort: 'test-proof', endpoint, deadlineMs: 5 }, {
    now: () => Date.now(), loadToken: async () => 'x'.repeat(40), requestId: () => 'timeout', metadata: () => ({}),
    fetch: async () => { entered(); await new Promise((resolve) => { release = resolve; }); return new Response(); },
  });
  const body = { cohort: 'test-proof', operation: 'compareAndSwap', write: { key: 'tick07/test-proof/key', expected: { kind: 'absent' },
    value: { contractVersion: 1, mutationId: 'm1', run: { id: '["tick.run.v1","test","job","v1",0]', namespace: 'test', jobId: 'job', scheduleRevision: 'v1', scheduledForMs: 0 }, state: 'leased', attempt: 1, attemptToken: 'a1', leaseExpiresAtMs: 1000, runDeadlineMs: 10000 } } };
  let finished = false;
  const pending = receiver(new Request('https://proof.example/__tick/s3', { method: 'POST', body: JSON.stringify(body), headers: { 'x-tick-probe-token': 'x'.repeat(40) } })).then((response) => { finished = true; return response; });
  await started; await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(finished, false); release();
  const observation = await (await pending).json(); assert.equal(observation.result.status, 'applied'); assert.equal(observation.deadlineExceeded, true);
});
