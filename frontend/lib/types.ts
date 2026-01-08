/**
 * TypeScript types for API responses and payloads
 */

export type ServerState =
  | "running"
  | "stopped"
  | "hibernated"
  | "pending"
  | "stopping"
  | "terminated"
  | "unknown";

export interface ServerStatusResponse {
  state: ServerState;
  instanceId: string;
  publicIp?: string;
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
