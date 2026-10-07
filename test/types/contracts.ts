import { TICK_CONTRACT_VERSION } from '@pulse-compute/tick';
import type {
  AttemptToken, ConditionalWrite, CoordinationRecord, CoordinationStore,
  ExecutionContext, RunId, StoreRevision, WriteResult,
} from '@pulse-compute/tick';

// Package-name imports validate the real declaration export, with no paths alias.
const version: 1 = TICK_CONTRACT_VERSION;
void version;
declare const record: CoordinationRecord;
declare const revision: StoreRevision;
declare const attempt: AttemptToken;
declare const context: ExecutionContext;
declare const store: CoordinationStore;
const create: ConditionalWrite = { key: 'job', expected: { kind: 'absent' }, value: record };
const replace: ConditionalWrite = { key: 'job', expected: { kind: 'revision', revision }, value: record };
void store.compareAndSwap(create);
void store.compareAndSwap(replace);

// @ts-expect-error A plain get/put store cannot claim coordination capabilities.
const weakStore: CoordinationStore = { get: async () => record, put: async () => {} };
// @ts-expect-error There is no unconditional overwrite in the storage contract.
const unsafe: ConditionalWrite = { key: 'job', value: record };
// @ts-expect-error Ownership tokens and storage revisions have different meanings.
const wrongRevision: StoreRevision = attempt;
// @ts-expect-error Numeric provider generations must preserve precision as opaque strings.
const numericRevision: StoreRevision = 9007199254740992;
// @ts-expect-error A run ID is not an attempt token.
const wrongRun: RunId = attempt;
// @ts-expect-error Execution does not receive storage revision or mutation capabilities.
context.revision;
void [weakStore, unsafe, wrongRevision, numericRevision, wrongRun];

function accountForWrite(result: WriteResult): string {
  switch (result.status) {
    case 'applied': return 'known applied; recheck time before work';
    case 'conflict': return 'not applied';
    case 'indeterminate': return 'unknown; no execution';
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
void accountForWrite;
