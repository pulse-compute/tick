import type { CoordinationRecord, CoordinationStore, ReadResult, StoreRevision, WriteResult } from '../index.js';
import { captureCoordination } from '../internal/bindings.js';
import { isCoordinationRecord } from '../internal/records.js';

export interface ConformanceOptions {
  /** All writers must address the same isolated backing store and key domain. */
  readonly writers: readonly CoordinationStore[];
  /** Fresh operator-allocated prefix, exclusive to this invocation. Records are retained. */
  readonly prefix: string;
  /** Unique within retained evidence/state; used in non-secret synthetic record identities. */
  readonly suiteId: string;
  /** Evidence label only; never changes authority or turns this suite into certification. */
  readonly mode: 'synthetic' | 'live';
  /** Bounded readback rounds, no sleeps/retries of writes; default 4, maximum 8. */
  readonly readRounds?: number;
  readonly faults?: {
    /** Same store; discard a successful response at the adapter transport boundary. */
    readonly lostReply?: CoordinationStore;
    /** Same store; inject read/write transport unavailability at the adapter boundary. */
    readonly unavailable?: CoordinationStore;
  };
}
export interface ConformanceCase {
  readonly name: string;
  readonly status: 'observed' | 'failed' | 'inconclusive';
  readonly reason?: string;
  readonly reads: number;
  readonly writes: number;
}
export interface ConformanceReport {
  readonly schema: 'tick.store.conformance.v1';
  readonly mode: 'synthetic' | 'live';
  readonly status: ConformanceCase['status'];
  readonly certified: false;
  readonly cases: readonly ConformanceCase[];
  readonly calls: { readonly reads: number; readonly writes: number };
  readonly bounds: { readonly reads: number; readonly writes: number };
}
class Stop extends Error {
  constructor(readonly status: 'failed' | 'inconclusive', readonly reason: string) { super(reason); }
}
const isStop = (error: unknown): error is Stop => { try { return error instanceof Stop; } catch { return false; } };
const stop = (status: 'failed' | 'inconclusive', reason: string): never => { throw new Stop(status, reason); };
const same = (a: CoordinationRecord, b: CoordinationRecord) => {
  // Both validated records have primitive fields plus a canonical run identity.
  const keys = Object.keys(a) as (keyof CoordinationRecord)[];
  return keys.length === Object.keys(b).length && keys.every((key) => key === 'run' ? a.run.id === b.run.id : a[key] === b[key]);
};
async function all<T>(operations: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations); // Await every write even if another writer fails.
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw failures.find((result) => isStop(result.reason) && result.reason.status === 'failed')?.reason ?? failures[0]!.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/** Explicit diagnostic writes only. Never invoke automatically during application startup. */
export async function runStoreConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  let prefix: string, suiteId: string, mode: ConformanceOptions['mode'], rounds: number;
  let writers: CoordinationStore[], lostReply: CoordinationStore | undefined, unavailable: CoordinationStore | undefined;
  try {
    ({ prefix, suiteId, mode } = options); rounds = options.readRounds ?? 4;
    if (!Array.isArray(options.writers) || options.writers.length < 2 || options.writers.length > 8
      || typeof prefix !== 'string' || !/^[A-Za-z0-9/_-]{1,96}\/$/.test(prefix)
      || typeof suiteId !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(suiteId)
      || !['synthetic', 'live'].includes(mode) || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 8) throw new TypeError();
    const capture = (store: CoordinationStore) => captureCoordination({ name: 'conformance', prefix: '', store }).store;
    writers = Array.from(options.writers, capture);
    const faults = options.faults;
    lostReply = faults?.lostReply === undefined ? undefined : capture(faults.lostReply);
    unavailable = faults?.unavailable === undefined ? undefined : capture(faults.unavailable);
  } catch { throw new TypeError('Invalid Tick conformance configuration'); }
  const calls = { reads: 0, writes: 0 }, cases: ConformanceCase[] = [];
  const pairs = new Map<string, CoordinationRecord>();
  const key = (name: string) => `${prefix}${name}`;
  function record(name: string, phase: string, writer = 0, state: CoordinationRecord['state'] = 'leased'): CoordinationRecord {
    const run = Object.freeze({ id: JSON.stringify(['tick.run.v1', suiteId, name, 'v1', 0]),
      namespace: suiteId, jobId: name, scheduleRevision: 'v1', scheduledForMs: 0 });
    const base = { contractVersion: 1, mutationId: `${suiteId}:${name}:${phase}:${writer}`, run, attempt: 1, runDeadlineMs: 10_000 };
    const value = state === 'leased' ? { ...base, state, attemptToken: `${suiteId}:${name}:owner:${writer}`, leaseExpiresAtMs: 1_000 }
      : state === 'retryable' ? { ...base, state, nextAttemptAtMs: 1_500, failureCode: 'conformance-retry' }
      : state === 'completed' ? { ...base, state, completedAtMs: 500 }
      : { ...base, state, failedAtMs: 500, reason: 'permanent-failure' };
    return Object.freeze(value) as CoordinationRecord;
  }
  async function read(store: CoordinationStore, target: string): Promise<ReadResult> {
    calls.reads++;
    let result;
    try { result = await store.read(target); } catch { return stop('inconclusive', 'read-threw'); }
    try {
      if (result?.status === 'absent' || result?.status === 'unavailable') return { status: result.status };
      if (result?.status !== 'found' || typeof result.revision !== 'string' || !result.revision || result.revision.length > 1024
        || !isCoordinationRecord(result.value)) return stop('failed', 'invalid-read-result');
      const value: unknown = JSON.parse(JSON.stringify(result.value));
      if (!isCoordinationRecord(value)) return stop('failed', 'invalid-read-result');
      const identity = JSON.stringify([target, result.revision]), previous = pairs.get(identity);
      if (previous && !same(previous, value)) return stop('failed', 'incoherent-value-revision');
      Object.freeze(value.run); Object.freeze(value);
      pairs.set(identity, value);
      return { status: 'found', value, revision: result.revision };
    } catch (error) { if (isStop(error)) throw error; return stop('failed', 'invalid-read-result'); }
  }
  async function write(store: CoordinationStore, target: string, value: CoordinationRecord, revision?: StoreRevision): Promise<WriteResult> {
    calls.writes++;
    let result;
    try { result = await store.compareAndSwap(Object.freeze({ key: target, value,
      expected: Object.freeze(revision === undefined ? { kind: 'absent' as const } : { kind: 'revision' as const, revision }) }));
    } catch { return stop('inconclusive', 'write-threw'); }
    try {
      if (!result || !['applied', 'conflict', 'indeterminate'].includes(result.status)) return stop('failed', 'invalid-write-result');
      return { status: result.status };
    } catch (error) { if (isStop(error)) throw error; return stop('failed', 'invalid-write-result'); }
  }
  async function fresh(target: string) {
    const results = await all(writers.map((store) => read(store, target)));
    if (results.some((result) => result.status === 'found')) stop('inconclusive', 'prefix-in-use');
    if (results.some((result) => result.status !== 'absent')) stop('inconclusive', 'read-unavailable');
  }
  async function readback(target: string, expected: CoordinationRecord): Promise<Extract<ReadResult, { status: 'found' }>> {
    for (let round = 0; round < rounds; round++) {
      const results = await all(writers.map((store) => read(store, target)));
      const match = results.find((result): result is Extract<ReadResult, { status: 'found' }> => result.status === 'found' && same(result.value, expected));
      if (match) return match;
    }
    return stop('inconclusive', 'readback-not-observed');
  }
  const applied = (result: WriteResult) => {
    if (result.status !== 'applied') stop('inconclusive', 'write-not-acknowledged');
  };
  async function race(target: string, values: readonly CoordinationRecord[], revision?: StoreRevision) {
    const settled = await Promise.allSettled(writers.map((store, index) => write(store, target, values[index]!, revision)));
    const results = settled.map((result) => result.status === 'fulfilled' ? result.value : undefined);
    const winners = results.map((result, index) => result?.status === 'applied' ? index : -1).filter((index) => index >= 0);
    // A missing contender must never hide an already observed violation.
    if (winners.length > 1) stop('failed', 'multiple-acknowledged-winners');
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw failures.find((result) => isStop(result.reason) && result.reason.status === 'failed')?.reason ?? failures[0]!.reason;
    if (winners.length !== 1 || results.some((result) => result?.status === 'indeterminate')) stop('inconclusive', 'race-incomplete');
    return values[winners[0]!]!;
  }
  async function check(name: string, operation: () => Promise<void>) {
    const before = { ...calls };
    let status: ConformanceCase['status'] = 'observed', reason: string | undefined;
    try { await operation(); } catch (error) {
      status = isStop(error) ? error.status : 'inconclusive';
      reason = isStop(error) ? error.reason : 'operation-unavailable';
    }
    cases.push(Object.freeze({ name, status, ...(reason ? { reason } : {}), reads: calls.reads - before.reads, writes: calls.writes - before.writes }));
  }
  let initial: Extract<ReadResult, { status: 'found' }> | undefined;
  let replacement: Extract<ReadResult, { status: 'found' }> | undefined;
  await check('create-race', async () => {
    await fresh(key('race'));
    const winner = await race(key('race'), writers.map((_, index) => record('race', 'create', index)));
    initial = await readback(key('race'), winner);
  });
  await check('replace-race', async () => {
    if (!initial) stop('inconclusive', 'create-evidence-missing');
    const winner = await race(key('race'), writers.map((_, index) => record('race', 'replace', index, 'completed')), initial!.revision);
    replacement = await readback(key('race'), winner);
  });
  await check('stale-revision', async () => {
    if (!initial || !replacement) stop('inconclusive', 'replacement-evidence-missing');
    const result = await write(writers[0]!, key('race'), record('race', 'stale'), initial!.revision);
    if (result.status === 'applied') stop('failed', 'stale-revision-applied');
    if (result.status !== 'conflict') stop('inconclusive', 'stale-rejection-unknown');
    await readback(key('race'), replacement!.value);
  });
  await check('revision-on-missing', async () => {
    if (!initial) stop('inconclusive', 'revision-evidence-missing');
    await fresh(key('missing'));
    const result = await write(writers[0]!, key('missing'), record('missing', 'replace'), initial!.revision);
    if (result.status === 'applied') stop('failed', 'revision-created-missing-key');
    if (result.status !== 'conflict') stop('inconclusive', 'missing-key-rejection-unknown');
  });
  await check('retained-records', async () => {
    await fresh(key('retained'));
    let revision: StoreRevision | undefined;
    for (const state of ['leased', 'retryable', 'completed', 'failed'] as const) {
      const value = record('retained', state, 0, state);
      applied(await write(writers[0]!, key('retained'), value, revision));
      revision = (await readback(key('retained'), value)).revision;
    }
  });
  await check('lost-reply', async () => {
    if (!lostReply) stop('inconclusive', 'fault-not-bound');
    await fresh(key('ambiguous'));
    const value = record('ambiguous', 'lost');
    if ((await write(lostReply!, key('ambiguous'), value)).status !== 'indeterminate') stop('failed', 'lost-reply-misclassified');
    const observed = await readback(key('ambiguous'), value);
    const revalidation = Object.freeze({ ...value, mutationId: `${suiteId}:ambiguous:revalidate` }) as CoordinationRecord;
    applied(await write(writers[0]!, key('ambiguous'), revalidation, observed.revision));
    await readback(key('ambiguous'), revalidation);
  });
  await check('unavailable-transport', async () => {
    if (!unavailable) stop('inconclusive', 'fault-not-bound');
    await fresh(key('unavailable'));
    if ((await read(unavailable!, key('unavailable'))).status !== 'unavailable') stop('failed', 'unavailable-read-misclassified');
    if ((await write(unavailable!, key('unavailable'), record('unavailable', 'unknown'))).status !== 'indeterminate') {
      stop('failed', 'unavailable-write-misclassified');
    }
  });
  const status = cases.some((value) => value.status === 'failed') ? 'failed'
    : cases.some((value) => value.status === 'inconclusive') ? 'inconclusive' : 'observed';
  return Object.freeze({ schema: 'tick.store.conformance.v1', mode, status, certified: false,
    cases: Object.freeze(cases), calls: Object.freeze(calls),
    bounds: Object.freeze({ reads: 9 * writers.length * rounds + 5 * writers.length + 1, writes: 2 * writers.length + 9 }) });
}
