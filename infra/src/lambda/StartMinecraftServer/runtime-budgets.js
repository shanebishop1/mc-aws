/**
 * Runtime budget constants for mutating actions handled by this Lambda.
 *
 * These ceilings are intentionally explicit so Story 1.1 can keep
 * polling/timeout assumptions synchronized with infrastructure timeout settings.
 */

// Shared EC2 polling ceilings
export const INSTANCE_STATE_POLL_INTERVAL_MS = 5000;
export const INSTANCE_STATE_MAX_ATTEMPTS = 20; // 100s

export const PUBLIC_IP_POLL_INTERVAL_MS = 1000;
export const PUBLIC_IP_MAX_ATTEMPTS = 60; // 60s

// Shared SSM ceilings. The remote command is always terminated before Lambda's
// polling budget, leaving time to observe terminal state and run finalization.
export const SSM_POLL_INTERVAL_MS = 2000;
export const SSM_MAX_ATTEMPTS = 195; // 390s, dynamically capped by the invocation deadline
export const SSM_TIMEOUT_SECONDS = 360;
export const SSM_CANCEL_MAX_ATTEMPTS = 10; // 20s to observe cancellation
export const SSM_SEND_RETRY_INTERVAL_MS = 5000;
export const SSM_SEND_MAX_ATTEMPTS = 4; // 20s for the agent to reconnect after EC2 starts
export const LAMBDA_FINALIZATION_MARGIN_MS = 60 * 1000;
export const MAX_OPERATION_RUNTIME_MS = 13 * 60 * 1000;

// Backup cache refresh is a short listing operation and must not consume a full mutation budget.
export const BACKUPS_REFRESH_SSM_MAX_ATTEMPTS = 30; // 60s
export const BACKUPS_REFRESH_SSM_TIMEOUT_SECONDS = 45;

export const READINESS_SSM_MAX_ATTEMPTS = 45; // 90s poll budget
export const READINESS_SSM_TIMEOUT_SECONDS = 75;

export const HIBERNATE_BACKUP_SSM_MAX_ATTEMPTS = 75; // 150s observation budget
export const HIBERNATE_BACKUP_SSM_TIMEOUT_SECONDS = 120;

// Hibernate-specific ceilings
export const HIBERNATE_STOP_DELIVERY_MAX_ATTEMPTS = 3; // 15s to disambiguate a lost StopInstances response
export const VOLUME_DETACH_POLL_INTERVAL_MS = 2000;
export const VOLUME_DETACH_MAX_ATTEMPTS = 30; // 60s per volume

// Resume-specific ceilings
export const VOLUME_AVAILABLE_POLL_INTERVAL_MS = 5000;
export const VOLUME_AVAILABLE_MAX_ATTEMPTS = 12; // 60s

export const VOLUME_ATTACH_POLL_INTERVAL_MS = 2000;
export const VOLUME_ATTACH_MAX_ATTEMPTS = 15; // 30s

// Resume leaves headroom within the 15-minute Lambda timeout for reconstruction, startup, and finalization.
export const RESUME_SSM_MAX_ATTEMPTS = 165; // 330s observation budget
export const RESUME_SSM_TIMEOUT_SECONDS = 300;
