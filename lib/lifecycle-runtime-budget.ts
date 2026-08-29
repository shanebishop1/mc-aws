// Backend contract for the longest accepted lifecycle operation. Client polling
// should use the per-operation deadlineAt when available and may use this value as fallback.
export const LIFECYCLE_OPERATION_MAX_DURATION_MS = 17 * 60 * 1000;

// Lambda async events may remain eligible for delivery for one hour and a
// delivered invocation may then run for 15 minutes. The lifecycle lock's
// 90-minute lease is the conservative boundary for declaring a dispatch lost.
export const LIFECYCLE_LOCK_LEASE_MS = 90 * 60 * 1000;
