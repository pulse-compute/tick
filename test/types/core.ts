import type { LeasedRecord, TickInvocation } from '@pulse-compute/tick';
import type { JobCoordinator, OwnershipLease, PendingTransition } from '@pulse-compute/tick/core';

declare const coordinator: JobCoordinator;
declare const invocation: TickInvocation;
declare const record: LeasedRecord;
declare const lease: OwnershipLease;
declare const pending: PendingTransition;

// @ts-expect-error Stored data cannot manufacture an ownership receipt.
const forged: OwnershipLease = { record, deadlineMs: 1 };
// @ts-expect-error An ambiguous transition is not ownership.
coordinator.renew(pending);
// @ts-expect-error A stored record is not an ownership receipt.
coordinator.settle(record, { kind: 'completed' });
// @ts-expect-error Renewal cannot replace the original invocation budget.
coordinator.renew(lease, invocation);
// @ts-expect-error A retry must provide a bounded failure code.
coordinator.settle(lease, { kind: 'retry' });
// @ts-expect-error The core does not expose storage revisions on ownership receipts.
lease.revision;

void forged;
