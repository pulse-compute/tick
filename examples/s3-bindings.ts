import { createBindings } from '@pulse-compute/tick/bindings';
import type { Clock, IdSource, RunId } from '@pulse-compute/tick';
import type { S3Options } from '@pulse-compute/tick/adapters/s3';

// Host signs each operation with SigV4, including the condition and payload, then
// sends it once via a fixed uncached backend. Credentials remain in the host closure.
declare const signedTransport: S3Options['fetch'];
declare const clock: Clock;
declare const ids: IdSource;
declare const observations: { save(run: RunId): Promise<void> };
export const bindings = createBindings({
  coordination: { name: 'state', prefix: 'monitor/jobs/' },
  stores: { state: { kind: 's3-http', options: {
    endpoint: 'https://scheduler-state.s3.us-east-1.amazonaws.com', fetch: signedTransport,
  } } },
  clock, ids, resources: { observations },
});
