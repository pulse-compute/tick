// Typed application wiring, not a deployed host integration.
import type { TickDefinition, TickInvocation } from '@pulse-compute/tick';
import { createRunner } from '@pulse-compute/tick/runner';
import type { ExecutionRuntime } from '@pulse-compute/tick/runner';
import type { MonitorResources } from './bindings.js';

export function monitorRunner(definition: TickDefinition<MonitorResources>, runtime: ExecutionRuntime) {
  return createRunner(definition, runtime);
}

export async function visitMonitors(
  runner: ReturnType<typeof monitorRunner>, invocation: TickInvocation, startAt = 0,
) {
  return runner.tick(invocation, { startAt });
}

// An application owns effect deduplication in save(); the runner does not supply it.
export const observe: TickDefinition<MonitorResources>['jobs'][number]['execute'] = async (context, resources) => {
  const status = await resources.check(context.signal);
  if (context.signal.aborted) return;
  await resources.observations.save(context.run.id, status);
};
