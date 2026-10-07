// Typechecked wiring only. The caller supplies actual adapters and job execution.
import { TICK_CONTRACT_VERSION } from '@pulse-compute/tick';
import type { Clock, CoordinationStore, IdSource, JobDefinition, RunId, TickDefinition } from '@pulse-compute/tick';

export interface MonitorResources {
  readonly observations: {
    // Application-owned persistence semantics; this signature does not certify deduplication.
    save(runId: RunId, status: number): Promise<void>;
  };
  readonly check: (signal: AbortSignal) => Promise<number>;
}

export function bindMonitor(dependencies: {
  readonly store: CoordinationStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly resources: MonitorResources;
  readonly execute: JobDefinition<MonitorResources>['execute'];
}): TickDefinition<MonitorResources> {
  return {
    contractVersion: TICK_CONTRACT_VERSION,
    namespace: 'uptime-proof',
    bindings: {
      coordination: { name: 'scheduler-state', prefix: 'uptime/', store: dependencies.store },
      clock: dependencies.clock,
      ids: dependencies.ids,
      resources: dependencies.resources,
    },
    limits: {
      maxJobsPerTick: 1, maxAttemptsPerRun: 3,
      leaseMs: 10000, runTimeoutMs: 30000, retryDelayMs: 1000,
      maxClockSkewMs: 1000, deadlineSafetyMs: 500,
    },
    jobs: [{
      id: 'check-api',
      schedule: { kind: 'interval', anchorMs: 0, everyMs: 60000, revision: 'v1', missedWindows: 'skip' },
      execute: dependencies.execute,
    }],
  };
}
