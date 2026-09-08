/**
 * Provider interface for AWS operations
 * Defines all operations needed by API routes
 */

import type { Stack } from "@aws-sdk/client-cloudformation";
import type { CostData, ServerState } from "../types";

/**
 * Instance details returned by getInstanceDetails
 */
export interface InstanceDetails {
  instance: unknown;
  state: string | undefined;
  publicIp: string | undefined;
  blockDeviceMappings: unknown[];
  az: string | undefined;
}

/**
 * Player count information
 */
export interface PlayerCount {
  count: number;
  lastUpdated: string;
}

/**
 * Sanitized service state returned by the lifecycle Lambda. The Worker never
 * receives the underlying SSM command ID or command output.
 */
export interface MinecraftServiceStatus {
  instanceState: ServerState;
  instanceRunning: boolean;
  serviceActive: boolean;
}

/**
 * Backup information
 */
export interface BackupInfo {
  name: string;
  size?: string;
  date?: string;
}

/**
 * Parameter Store entry returned from path lookups
 */
export interface ParameterStoreEntry {
  name: string;
  value: string;
  type?: string;
  /** SSM's monotonically increasing resource version. */
  version?: number;
  lastModifiedAt?: string;
}

/** Proof used by the conditional SSM mutation protocol. */
export interface SsmMutationProof {
  claimToken: string;
  parameterVersion: number;
  claimParameterName?: string;
  claimVersion?: number;
}

/**
 * AWS Provider interface
 * Defines all AWS operations needed by the application
 */
export interface AwsProvider {
  // EC2 - Instance Management
  findInstanceId(): Promise<string>;
  resolveInstanceId(instanceId?: string): Promise<string>;
  getInstanceState(instanceId?: string): Promise<ServerState>;
  getInstanceDetails(instanceId?: string): Promise<InstanceDetails>;
  startInstance(instanceId?: string): Promise<void>;
  stopInstance(instanceId?: string): Promise<void>;
  getPublicIp(instanceId: string, timeoutSeconds?: number): Promise<string>;
  waitForInstanceRunning(instanceId: string, timeoutSeconds?: number): Promise<void>;
  waitForInstanceStopped(instanceId: string, timeoutSeconds?: number): Promise<void>;

  // EC2 - Volume Management
  detachAndDeleteVolumes(instanceId?: string): Promise<void>;
  handleResume(instanceId?: string): Promise<void>;

  // SSM - Command Execution
  executeSSMCommand(instanceId: string, commands: string[]): Promise<string>;
  getMinecraftServiceStatus(instanceId?: string): Promise<MinecraftServiceStatus>;
  listBackups(instanceId?: string): Promise<BackupInfo[]>;

  // SSM - Parameter Store
  getParameter(name: string): Promise<string | null>;
  getParameterRecord(name: string): Promise<ParameterStoreEntry | null>;
  putParameter(
    name: string,
    value: string,
    type?: "String" | "SecureString",
    overwrite?: boolean
  ): Promise<number | undefined>;
  putParameterIfCurrent(
    name: string,
    value: string,
    proof: SsmMutationProof,
    type?: "String" | "SecureString",
    overwrite?: boolean
  ): Promise<boolean>;
  deleteParameter(name: string): Promise<void>;
  deleteParameterIfCurrent(name: string, proof: SsmMutationProof): Promise<boolean>;
  listParametersByPath(path: string): Promise<ParameterStoreEntry[]>;

  // SSM - Application-Specific Parameters
  getEmailAllowlist(): Promise<string[]>;
  updateEmailAllowlist(emails: string[]): Promise<void>;
  getPlayerCount(): Promise<PlayerCount>;

  // Cost Explorer
  getCosts(periodType?: "current-month" | "last-month" | "last-30-days"): Promise<CostData>;

  // CloudFormation
  getStackStatus(stackName?: string): Promise<Stack | null>;
  checkStackExists(stackName?: string): Promise<boolean>;

  // Lambda
  invokeLambda(functionName: string, payload: unknown): Promise<void>;
}
