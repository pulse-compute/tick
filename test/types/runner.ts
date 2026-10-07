import type { TickDefinition, TickInvocation } from '@pulse-compute/tick';
import { createRunner, JobFailure } from '@pulse-compute/tick/runner';
import type { ExecutionRuntime } from '@pulse-compute/tick/runner';

declare const definition: TickDefinition<{ observations: { save(): Promise<void> } }>;
declare const runtime: ExecutionRuntime;
declare const invocation: TickInvocation;
const runner = createRunner(definition, runtime);
void runner.tick(invocation, { startAt: 0 });
// @ts-expect-error A host without cancellation cannot claim the execution contract.
createRunner(definition, { setTimer: runtime.setTimer });
// @ts-expect-error Failure disposition is deliberate, not arbitrary error text.
new JobFailure('maybe', 'failure');
// @ts-expect-error A timer binding must return its cleanup function.
const badRuntime: ExecutionRuntime = { createCancellationController: runtime.createCancellationController, setTimer() {} };
void badRuntime;
