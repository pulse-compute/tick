const ID = /^[A-Za-z0-9._-]{1,80}$/;
const CASES = ['missing-revision', 'create-race', 'replace-race', 'stale-owner', 'crash-takeover', 'lost-response', 'uncertain-superseded'];
class Stop extends Error {
  constructor(message, verdict = 'inconclusive') { super(message); this.verdict = verdict; }
}
const bounded = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const sameValue = (actual, expected) => actual === expected || (actual !== null && expected !== null
  && typeof actual === 'object' && typeof expected === 'object'
  && Array.isArray(actual) === Array.isArray(expected) && Object.keys(actual).length === Object.keys(expected).length
  && Object.keys(expected).every((key) => Object.hasOwn(actual, key) && sameValue(actual[key], expected[key])));
const liveMetadata = (o) => o && /^[A-Z][A-Z0-9]{1,11}$/.test(o.receiverPop)
  && !['LOCAL', 'UNKNOWN'].includes(o.receiverPop) && /^[A-Za-z0-9]{10,80}$/.test(o.serviceId)
  && /^[1-9][0-9]*$/.test(o.serviceVersion);

/** Bounded storage observations, not a scheduler. Lease times below are explicit fixtures. */
export async function runProof({ call, experiment, mode = 'synthetic', contenders = 4,
  pollAttempts = 6, pollDelayMs = 100, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!ID.test(experiment) || !['synthetic', 'live'].includes(mode) || !bounded(contenders, 2, 16)
    || !bounded(pollAttempts, 1, 20) || !bounded(pollDelayMs, 0, 1000)) throw new Error('Invalid proof options');
  const trace = [], cases = [];
  let mutation = 0, requests = 0;
  const prefix = `tick02/${experiment}/`;
  const value = (name, changes = {}) => ({ contractVersion: 1, mutationId: `${experiment}-${++mutation}`,
    run: { id: JSON.stringify(['tick.run.v1', 'tick02', name, 'v1', 0]), namespace: 'tick02',
      jobId: name, scheduleRevision: 'v1', scheduledForMs: 0 }, attempt: 1, runDeadlineMs: 60000,
    state: 'leased', attemptToken: `${experiment}-attempt-${mutation}`, leaseExpiresAtMs: 1000, ...changes });
  const operation = async (payload) => {
    if (++requests > 256) throw new Stop('request budget exhausted');
    const entry = { sequence: requests, request: { experiment, ...payload }, startedAtMs: Date.now() };
    trace.push(entry);
    try { entry.response = await call(entry.request); }
    catch { entry.error = 'transport_unavailable'; }
    entry.finishedAtMs = Date.now();
    const response = entry.response;
    if (!response || response.schema !== 'tick.kv.observation.v1' || response.experiment !== experiment
      || response.operation !== payload.operation || response.transport !== 'fastly-kv-http'
      || typeof response.requestId !== 'string' || !response.requestId || !Number.isSafeInteger(response.receivedAtMs)
      || typeof response.deadlineExceeded !== 'boolean' || !['abort-signal', 'host-timeouts'].includes(response.cancellation)
      || !response.result || typeof response.result.status !== 'string') throw new Stop('missing or invalid observation');
    return response;
  };
  const read = (key) => operation({ operation: 'read', key: prefix + key });
  const write = (key, expected, record, fault) => operation({ operation: 'compareAndSwap',
    write: { key: prefix + key, expected, value: record }, ...(fault ? { fault } : {}) });
  const expect = (observation, status) => {
    if (observation.result.status !== status) throw new Stop(`expected ${status}, observed ${observation.result.status}`,
      status === 'conflict' && observation.result.status === 'applied' ? 'fail' : 'inconclusive');
    return observation.result;
  };
  const find = async (key, record) => {
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      const result = (await read(key)).result;
      if (result.status === 'found' && sameValue(result.value, record)
        && typeof result.revision === 'string' && result.revision) return result;
      if (attempt + 1 < pollAttempts) await delay(pollDelayMs);
    }
    throw new Stop('bounded read reconciliation exhausted');
  };
  const seed = async (key) => {
    const record = value(key);
    expect(await write(key, { kind: 'absent' }, record), 'applied');
    return find(key, record);
  };
  const replace = async (key, current, changes = {}) => {
    const record = { ...current.value, ...changes, mutationId: `${experiment}-${++mutation}` };
    expect(await write(key, { kind: 'revision', revision: current.revision }, record), 'applied');
    return record;
  };
  const complete = (record) => {
    const { attemptToken, leaseExpiresAtMs, ...base } = record;
    return { ...base, state: 'completed', completedAtMs: 2000, mutationId: `${experiment}-${++mutation}` };
  };
  const runCase = async (name, fn) => {
    const first = trace.length;
    try { await fn(); cases.push({ name, verdict: 'observed', operations: trace.length - first }); }
    catch (error) { cases.push({ name, verdict: error instanceof Stop ? error.verdict : 'inconclusive',
      reason: error instanceof Stop ? error.message : 'scenario_error', operations: trace.length - first }); }
  };
  const race = async (name, expected) => {
    // Capture every contender, including rejected transports; an incomplete race cannot pass.
    const proposed = Array.from({ length: contenders }, () => value(name));
    const settled = await Promise.allSettled(proposed.map((record) => write(name, expected, record)));
    const observations = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    const applied = observations.filter((o) => o.result.status === 'applied').length;
    if (applied > 1) throw new Stop('multiple conditional writes applied to one precondition', 'fail');
    if (applied !== 1 || observations.length !== contenders
      || observations.some((o) => !['applied', 'conflict'].includes(o.result.status))) throw new Stop('race has uncertain outcomes');
    const winner = settled.findIndex((s) => s.status === 'fulfilled' && s.value.result.status === 'applied');
    await find(name, proposed[winner]);
  };

  await runCase('fresh-keys', async () => {
    const settled = await Promise.allSettled(CASES.map(read));
    if (settled.some((s) => s.status === 'rejected')) throw new Stop('incomplete freshness check');
    const observations = settled.map((s) => s.value);
    for (const observation of observations) {
      if (observation.result.status === 'found') throw new Stop('experiment keys already exist; choose a fresh experiment');
      expect(observation, 'absent');
    }
  });
  if (cases[0].verdict === 'observed') {
    await runCase('missing-revision', async () => {
      expect(await write('missing-revision', { kind: 'revision', revision: '9007199254740993' },
        value('missing-revision')), 'conflict');
    });
    await runCase('create-race', () => race('create-race', { kind: 'absent' }));
    await runCase('replace-race', async () => {
      const current = await seed('replace-race');
      await race('replace-race', { kind: 'revision', revision: current.revision });
    });
    await runCase('stale-owner', async () => {
      const stale = await seed('stale-owner');
      await replace('stale-owner', stale, { attempt: 2, attemptToken: `${experiment}-successor`, leaseExpiresAtMs: 3000 });
      expect(await write('stale-owner', { kind: 'revision', revision: stale.revision },
        { ...stale.value, mutationId: `${experiment}-${++mutation}`, leaseExpiresAtMs: 4000 }), 'conflict');
      expect(await write('stale-owner', { kind: 'revision', revision: stale.revision }, complete(stale.value)), 'conflict');
    });
    await runCase('crash-takeover', async () => {
      const stale = await seed('crash-takeover');
      // Fixture clock 2000 > seeded lease 1000; no real expiry waiting or store-clock predicate.
      const successor = await replace('crash-takeover', stale,
        { attempt: 2, attemptToken: `${experiment}-takeover`, leaseExpiresAtMs: 3000 });
      await find('crash-takeover', successor);
      expect(await write('crash-takeover', { kind: 'revision', revision: stale.revision }, complete(stale.value)), 'conflict');
    });
    for (const name of ['lost-response', 'uncertain-superseded']) await runCase(name, async () => {
      const record = value(name);
      const lost = await write(name, { kind: 'absent' }, record, 'lose-write-response');
      expect(lost, 'indeterminate');
      if (lost.injectedFault !== 'lose-write-response') throw new Stop('response-loss injection not observed');
      const held = await find(name, record);
      if (name === 'lost-response') {
        const revalidated = await replace(name, held, { leaseExpiresAtMs: 3000 });
        await find(name, revalidated);
      } else {
        await replace(name, held, { attempt: 2, attemptToken: `${experiment}-new-owner`, leaseExpiresAtMs: 3000 });
        expect(await write(name, { kind: 'revision', revision: held.revision },
          { ...record, mutationId: `${experiment}-${++mutation}`, leaseExpiresAtMs: 3000 }), 'conflict');
      }
    });
  }
  const observations = trace.map((t) => t.response).filter(Boolean);
  const racePops = Object.fromEntries(['create-race', 'replace-race'].map((name) => [name,
    [...new Set(trace.filter((t) => t.request.write?.key === prefix + name
      && t.request.write.expected.kind === (name === 'create-race' ? 'absent' : 'revision'))
      .map((t) => t.response).filter(liveMetadata).map((o) => o.receiverPop))]]));
  const completeTrace = observations.length === trace.length && new Set(observations.map((o) => o.requestId)).size === trace.length;
  const distributed = mode === 'live' && completeTrace && observations.every((o) => liveMetadata(o) && !o.deadlineExceeded)
    && new Set(observations.map((o) => o.serviceId)).size === 1
    && new Set(observations.map((o) => o.serviceVersion)).size === 1
    && Object.values(racePops).every((pops) => pops.length >= 2);
  const allCases = cases.length === CASES.length + 1 && cases.every((c) => c.verdict === 'observed');
  const verdict = cases.some((c) => c.verdict === 'fail') ? 'fail' : allCases && distributed ? 'observed' : 'inconclusive';
  return { schema: 'tick.kv.proof.v1', experiment, mode, verdict, transport: 'fastly-kv-http',
    meaning: 'Bounded conditional-write observations only; no execution, natural stale-read rate, timing fencing, or exactly-once guarantee.',
    faults: 'Response loss is injected after successful PUT; stale revisions are deliberately held; expired leases are fixtures.',
    limits: { contenders, pollAttempts, pollDelayMs, maxRequests: 256 },
    evidence: { completeTrace, distributed, racePops, operations: trace.length }, cases, trace };
}
