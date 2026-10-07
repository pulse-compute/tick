import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBurst } from '../../proof/trigger/analyze.mjs';
const row = (requestId, status, receiverPop) => ({ httpStatus: 200, observation: {
  schema: 'tick.trigger.observation.v1', requestId, receivedAtMs: 1_000, receiverPop, serviceId: 'service', serviceVersion: '1',
  admission: { status, scheduledForMs: 1_000, attempt: 1 },
  metrics: { admissionReads: status === 'owned' ? 2 : 1, admissionWrites: status === 'owned' ? 2 : 1,
    jobReads: status === 'owned' ? 8 : 0, jobWrites: status === 'owned' ? 8 : 0, visited: status === 'owned' ? 4 : 0,
    executions: status === 'owned' ? 4 : 0 },
} });
const options = { requests: 2, maxJobsPerTick: 4, mode: 'live' };
test('complete distributed burst observations still do not close platform viability gates', () => {
  const report = analyzeBurst([row('one', 'owned', 'iad'), row('two', 'conflict', 'lhr')], options);
  assert.equal(report.completeTrace, true); assert.equal(report.duplicateSuppressionObserved, true);
  assert.equal(report.distributedObservations, true); assert.equal(report.verdict, 'inconclusive');
});
test('synthetic, skipped-only remote arrivals, and unknown POPs cannot imply cross-POP contention', () => {
  assert.equal(analyzeBurst([row('one', 'owned', 'iad'), row('two', 'conflict', 'lhr')], { ...options, mode: 'synthetic' }).distributedObservations, false);
  assert.equal(analyzeBurst([row('one', 'owned', 'iad'), row('two', 'skipped', 'lhr')], options).distributedObservations, false);
  assert.equal(analyzeBurst([row('one', 'owned', 'unknown'), row('two', 'conflict', 'unknown')], options).distributedObservations, false);
});
test('multiple winners for the same attempt and unbounded fanout fail evidence checks', () => {
  assert.equal(analyzeBurst([row('one', 'owned', 'iad'), row('two', 'owned', 'lhr')], options).verdict, 'failed');
  const oversized = row('two', 'conflict', 'lhr'); oversized.observation.metrics.jobReads = 1;
  assert.equal(analyzeBurst([row('one', 'owned', 'iad'), oversized], options).verdict, 'failed');
});
test('missing responses, duplicate IDs, and mixed versions cannot establish a complete burst', () => {
  assert.equal(analyzeBurst([row('one', 'owned', 'iad')], options).completeTrace, false);
  assert.equal(analyzeBurst([row('one', 'owned', 'iad'), row('one', 'conflict', 'lhr')], options).completeTrace, false);
  const mixed = row('two', 'conflict', 'lhr'); mixed.observation.serviceVersion = '2';
  assert.equal(analyzeBurst([row('one', 'owned', 'iad'), mixed], options).duplicateSuppressionObserved, false);
});
