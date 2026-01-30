/**
 * Mock AWS provider implementation
 * Provides stub implementations for testing and local development
 * This provider does NOT initialize any AWS SDK clients
 */

import type { Stack } from "@aws-sdk/client-cloudformation";
import type { CostData } from "../types";
import { ServerState } from "../types";
import type { AwsProvider, BackupInfo, InstanceDetails, PlayerCount, ServerActionLock } from "./types";

/**
 * Mock AWS provider for testing and local development
 * All operations return stub values or throw descriptive errors
 */
export const mockProvider: AwsProvider = {
  // EC2 - Instance Management
  findInstanceId: async (): Promise<string> => {
    console.log("[MOCK] findInstanceId called");
    return "i-mock-instance-id";
  },

  resolveInstanceId: async (instanceId?: string): Promise<string> => {
    console.log("[MOCK] resolveInstanceId called with:", instanceId);
    return instanceId || "i-mock-instance-id";
  },

  getInstanceState: async (instanceId?: string): Promise<ServerState> => {
    console.log("[MOCK] getInstanceState called for:", instanceId);
    return ServerState.Stopped;
  },

  getInstanceDetails: async (instanceId?: string): Promise<InstanceDetails> => {
    console.log("[MOCK] getInstanceDetails called for:", instanceId);
    return {
      instance: { InstanceId: instanceId || "i-mock-instance-id" },
      state: "stopped",
      publicIp: "203.0.113.1",
      blockDeviceMappings: [],
      az: "us-east-1a",
    };
  },

  startInstance: async (instanceId?: string): Promise<void> => {
    console.log("[MOCK] startInstance called for:", instanceId);
    // No-op in mock mode
  },

  stopInstance: async (instanceId?: string): Promise<void> => {
    console.log("[MOCK] stopInstance called for:", instanceId);
    // No-op in mock mode
  },

  getPublicIp: async (instanceId: string): Promise<string> => {
    console.log("[MOCK] getPublicIp called for:", instanceId);
    return "203.0.113.1";
  },

  waitForInstanceRunning: async (instanceId: string, timeoutSeconds?: number): Promise<void> => {
    console.log("[MOCK] waitForInstanceRunning called for:", instanceId, "timeout:", timeoutSeconds);
    // No-op in mock mode
  },

  waitForInstanceStopped: async (instanceId: string, timeoutSeconds?: number): Promise<void> => {
    console.log("[MOCK] waitForInstanceStopped called for:", instanceId, "timeout:", timeoutSeconds);
    // No-op in mock mode
  },

  // EC2 - Volume Management
  detachAndDeleteVolumes: async (instanceId?: string): Promise<void> => {
    console.log("[MOCK] detachAndDeleteVolumes called for:", instanceId);
    // No-op in mock mode
  },

  handleResume: async (instanceId?: string): Promise<void> => {
    console.log("[MOCK] handleResume called for:", instanceId);
    // No-op in mock mode
  },

  // SSM - Command Execution
  executeSSMCommand: async (instanceId: string, commands: string[]): Promise<string> => {
    console.log("[MOCK] executeSSMCommand called for:", instanceId, "commands:", commands);
    return "Mock SSM command output";
  },

  listBackups: async (instanceId?: string): Promise<BackupInfo[]> => {
    console.log("[MOCK] listBackups called for:", instanceId);
    return [
      { name: "backup-2024-01-01.tar.gz", size: "1.2GB", date: "2024-01-01" },
      { name: "backup-2024-01-02.tar.gz", size: "1.3GB", date: "2024-01-02" },
    ];
  },

  // SSM - Parameter Store
  getParameter: async (name: string): Promise<string | null> => {
    console.log("[MOCK] getParameter called for:", name);
    // Return null for most parameters to simulate not found
    return null;
  },

  putParameter: async (name: string, value: string, type?: "String" | "SecureString"): Promise<void> => {
    console.log("[MOCK] putParameter called for:", name, "value:", value, "type:", type);
    // No-op in mock mode
  },

  deleteParameter: async (name: string): Promise<void> => {
    console.log("[MOCK] deleteParameter called for:", name);
    // No-op in mock mode
  },

  // SSM - Application-Specific Parameters
  getEmailAllowlist: async (): Promise<string[]> => {
    console.log("[MOCK] getEmailAllowlist called");
    return [];
  },

  updateEmailAllowlist: async (emails: string[]): Promise<void> => {
    console.log("[MOCK] updateEmailAllowlist called with:", emails);
    // No-op in mock mode
  },

  getPlayerCount: async (): Promise<PlayerCount> => {
    console.log("[MOCK] getPlayerCount called");
    return { count: 0, lastUpdated: new Date().toISOString() };
  },

  getServerAction: async (): Promise<ServerActionLock | null> => {
    console.log("[MOCK] getServerAction called");
    return null;
  },

  setServerAction: async (action: string): Promise<void> => {
    console.log("[MOCK] setServerAction called with:", action);
    // No-op in mock mode
  },

  // SSM - Action Lock
  withServerActionLock: async <T>(actionName: string, fn: () => Promise<T>): Promise<T> => {
    console.log("[MOCK] withServerActionLock called for:", actionName);
    // In mock mode, just execute the function without locking
    return fn();
  },

  // Cost Explorer
  getCosts: async (periodType?: "current-month" | "last-month" | "last-30-days"): Promise<CostData> => {
    console.log("[MOCK] getCosts called with period:", periodType);
    return {
      period: { start: "2024-01-01", end: "2024-01-31" },
      totalCost: "0.00",
      currency: "USD",
      breakdown: [],
      fetchedAt: new Date().toISOString(),
    };
  },

  // CloudFormation
  getStackStatus: async (stackName?: string): Promise<Stack | null> => {
    console.log("[MOCK] getStackStatus called for:", stackName);
    return null;
  },

  checkStackExists: async (stackName?: string): Promise<boolean> => {
    console.log("[MOCK] checkStackExists called for:", stackName);
    return false;
  },
};
