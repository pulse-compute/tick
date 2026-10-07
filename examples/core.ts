// Wiring only: an executor and trigger handler are separate concerns.
import type { Clock, CoordinationStore, IdSource, TickInvocation } from '@pulse-compute/tick';
import { createJobCoordinator } from '@pulse-compute/tick/core';

export function coordinateMonitor(dependencies: {
  readonly store: CoordinationStore;
  readonly clock: Clock;
  readonly ids: IdSource;
}) {
  return createJobCoordinator({
    namespace: 'uptime',
    job: {
      id: 'homepage',
      schedule: { kind: 'interval', anchorMs: 0, everyMs: 60_000, revision: 'v1', missedWindows: 'skip' },
    },
    coordination: { name: 'scheduler-state', prefix: 'uptime/', store: dependencies.store },
    clock: dependencies.clock,
    ids: dependencies.ids,
    limits: {
      maxAttemptsPerRun: 3, leaseMs: 10_000, runTimeoutMs: 30_000,
      retryDelayMs: 1_000, maxClockSkewMs: 1_000, deadlineSafetyMs: 500,
    },
  });
}

export async function claimMonitor(
  coordinator: ReturnType<typeof coordinateMonitor>, invocation: TickInvocation,
) {
  const result = await coordinator.claim(invocation);
  if (result.status === 'owned') {
    // This is a local time check, not an atomic application commit guard.
    return { result, usable: coordinator.isUsable(result.lease) };
  }
  return { result, usable: false };
}
