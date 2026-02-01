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
  serverAction?: { action: string; timestamp: number } | null;
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

export interface RestoreRequest {
  backupName?: string;
  name?: string; // For backward compatibility
  instanceId?: string;
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
  size?: string;
}

export interface ListBackupsResponse {
  backups: BackupInfo[];
  count: number;
}

export interface EmailData {
  adminEmail: string;
  allowlist: string[];
}

export type EmailsResponse = ApiResponse<EmailData & { cachedAt?: number }>;

export interface AllowlistUpdateData {
  allowlist: string[];
}

export type AllowlistUpdateResponse = ApiResponse<AllowlistUpdateData>;

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

export type CostsResponse = ApiResponse<CostData & { cachedAt?: number }>;

export interface PlayerCountData {
  count: number;
  lastUpdated: string;
}

export type PlayersResponse = ApiResponse<PlayerCountData>;

export interface StackStatusResponse {
  exists: boolean;
  status?: string; // e.g., "CREATE_COMPLETE", "UPDATE_IN_PROGRESS"
  stackId?: string;
  error?: string; // Only if AWS connection failed
}

export interface GDriveStatusResponse {
  configured: boolean;
  error?: string;
}
