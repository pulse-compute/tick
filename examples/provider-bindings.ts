// Request-scoped host dependencies. No provider discovery, provisioning, or credentials in a definition.
import { createBindings, createCoordinationBinding } from '@pulse-compute/tick/bindings';
import type { CoordinationMappings } from '@pulse-compute/tick/bindings';
import type { FastlyKvOptions } from '@pulse-compute/tick/adapters/fastly-kv';
import type { Clock, IdSource } from '@pulse-compute/tick';
import type { MonitorResources } from './bindings.js';

export function mapMonitorDependencies(host: {
  readonly coordination: FastlyKvOptions;
  readonly clock: Clock;
  readonly ids: IdSource;
  // For example, an application-supplied S3 observations adapter and HTTP probe function.
  readonly resources: MonitorResources;
}) {
  const stores = { 'scheduler-state': { kind: 'fastly-kv-http', options: host.coordination } } satisfies CoordinationMappings;
  const bindings = createBindings({ coordination: { name: 'scheduler-state', prefix: 'uptime/jobs/' },
    stores, clock: host.clock, ids: host.ids, resources: host.resources,
    validateResources: (resources) => typeof resources.observations?.save === 'function' && typeof resources.check === 'function' });
  const admission = createCoordinationBinding({ name: 'scheduler-state', prefix: 'uptime/admission/' }, stores);
  return { bindings, admission };
}
