import { createBindings, createCoordinationBinding } from '@pulse-compute/tick/bindings';
import type { CoordinationMapping } from '@pulse-compute/tick/bindings';
import type { Clock, CoordinationStore, IdSource, RunId, TickDefinition } from '@pulse-compute/tick';
import { runStoreConformance } from '@pulse-compute/tick/testing/conformance';
import type { ConformanceOptions, ConformanceReport } from '@pulse-compute/tick/testing/conformance';

declare const clock: Clock;
declare const ids: IdSource;
declare const store: CoordinationStore;
declare const resources: { observations: { save(run: RunId): Promise<void> } };
const bindings = createBindings({ coordination: { name: 'state', prefix: 'test/' }, stores: { state: { kind: 'provided', store } },
  clock, ids, resources, validateResources: (value) => typeof value.observations.save === 'function' });
const definition: TickDefinition<typeof resources> = { contractVersion: 1, namespace: 'test', bindings,
  limits: { maxJobsPerTick: 1, maxAttemptsPerRun: 1, leaseMs: 1000, runTimeoutMs: 2000, maxClockSkewMs: 0, deadlineSafetyMs: 1, retryDelayMs: 0 },
  jobs: [{ id: 'check', schedule: { kind: 'interval', everyMs: 1000, anchorMs: 0, revision: 'v1', missedWindows: 'skip' },
    execute: async (context, values) => { await values.observations.save(context.run.id); } }] };
// @ts-expect-error Resources preserve their actual application type.
bindings.resources.observations.save(42);
// @ts-expect-error Native KV cannot implicitly substitute for the explicit HTTP mapping.
const unsupported: CoordinationMapping = { kind: 'fastly-kv-native', store };
// @ts-expect-error Conditional capabilities are required from provided adapters.
createCoordinationBinding({ name: 'state', prefix: '' }, { state: { kind: 'provided', store: { get() {}, put() {} } } });
declare const options: ConformanceOptions;
const report: Promise<ConformanceReport> = runStoreConformance(options);
// @ts-expect-error A conformance run requires explicit evidence mode and isolated keys.
runStoreConformance({ writers: [store, store] });
void [definition, unsupported, report];
