import type { CoordinationRecord } from '../index.js';

const identifier = /^[A-Za-z0-9._-]{1,80}$/;
const tokenId = /^[A-Za-z0-9._:-]{1,128}$/;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

/** Capture data once, without invoking record/run serialization hooks. */
export function serializeCoordinationRecord(value: unknown): string {
  if (!object(value) || 'toJSON' in value) throw new TypeError('Invalid Tick record');
  const copy: Record<string, unknown> = Object.assign(Object.create(null), value);
  if (!object(copy.run) || 'toJSON' in copy.run) throw new TypeError('Invalid Tick record');
  copy.run = Object.assign(Object.create(null), copy.run);
  if (!isCoordinationRecord(copy)) throw new TypeError('Invalid Tick record');
  const body = JSON.stringify(copy);
  if (!isCoordinationRecord(JSON.parse(body))) throw new TypeError('Invalid Tick record');
  return body;
}

// Validate at the storage boundary. Type assertions alone cannot validate persisted data.
export function isCoordinationRecord(value: unknown): value is CoordinationRecord {
  if (!object(value) || value.contractVersion !== 1 || !matches(value.mutationId, tokenId)
      || !integer(value.attempt) || value.attempt < 1 || !integer(value.runDeadlineMs) || !object(value.run)) return false;
  const run = value.run;
  if (!only(run, ['id', 'namespace', 'jobId', 'scheduleRevision', 'scheduledForMs'])
      || !matches(run.namespace, identifier) || !matches(run.jobId, identifier)
      || !matches(run.scheduleRevision, identifier) || !integer(run.scheduledForMs)
      || run.id !== JSON.stringify(['tick.run.v1', run.namespace, run.jobId, run.scheduleRevision, run.scheduledForMs])) return false;
  const base = ['contractVersion', 'mutationId', 'run', 'attempt', 'runDeadlineMs', 'state'];
  switch (value.state) {
    case 'leased': return only(value, [...base, 'attemptToken', 'leaseExpiresAtMs'])
      && matches(value.attemptToken, tokenId) && integer(value.leaseExpiresAtMs);
    case 'retryable': return only(value, [...base, 'nextAttemptAtMs', 'failureCode'])
      && integer(value.nextAttemptAtMs) && matches(value.failureCode, /^[A-Za-z0-9._:-]{1,80}$/);
    case 'completed': return only(value, [...base, 'completedAtMs']) && integer(value.completedAtMs);
    case 'failed': return only(value, [...base, 'failedAtMs', 'reason']) && integer(value.failedAtMs)
      && ['attempts-exhausted', 'deadline-exceeded', 'permanent-failure'].includes(value.reason as string);
    default: return false;
  }
}
