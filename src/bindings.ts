import { createFastlyKvStore } from './adapters/fastly-kv.js';
import type { FastlyKvOptions } from './adapters/fastly-kv.js';
import { createS3Store } from './adapters/s3.js';
import type { S3Options } from './adapters/s3.js';
import type { Clock, CoordinationBinding, CoordinationStore, IdSource, Telemetry, TickDefinition } from './index.js';
import { captureClock, captureCoordination, captureIds, captureTelemetry } from './internal/bindings.js';

export type CoordinationMapping =
  | { readonly kind: 'provided'; readonly store: CoordinationStore }
  | { readonly kind: 'fastly-kv-http'; readonly options: FastlyKvOptions }
  | { readonly kind: 's3-http'; readonly options: S3Options };
export type CoordinationMappings = Readonly<Record<string, CoordinationMapping>>;
export interface CoordinationReference { readonly name: string; readonly prefix: string }
export interface BindingOptions<Resources> {
  readonly coordination: CoordinationReference;
  readonly stores: CoordinationMappings;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly resources: Resources;
  /** Application-owned resource shape check; throws/false reject without provider I/O. */
  readonly validateResources?: (resources: Resources) => boolean;
  readonly telemetry?: Telemetry;
}

/** Resolve exactly the named mapping. No native/HTTP fallback or implicit prefixing. */
export function createCoordinationBinding(reference: CoordinationReference, stores: CoordinationMappings): CoordinationBinding {
  try {
    if (!reference || typeof reference.name !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(reference.name)
      || !stores || !Object.prototype.hasOwnProperty.call(stores, reference.name)) throw new TypeError();
    const mapping = stores[reference.name];
    const store = mapping?.kind === 'provided' ? mapping.store
      : mapping?.kind === 'fastly-kv-http' ? createFastlyKvStore(mapping.options)
      : mapping?.kind === 's3-http' ? createS3Store(mapping.options) : undefined;
    if (!store) throw new TypeError();
    return captureCoordination({ name: reference.name, prefix: reference.prefix, store });
  } catch { throw new TypeError('Invalid Tick coordination mapping'); }
}

/** Resolve bindings once; preserve application resources without freezing or cloning them. */
export function createBindings<Resources>(options: BindingOptions<Resources>): TickDefinition<Resources>['bindings'] {
  try {
    if (!options || !Object.prototype.hasOwnProperty.call(options, 'resources')) throw new TypeError();
    const resources = options.resources, validate = options.validateResources;
    const clock = captureClock(options.clock), ids = captureIds(options.ids), telemetry = captureTelemetry(options.telemetry);
    const coordination = createCoordinationBinding(options.coordination, options.stores);
    if (validate !== undefined && (typeof validate !== 'function' || validate(resources) !== true)) throw new TypeError();
    return Object.freeze({ coordination, clock, ids, resources, ...(telemetry ? { telemetry } : {}) });
  } catch { throw new TypeError('Invalid Tick application bindings'); }
}
