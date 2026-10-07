import type { CancellationSignal, TickDefinition } from '@pulse-compute/tick';
import { createCooperativeController } from '@pulse-compute/tick/cancellation';
import { createFastlyTrigger } from '@pulse-compute/tick/adapters/fastly-trigger';
import type { FastlyTriggerOptions } from '@pulse-compute/tick/adapters/fastly-trigger';
import type { ExecutionRuntime } from '@pulse-compute/tick/runner';

declare const options: FastlyTriggerOptions<{ observations: unknown }>;
const receiver: (request: Request) => Promise<Response> = createFastlyTrigger(options);
const runtime: ExecutionRuntime = {
  createCancellationController: createCooperativeController,
  setTimer(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};
const signal: CancellationSignal = createCooperativeController().signal;
// @ts-expect-error Notification-only signals do not implement native fetch cancellation.
const fetchOptions: RequestInit = { signal };
const nativeRuntime: ExecutionRuntime = { ...runtime, createCancellationController() {
  const controller = new AbortController();
  return { signal: controller.signal, nativeSignal: controller.signal, abort: () => controller.abort() };
} };
const execute: TickDefinition<{}>['jobs'][number]['execute'] = async (context) => {
  if (context.transportSignal) await fetch('https://example.test', { signal: context.transportSignal });
  // @ts-expect-error A job's cooperative signal is not a branded AbortSignal.
  const native: AbortSignal = context.signal;
  void native;
};
void [receiver, runtime, fetchOptions, nativeRuntime, execute];
