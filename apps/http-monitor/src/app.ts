import { createBindings, createCoordinationBinding } from '@pulse-compute/tick/bindings';
import type { Clock, IdSource, TickDefinition, ExecutionLimits, IntervalSchedule } from '@pulse-compute/tick';
import type { FastlyKvOptions } from '@pulse-compute/tick/adapters/fastly-kv';
import { createRunner } from '@pulse-compute/tick/runner';
import type { ExecutionRuntime } from '@pulse-compute/tick/runner';
import { createFastlyTrigger } from '@pulse-compute/tick/adapters/fastly-trigger';
import type { FastlyTriggerOptions } from '@pulse-compute/tick/adapters/fastly-trigger';
import type { MonitorResources } from './monitor.js';
import { createMonitorJob } from './monitor.js';

export interface MonitorSettings {
  readonly namespace: string;
  readonly monitorId: string;
  readonly coordinationPrefix: string;
  readonly admissionPrefix: string;
  readonly schedule: IntervalSchedule;
  readonly admissionSchedule: IntervalSchedule;
  readonly limits: ExecutionLimits;
  readonly requestTimeoutMs: number;
}
export interface MonitorHost {
  readonly kv: FastlyKvOptions;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly runtime: ExecutionRuntime;
  readonly resources: MonitorResources;
  readonly loadToken: () => Promise<string | undefined>;
  readonly requestId: () => string;
  readonly metadata?: FastlyTriggerOptions<MonitorResources>['metadata'];
}
export function createMonitorApp(settings: MonitorSettings, host: MonitorHost) {
  const stores = { state: { kind: 'fastly-kv-http' as const, options: host.kv } };
  const bindings = createBindings({ coordination: { name: 'state', prefix: settings.coordinationPrefix }, stores,
    clock: host.clock, ids: host.ids, resources: host.resources,
    validateResources: (value) => typeof value.probe?.check === 'function' && typeof value.observations?.read === 'function' && typeof value.observations?.putIfAbsent === 'function' });
  if (settings.limits.maxJobsPerTick !== 1) throw new TypeError('One monitor per example application');
  const definition: TickDefinition<MonitorResources> = { contractVersion: 1, namespace: settings.namespace, bindings,
    limits: settings.limits, jobs: [{ id: settings.monitorId, schedule: settings.schedule, execute: createMonitorJob(bindings.clock) }] };
  const admission = { coordination: createCoordinationBinding({ name: 'state', prefix: settings.admissionPrefix }, stores),
    schedule: settings.admissionSchedule, limits: settings.limits };
  return Object.freeze({ definition, runner: createRunner(definition, host.runtime),
    handle: createFastlyTrigger({ definition, admission, runtime: host.runtime, requestTimeoutMs: settings.requestTimeoutMs,
      loadToken: host.loadToken, requestId: host.requestId, ...(host.metadata ? { metadata: host.metadata } : {}) }) });
}
