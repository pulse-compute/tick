import { createS3Store } from '@pulse-compute/tick/adapters/s3';
import type { S3Options } from '@pulse-compute/tick/adapters/s3';
import { createCoordinationBinding } from '@pulse-compute/tick/bindings';
declare const transport: S3Options['fetch'];
const store = createS3Store({ endpoint: 'https://state.s3.us-east-1.amazonaws.com', fetch: transport });
createCoordinationBinding({ name: 's3', prefix: 'jobs/' }, { s3: { kind: 's3-http', options: { endpoint: 'https://state', fetch: transport } } });
// @ts-expect-error S3 requires an explicit bucket endpoint and signed transport.
createS3Store({ bucket: 'state', region: 'us-east-1' });
// @ts-expect-error ETags are opaque strings, never numerical generations.
store.compareAndSwap({ key: 'one', expected: { kind: 'revision', revision: 42 }, value: {} });
