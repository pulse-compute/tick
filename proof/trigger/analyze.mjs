const count = (value) => Number.isSafeInteger(value) && value >= 0;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value);
/** Observations describe one controlled burst, not authority or a perpetual platform guarantee. */
export function analyzeBurst(rows, { requests, maxJobsPerTick, mode }) {
  if (!Array.isArray(rows) || !count(requests) || requests < 1 || requests > 256 || !count(maxJobsPerTick)
    || maxJobsPerTick < 1 || maxJobsPerTick > 64 || !['live', 'synthetic'].includes(mode)) throw new Error('Invalid burst analysis bounds');
  let complete = rows.length === requests, invalid = false;
  const ids = new Set(), services = new Set(), pops = new Set(), contenders = new Set(), winners = [];
  const totals = { admissionReads: 0, admissionWrites: 0, jobReads: 0, jobWrites: 0, visited: 0, executions: 0 };
  const outcomes = new Set(['owned', 'skipped', 'conflict', 'settled', 'unavailable', 'configuration-mismatch', 'stale', 'expired', 'indeterminate', 'unresolved']);
  for (const row of rows) {
    const value = row?.observation, metrics = value?.metrics;
    if (!value || value.schema !== 'tick.trigger.observation.v1' || !id(value.requestId) || !count(value.receivedAtMs)
      || !id(value.receiverPop) || !id(value.serviceId) || !id(value.serviceVersion) || !outcomes.has(value.admission?.status)
      || !metrics || !Object.keys(totals).every((key) => count(metrics[key]))) { complete = false; continue; }
    if (ids.has(value.requestId)) { invalid = true; continue; }
    ids.add(value.requestId); services.add(JSON.stringify([value.serviceId, value.serviceVersion]));
    if (value.receiverPop !== 'unknown') pops.add(value.receiverPop);
    if (['owned', 'conflict'].includes(value.admission.status) && value.receiverPop !== 'unknown') contenders.add(value.receiverPop);
    if (metrics.admissionReads + metrics.admissionWrites > 8 || metrics.visited > maxJobsPerTick || metrics.executions > metrics.visited
      || metrics.jobReads + metrics.jobWrites > 8 * metrics.visited
      || (value.admission.status !== 'owned' && (metrics.visited || metrics.jobReads || metrics.jobWrites))) invalid = true;
    for (const key of Object.keys(totals)) totals[key] += metrics[key];
    if (row.httpStatus !== 200) complete = false;
    if (value.admission.status === 'owned') {
      if (!count(value.admission.scheduledForMs) || !count(value.admission.attempt) || value.admission.attempt < 1) { invalid = true; continue; }
      winners.push(value);
    }
  }
  if (services.size !== 1 || ids.size !== requests) complete = false;
  const attempts = new Set();
  for (const value of winners) {
    const identity = JSON.stringify([value.admission.scheduledForMs, value.admission.attempt]);
    if (attempts.has(identity)) invalid = true;
    attempts.add(identity);
  }
  const measured = complete && !invalid && winners.length === 1 && winners[0].metrics.visited > 0;
  return { schema: 'tick.trigger.http-burst.v1', mode, requests, completeTrace: complete, bounded: !invalid,
    admittedSweeps: winners.length, totals, storageCalls: Object.values(totals).slice(0, 4).reduce((a, b) => a + b, 0),
    duplicateSuppressionObserved: measured, receiverPops: [...pops].sort(), contendingPops: [...contenders].sort(),
    distributedObservations: mode === 'live' && measured && contenders.size >= 2,
    verdict: invalid ? 'failed' : 'inconclusive',
    note: 'No burst alone clears trigger continuity, host lifetime or provider semantics gates. Match observations to retained records and backend traces.' };
}
