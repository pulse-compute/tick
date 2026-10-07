// Explicit logical mappings; provider handles and credentials remain application-owned.
import type { CoordinationBinding, TickDefinition } from '@pulse-compute/tick';
import { createFastlyTrigger } from '@pulse-compute/tick/adapters/fastly-trigger';
import type { ExecutionRuntime } from '@pulse-compute/tick/runner';
import type { MonitorResources } from './bindings.js';

export function monitorTrigger(
  definition: TickDefinition<MonitorResources>, admissionState: CoordinationBinding,
  runtime: ExecutionRuntime, loadToken: () => Promise<string | undefined>, requestId: () => string,
) {
  return createFastlyTrigger({ definition, runtime, loadToken, requestId, requestTimeoutMs: 5_000,
    admission: {
      // Use a prefix distinct from definition.bindings.coordination.prefix.
      coordination: admissionState,
      // Application chooses a cadence sufficient to rotate through its bounded job list.
      schedule: { kind: 'interval', anchorMs: 0, everyMs: 1_000, revision: 'v1', missedWindows: 'skip' },
      limits: definition.limits,
    },
  });
}
