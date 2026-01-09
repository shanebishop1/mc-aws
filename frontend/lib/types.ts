/**
 * TypeScript types for API responses and payloads
 */

export enum ServerState {
  Running = "running",
  Stopped = "stopped",
  Hibernating = "hibernating",
  Pending = "pending",
  Stopping = "stopping",
  Terminated = "terminated",
  Unknown = "unknown",
}

export interface ServerStatusResponse {
  state: ServerState;
  instanceId: string;
  publicIp?: string;
  hasVolume?: boolean;
  lastUpdated: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface StartServerResponse {
  instanceId: string;
  publicIp: string;
  domain: string;
  message: string;
}

export interface StopServerResponse {
  instanceId: string;
  message: string;
}

export interface BackupResponse {
  backupName?: string;
  message: string;
  output: string;
}

export interface RestoreResponse {
  backupName: string;
  message: string;
  output: string;
  publicIp?: string;
}

export interface HibernateResponse {
  message: string;
  backupOutput: string;
  instanceId?: string; // Optional because hibernating state might not need it? Actually it's useful.
}

export interface ResumeResponse {
  instanceId: string;
  publicIp: string;
  domain: string;
  message: string;
}

export interface BackupInfo {
  name: string;
  date?: string;
}

export interface ListBackupsResponse {
  backups: BackupInfo[];
  count: number;
}

export interface EmailsResponse {
  success: boolean;
  data?: {
    adminEmail: string;
    allowlist: string[];
  };
  error?: string;
}

export interface AllowlistUpdateResponse {
  success: boolean;
  data?: {
    allowlist: string[];
  };
  error?: string;
}

export interface CostBreakdown {
  service: string;
  cost: string;
}

export interface CostData {
  period: { start: string; end: string };
  totalCost: string;
  currency: string;
  breakdown: CostBreakdown[];
  fetchedAt: string;
}

export interface CostsResponse {
  success: boolean;
  data?: CostData;
  cachedAt?: number;
  error?: string;
}

export interface PlayerCountData {
  count: number;
  lastUpdated: string;
}

export interface PlayersResponse {
  success: boolean;
  data?: PlayerCountData;
  error?: string;
}
