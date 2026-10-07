import { runStoreConformance } from '../../dist/testing/conformance.js';
import { isCoordinationRecord } from '../../dist/internal/records.js';
const capabilities = { atomicCreate: true, atomicReplace: true, scope: 'global-per-key', coherentValueRevision: true, reads: 'possibly-stale' };
const same = (a, b) => a === b || (a && b && typeof a === 'object' && typeof b === 'object'
  && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => same(a[key], b[key])));
class Stop extends Error { constructor(reason, status = 'inconclusive') { super(reason); this.status = status; } }
const liveMetadata = (row) => /^[A-Z][A-Z0-9]{1,11}$/.test(row.receiverPop || '') && !['LOCAL', 'UNKNOWN'].includes(row.receiverPop)
  && /^[A-Za-z0-9]{10,80}$/.test(row.serviceId || '') && /^[1-9][0-9]*$/.test(row.serviceVersion || '');

/** RPC writers are independent receiver invocations addressing one bucket/key domain. */
export async function runS3Proof({ call, cohort, mode = 'synthetic', contenders = 4, readRounds = 4 }) {
  if (typeof call !== 'function' || !/^[A-Za-z0-9_-]{1,40}$/.test(cohort) || !['synthetic', 'live'].includes(mode)
    || !Number.isInteger(contenders) || contenders < 2 || contenders > 8 || !Number.isInteger(readRounds) || readRounds < 1 || readRounds > 8) throw new TypeError('Invalid S3 proof options');
  const trace = [], cases = [], prefix = `tick07/${cohort}/`;
  // Conformance worst case plus two authority scenarios, each <= 4*rounds reads + 4 writes.
  const maxRequests = 9 * contenders * readRounds + 7 * contenders + 10 + 8 * readRounds + 8;
  const operation = async (body) => {
    if (trace.length >= maxRequests) throw new Stop('request-budget-exhausted');
    const phase = body.write?.value?.run.jobId === 'race' ? body.write.value.mutationId.includes(':create:') ? 'create-race'
      : body.write.value.mutationId.includes(':replace:') ? 'replace-race' : 'other' : 'other';
    const row = { sequence: trace.length + 1, operation: body.operation, phase, startedAtMs: Date.now() }; trace.push(row);
    try {
      const response = await call({ cohort, ...body });
      if (!response || response.schema !== 'tick.s3.observation.v1' || response.cohort !== cohort || response.operation !== body.operation
        || response.transport !== 's3-http' || typeof response.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(response.requestId)
        || !Number.isSafeInteger(response.receivedAtMs) || typeof response.deadlineExceeded !== 'boolean'
        || !['abort-signal', 'host-timeouts'].includes(response.cancellation) || !Array.isArray(response.provider)
        || response.provider.length > 1 || !response.result || !['found', 'absent', 'unavailable', 'applied', 'conflict', 'indeterminate'].includes(response.result.status)) throw new Stop('invalid-observation');
      const expectedFault = body.fault ?? null;
      if (response.injectedFault !== expectedFault) throw new Stop('fault-not-observed');
      const provider = response.provider[0];
      if (expectedFault === 'unavailable' ? !!provider : !provider || provider.method !== (body.operation === 'read' ? 'GET' : 'PUT')
        || !Number.isInteger(provider.status) || provider.status < 100 || provider.status > 599
        || (expectedFault === 'lose-write-response' && provider.status !== 200)) throw new Stop('incomplete-provider-trace');
      Object.assign(row, { requestId: response.requestId, receiverPop: response.receiverPop, serviceId: response.serviceId,
        serviceVersion: response.serviceVersion, receivedAtMs: response.receivedAtMs, deadlineExceeded: response.deadlineExceeded,
        cancellation: response.cancellation, injectedFault: response.injectedFault, provider: response.provider, result: response.result.status });
      if (response.deadlineExceeded) throw new Stop('receiver-deadline-exceeded');
      return response.result;
    } catch { row.error = 'observation-unavailable'; throw new Stop('observation-unavailable'); }
    finally { row.finishedAtMs = Date.now(); }
  };
  const store = (fault) => ({ capabilities,
    read: (key) => operation({ operation: 'read', key, ...(fault ? { fault } : {}) }),
    compareAndSwap: (write) => operation({ operation: 'compareAndSwap', write, ...(fault ? { fault } : {}) }),
  });
  const writers = Array.from({ length: contenders }, () => store());
  const conformance = await runStoreConformance({ writers, prefix: prefix + 'conformance/', suiteId: cohort, mode, readRounds,
    faults: { lostReply: store('lose-write-response'), unavailable: store('unavailable') } });
  const value = (name, phase, changes = {}) => ({ contractVersion: 1, mutationId: `${cohort}:${name}:${phase}`,
    run: { id: JSON.stringify(['tick.run.v1', cohort, name, 'v1', 0]), namespace: cohort, jobId: name, scheduleRevision: 'v1', scheduledForMs: 0 },
    state: 'leased', attempt: 1, attemptToken: `${cohort}:${name}:first`, leaseExpiresAtMs: 1000, runDeadlineMs: 10000, ...changes });
  const find = async (key, expected) => {
    for (let i = 0; i < readRounds; i++) {
      const result = await writers[i % contenders].read(key);
      if (result.status === 'found' && typeof result.revision === 'string' && isCoordinationRecord(result.value) && same(result.value, expected)) return result;
    }
    throw new Stop('readback-exhausted');
  };
  const expectWrite = async (key, expected, record, status, fault) => {
    const result = await store(fault).compareAndSwap({ key, expected, value: record });
    if (result.status !== status) throw new Stop('unexpected-write-result', status === 'conflict' && result.status === 'applied' ? 'failed' : 'inconclusive');
  };
  for (const name of ['stale-owner', 'lost-superseded']) {
    const before = trace.length;
    try {
      const key = prefix + name, first = value(name, 'claim');
      if ((await writers[0].read(key)).status !== 'absent') throw new Stop('prefix-in-use');
      await expectWrite(key, { kind: 'absent' }, first, name === 'lost-superseded' ? 'indeterminate' : 'applied', name === 'lost-superseded' ? 'lose-write-response' : undefined);
      const held = await find(key, first);
      const successor = value(name, 'takeover', { attempt: 2, attemptToken: `${cohort}:${name}:successor`, leaseExpiresAtMs: 3000 });
      await expectWrite(key, { kind: 'revision', revision: held.revision }, successor, 'applied');
      const current = await find(key, successor);
      if (current.revision === held.revision) throw new Stop('revision-reused-for-different-value', 'failed');
      // Retain an earlier coherent pair deliberately. This is not a measured stale-read rate.
      await expectWrite(key, { kind: 'revision', revision: held.revision }, value(name, 'old-renew', { leaseExpiresAtMs: 4000 }), 'conflict');
      if (name === 'stale-owner') {
        const { attemptToken, leaseExpiresAtMs, ...base } = first;
        await expectWrite(key, { kind: 'revision', revision: held.revision }, { ...base, state: 'completed', completedAtMs: 2000, mutationId: `${cohort}:${name}:old-settle` }, 'conflict');
      }
      await find(key, successor);
      cases.push({ name, status: 'observed', operations: trace.length - before });
    } catch (error) { cases.push({ name, status: error instanceof Stop ? error.status : 'inconclusive', reason: error instanceof Stop ? error.message : 'scenario-unavailable', operations: trace.length - before }); }
  }
  const racePops = Object.fromEntries(['create-race', 'replace-race'].map((phase) => [phase,
    [...new Set(trace.filter((row) => row.phase === phase && liveMetadata(row)).map((row) => row.receiverPop))]]));
  const completeTrace = trace.every((row) => !row.error) && new Set(trace.map((row) => row.requestId)).size === trace.length;
  const distributed = mode === 'live' && completeTrace && trace.every(liveMetadata)
    && new Set(trace.map((row) => row.serviceId)).size === 1 && new Set(trace.map((row) => row.serviceVersion)).size === 1
    && Object.values(racePops).every((pops) => pops.length >= 2);
  const providerTrace = trace.every((row) => row.injectedFault === 'unavailable' || row.provider?.length === 1
    && typeof row.provider[0].requestId === 'string' && /^[A-Za-z0-9/+_=-]{1,256}$/.test(row.provider[0].requestId));
  const observed = conformance.status === 'observed' && cases.every((c) => c.status === 'observed');
  const failed = conformance.status === 'failed' || cases.some((c) => c.status === 'failed');
  return { schema: 'tick.s3.proof.v1', cohort, mode, status: failed ? 'failed' : observed && distributed && providerTrace ? 'observed' : 'inconclusive', certified: false,
    transport: 's3-http', limits: { contenders, readRounds, maxRequests }, conformance, cases,
    evidence: { operations: trace.length, completeTrace, distributed, providerTrace, racePops },
    meaning: 'Finite conditional-write observations. No server-clock fencing, natural stale-read rate, trigger continuity or exactly-once effects.',
    faults: 'Lost replies and unavailable transports are injected. Earlier ETags are held deliberately; lease timestamps are fixtures, not a clock/skew proof.', trace };
}
