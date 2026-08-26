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

// Shared SSM polling ceilings. Backups/restores can spend several minutes in rclone uploads/downloads.
export const SSM_POLL_INTERVAL_MS = 2000;
export const SSM_MAX_ATTEMPTS = 300; // 600s
export const SSM_SEND_RETRY_INTERVAL_MS = 5000;
export const SSM_SEND_MAX_ATTEMPTS = 6; // 30s for the agent to reconnect after EC2 starts

// Hibernate-specific ceilings
export const VOLUME_DETACH_POLL_INTERVAL_MS = 2000;
export const VOLUME_DETACH_MAX_ATTEMPTS = 30; // 60s per volume

// Resume-specific ceilings
export const VOLUME_AVAILABLE_POLL_INTERVAL_MS = 5000;
export const VOLUME_AVAILABLE_MAX_ATTEMPTS = 12; // 60s

export const VOLUME_ATTACH_POLL_INTERVAL_MS = 2000;
export const VOLUME_ATTACH_MAX_ATTEMPTS = 15; // 30s

// Resume leaves headroom within the 15-minute Lambda timeout for EC2 reconstruction/startup.
export const RESUME_SSM_MAX_ATTEMPTS = 285; // 570s polling; command is killed by SSM first
export const RESUME_SSM_TIMEOUT_SECONDS = 560;
