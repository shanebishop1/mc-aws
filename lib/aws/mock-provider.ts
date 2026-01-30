/**
 * Mock AWS provider implementation
 * Provides realistic mock implementations for testing and local development
 * This provider does NOT initialize any AWS SDK clients
 */

import type { Stack } from "@aws-sdk/client-cloudformation";
import { type CostData, ServerState } from "../types";
import { getMockStateStore } from "./mock-state-store";
import type { AwsProvider, BackupInfo, InstanceDetails, PlayerCount, ServerActionLock } from "./types";

// Constants for state transition delays (in milliseconds)
const PENDING_DELAY_MS = 2500; // 2.5 seconds
const STOPPING_DELAY_MS = 2500; // 2.5 seconds
const POLL_INTERVAL_MS = 500; // 0.5 seconds for polling

// Constants for polling
const MAX_POLL_ATTEMPTS = 300;

/**
 * Mock AWS provider for testing and local development
 * Simulates realistic AWS behavior with state transitions and delays
 */
export const mockProvider: AwsProvider = {
  // EC2 - Instance Management
  findInstanceId: async (): Promise<string> => {
    console.log("[MOCK] findInstanceId called");
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();
    return instance.instanceId;
  },

  resolveInstanceId: async (instanceId?: string): Promise<string> => {
    console.log("[MOCK] resolveInstanceId called with:", instanceId);
    if (instanceId) {
      return instanceId;
    }
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();
    return instance.instanceId;
  },

  getInstanceState: async (instanceId?: string): Promise<ServerState> => {
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log("[MOCK] getInstanceState called for:", resolvedId);
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();
    return instance.state;
  },

  getInstanceDetails: async (instanceId?: string): Promise<InstanceDetails> => {
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log("[MOCK] getInstanceDetails called for:", resolvedId);
    const stateStore = getMockStateStore();
    const instance = await stateStore.getInstance();

    // Determine if hibernating based on state and volume presence
    const isHibernating = instance.state === "stopped" && !instance.hasVolume;

    return {
      instance: { InstanceId: instance.instanceId },
      state: isHibernating ? "stopped" : instance.state,
      publicIp: instance.publicIp,
      blockDeviceMappings: instance.blockDeviceMappings || [],
      az: instance.availabilityZone,
    };
  },

  startInstance: async (instanceId?: string): Promise<void> => {
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Sending start command for instance ${resolvedId}`);
    const stateStore = getMockStateStore();

    // Check current state
    const currentState = await stateStore.getInstance();
    if (currentState.state === "running") {
      console.log(`[MOCK] Instance ${resolvedId} is already running`);
      return;
    }

    if (currentState.state !== "stopped") {
      throw new Error(`Cannot start instance in state: ${currentState.state}`);
    }

    // Transition to pending state
    console.log(`[MOCK] Instance ${resolvedId} transitioning to pending state`);
    await stateStore.updateInstanceState(ServerState.Pending);

    // Simulate AWS delay before transitioning to running
    setTimeout(async () => {
      console.log(`[MOCK] Instance ${resolvedId} transitioning to running state`);
      await stateStore.updateInstanceState(ServerState.Running);
    }, PENDING_DELAY_MS);
  },

  stopInstance: async (instanceId?: string): Promise<void> => {
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Sending stop command for instance ${resolvedId}`);
    const stateStore = getMockStateStore();

    // Check current state
    const currentState = await stateStore.getInstance();
    if (currentState.state === "stopped") {
      console.log(`[MOCK] Instance ${resolvedId} is already stopped`);
      return;
    }

    if (currentState.state !== "running") {
      throw new Error(`Cannot stop instance in state: ${currentState.state}`);
    }

    // Transition to stopping state
    console.log(`[MOCK] Instance ${resolvedId} transitioning to stopping state`);
    await stateStore.updateInstanceState(ServerState.Stopping);

    // Simulate AWS delay before transitioning to stopped
    setTimeout(async () => {
      console.log(`[MOCK] Instance ${resolvedId} transitioning to stopped state`);
      await stateStore.updateInstanceState(ServerState.Stopped);
    }, STOPPING_DELAY_MS);
  },

  getPublicIp: async (instanceId: string): Promise<string> => {
    console.log(`[MOCK] Polling for public IP address for instance: ${instanceId}`);
    let attempts = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      try {
        const details = await mockProvider.getInstanceDetails(instanceId);
        const { publicIp, state } = details;

        console.log(
          `[MOCK] Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}: state=${state}, ip=${publicIp || "not assigned"}`
        );

        if (publicIp) {
          return publicIp;
        }

        if (["stopped", "stopping", "terminated", "shutting-down"].includes(state || "")) {
          throw new Error(`Instance entered unexpected state ${state} while waiting for IP`);
        }
      } catch (error) {
        if (attempts >= MAX_POLL_ATTEMPTS) {
          throw new Error(`Failed to get public IP after ${attempts} attempts: ${error}`);
        }
        console.error(`[MOCK] Error on attempt ${attempts}:`, error);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error("[MOCK] Timed out waiting for public IP address");
  },

  waitForInstanceRunning: async (instanceId: string, timeoutSeconds = 300): Promise<void> => {
    console.log(`[MOCK] waitForInstanceRunning called for: ${instanceId}, timeout: ${timeoutSeconds}s`);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const details = await mockProvider.getInstanceDetails(instanceId);
      const { state } = details;

      if (state === "running") {
        console.log(`[MOCK] Instance ${instanceId} is now running`);
        return;
      }

      if (["terminated", "terminating"].includes(state || "")) {
        throw new Error(`Instance entered unexpected state: ${state}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`[MOCK] Instance did not reach running state within ${timeoutSeconds} seconds`);
  },

  waitForInstanceStopped: async (instanceId: string, timeoutSeconds = 300): Promise<void> => {
    console.log(`[MOCK] waitForInstanceStopped called for: ${instanceId}, timeout: ${timeoutSeconds}s`);
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const details = await mockProvider.getInstanceDetails(instanceId);
      const { state } = details;

      if (state === "stopped") {
        console.log(`[MOCK] Instance ${instanceId} is now stopped`);
        return;
      }

      if (["terminated", "terminating"].includes(state || "")) {
        throw new Error(`Instance entered unexpected state: ${state}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`[MOCK] Instance did not reach stopped state within ${timeoutSeconds} seconds`);
  },

  // EC2 - Volume Management
  detachAndDeleteVolumes: async (instanceId?: string): Promise<void> => {
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Detaching and deleting volumes for instance ${resolvedId}...`);
    const stateStore = getMockStateStore();

    const instance = await stateStore.getInstance();
    const blockDeviceMappings = instance.blockDeviceMappings || [];
    console.log(`[MOCK] Found ${blockDeviceMappings.length} block device mappings`);

    for (const mapping of blockDeviceMappings) {
      const volumeId = mapping.volumeId;
      if (!volumeId) {
        console.log("[MOCK] Skipping mapping with no VolumeId");
        continue;
      }

      console.log(`[MOCK] Detaching volume ${volumeId}...`);
      // Simulate detachment delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`[MOCK] Volume ${volumeId} detached`);

      console.log(`[MOCK] Deleting volume ${volumeId}...`);
      // Simulate deletion delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`[MOCK] Volume ${volumeId} deleted successfully`);
    }

    // Remove volumes from instance state
    await stateStore.setHasVolume(false);
    console.log("[MOCK] All volumes detached and deleted");
  },

  handleResume: async (instanceId?: string): Promise<void> => {
    const resolvedId = instanceId || (await mockProvider.resolveInstanceId());
    console.log(`[MOCK] Checking if instance ${resolvedId} needs volume restoration...`);
    const stateStore = getMockStateStore();

    const instance = await stateStore.getInstance();
    const blockDeviceMappings = instance.blockDeviceMappings || [];

    if (blockDeviceMappings.length > 0) {
      console.log(
        `[MOCK] Instance ${resolvedId} already has ${blockDeviceMappings.length} volume(s). Skipping resume.`
      );
      return;
    }

    console.log(`[MOCK] Instance ${resolvedId} has no volumes. Proceeding with hibernation recovery...`);

    if (!instance.availabilityZone) {
      throw new Error(`Could not determine availability zone for instance ${resolvedId}`);
    }

    console.log("[MOCK] Looking up Amazon Linux 2023 ARM64 AMI...");
    const amiId = "ami-mock1234567890abcdef";
    console.log(`[MOCK] Found latest AMI: ${amiId}`);

    const snapshotId = "snap-mock1234567890abcdef";
    console.log(`[MOCK] Using snapshot: ${snapshotId}`);

    console.log("[MOCK] Creating new 8GB GP3 volume from snapshot...");
    const volumeId = `vol-mock${Date.now().toString(16)}`;
    console.log(`[MOCK] Volume created: ${volumeId}`);

    // Simulate volume creation delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(`[MOCK] Volume ${volumeId} is now available`);

    console.log(`[MOCK] Attaching volume ${volumeId} to instance ${resolvedId} at /dev/xvda...`);

    // Simulate attachment delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(`[MOCK] Volume ${volumeId} is now attached to instance ${resolvedId}`);

    // Update instance state to reflect new volume
    await stateStore.setHasVolume(true);
    console.log(`[MOCK] Successfully restored volume for instance ${resolvedId}`);
  },

  // SSM - Command Execution
  executeSSMCommand: async (instanceId: string, commands: string[]): Promise<string> => {
    console.log("[MOCK] executeSSMCommand called for:", instanceId, "commands:", commands);
    const stateStore = getMockStateStore();

    // Add command to history
    const commandId = await stateStore.addCommand(commands);
    console.log(`[MOCK] SSM command sent with ID: ${commandId}`);

    // Simulate command execution delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Update command status to InProgress
    await stateStore.updateCommand(commandId, { status: "InProgress" });

    // Simulate realistic execution based on command type
    let output = "";
    const status: "Success" | "Failed" = "Success";

    const commandString = commands.join(" ");

    if (commandString.includes("ListBackups") || commandString.includes("rclone lsf")) {
      // Simulate listing backups
      const backups = await stateStore.getBackups();
      output = backups.map((b) => `${b.name}|${b.size}|${b.date}`).join("\n");
    } else if (commandString.includes("GetPlayerCount")) {
      // Simulate getting player count
      const playerCount = await stateStore.getParameter("/minecraft/player-count");
      output = playerCount || "0";
    } else if (commandString.includes("UpdateEmailAllowlist")) {
      // Simulate updating email allowlist
      output = "Email allowlist updated successfully";
    } else if (commandString.includes("backup") || commandString.includes("Backup")) {
      // Simulate backup operation
      output = "Backup completed successfully";
    } else if (commandString.includes("start") || commandString.includes("Start")) {
      // Simulate start operation
      output = "Server started successfully";
    } else if (commandString.includes("stop") || commandString.includes("Stop")) {
      // Simulate stop operation
      output = "Server stopped successfully";
    } else {
      // Generic command output
      output = `Command executed: ${commandString}`;
    }

    // Simulate additional processing time
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Update command status to Success
    await stateStore.updateCommand(commandId, {
      status,
      output,
      completedAt: new Date().toISOString(),
    });

    console.log(`[MOCK] SSM command completed successfully. Command ID: ${commandId}`);
    return output;
  },

  listBackups: async (instanceId?: string): Promise<BackupInfo[]> => {
    console.log("[MOCK] listBackups called for:", instanceId);
    const stateStore = getMockStateStore();
    const backups = await stateStore.getBackups();

    // Convert to BackupInfo format
    return backups.map((b) => ({
      name: b.name,
      size: b.size,
      date: b.date,
    }));
  },

  // SSM - Parameter Store
  getParameter: async (name: string): Promise<string | null> => {
    console.log("[MOCK] getParameter called for:", name);
    const stateStore = getMockStateStore();
    return stateStore.getParameter(name);
  },

  putParameter: async (name: string, value: string, type?: "String" | "SecureString"): Promise<void> => {
    console.log("[MOCK] putParameter called for:", name, "value:", value, "type:", type);
    const stateStore = getMockStateStore();
    await stateStore.setParameter(name, value, type || "String");
  },

  deleteParameter: async (name: string): Promise<void> => {
    console.log("[MOCK] deleteParameter called for:", name);
    const stateStore = getMockStateStore();
    await stateStore.deleteParameter(name);
  },

  // SSM - Application-Specific Parameters
  getEmailAllowlist: async (): Promise<string[]> => {
    console.log("[MOCK] getEmailAllowlist called");
    const stateStore = getMockStateStore();
    const value = await stateStore.getParameter("/minecraft/email-allowlist");

    if (!value) {
      return [];
    }

    try {
      // Try to parse as JSON array
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // If not JSON, split by comma
      return value
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
    }

    return [];
  },

  updateEmailAllowlist: async (emails: string[]): Promise<void> => {
    console.log("[MOCK] updateEmailAllowlist called with:", emails);
    const stateStore = getMockStateStore();
    // Store as JSON array
    await stateStore.setParameter("/minecraft/email-allowlist", JSON.stringify(emails), "String");
  },

  getPlayerCount: async (): Promise<PlayerCount> => {
    console.log("[MOCK] getPlayerCount called");
    const stateStore = getMockStateStore();
    const value = await stateStore.getParameter("/minecraft/player-count");
    const count = value ? Number.parseInt(value, 10) : 0;

    return {
      count,
      lastUpdated: new Date().toISOString(),
    };
  },

  getServerAction: async (): Promise<ServerActionLock | null> => {
    console.log("[MOCK] getServerAction called");
    const stateStore = getMockStateStore();
    const value = await stateStore.getParameter("/minecraft/server-action");

    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as { action: string; timestamp: number };

      // Check if the action is stale (older than 30 minutes)
      const expirationMs = 30 * 60 * 1000;
      if (Date.now() - parsed.timestamp > expirationMs) {
        console.log("[MOCK] Found stale action marker, clearing it:", parsed.action);
        await stateStore.deleteParameter("/minecraft/server-action");
        return null;
      }

      return parsed;
    } catch {
      // Invalid format, treat as no action
      return null;
    }
  },

  setServerAction: async (action: string): Promise<void> => {
    console.log("[MOCK] setServerAction called with:", action);
    const stateStore = getMockStateStore();
    const value = JSON.stringify({
      action,
      timestamp: Date.now(),
    });
    await stateStore.setParameter("/minecraft/server-action", value, "String");
  },

  // SSM - Action Lock
  withServerActionLock: async <T>(actionName: string, fn: () => Promise<T>): Promise<T> => {
    console.log("[MOCK] withServerActionLock called for:", actionName);

    // Check if an action is already in progress
    const currentAction = await mockProvider.getServerAction();
    if (currentAction) {
      throw new Error(`Cannot start ${actionName}. Another operation is in progress: ${currentAction.action}`);
    }

    // Set this action as in progress
    await mockProvider.setServerAction(actionName);
    console.log(`[MOCK] [ACTION] Started: ${actionName}`);

    try {
      // Execute the action
      const result = await fn();
      console.log(`[MOCK] [ACTION] Completed: ${actionName}`);
      return result;
    } finally {
      // Always clear the action marker
      try {
        await mockProvider.deleteParameter("/minecraft/server-action");
        console.log(`[MOCK] [ACTION] Cleared marker for: ${actionName}`);
      } catch (error) {
        console.error(`[MOCK] [ACTION] Failed to clear marker for: ${actionName}`, error);
      }
    }
  },

  // Cost Explorer
  getCosts: async (
    periodType: "current-month" | "last-month" | "last-30-days" = "current-month"
  ): Promise<CostData> => {
    console.log("[MOCK] getCosts called with period:", periodType);
    const stateStore = getMockStateStore();

    // Check for fault injection
    const failureConfig = await stateStore.getOperationFailure("getCosts");
    if (failureConfig?.failNext || failureConfig?.alwaysFail) {
      if (failureConfig.failNext) {
        await stateStore.clearOperationFailure("getCosts");
      }
      const error = new Error(failureConfig.errorMessage || "Mock Cost Explorer error");
      (error as any).name = failureConfig.errorCode || "CostExplorerError";
      throw error;
    }

    // Apply global latency if configured
    const latencyMs = await stateStore.getGlobalLatency();
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    // Get cost data from state store
    const costData = await stateStore.getCosts(periodType);

    console.log(`[MOCK] Returning cost data for ${periodType}:`, costData.totalCost);
    return costData;
  },

  // CloudFormation
  getStackStatus: async (stackName = "MinecraftStack"): Promise<Stack | null> => {
    console.log("[MOCK] getStackStatus called for:", stackName);
    const stateStore = getMockStateStore();

    // Check for fault injection
    const failureConfig = await stateStore.getOperationFailure("getStackStatus");
    if (failureConfig?.failNext || failureConfig?.alwaysFail) {
      if (failureConfig.failNext) {
        await stateStore.clearOperationFailure("getStackStatus");
      }
      const error = new Error(failureConfig.errorMessage || "Mock CloudFormation error");
      (error as any).name = failureConfig.errorCode || "ValidationError";
      throw error;
    }

    // Apply global latency if configured
    const latencyMs = await stateStore.getGlobalLatency();
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    // Get stack status from state store
    const stackState = await stateStore.getStackStatus();

    if (!stackState.exists) {
      console.log(`[MOCK] Stack "${stackName}" does not exist`);
      return null;
    }

    // Get instance details for stack outputs
    const instance = await stateStore.getInstance();

    // Build realistic Stack object
    const stack: Stack = {
      StackName: stackName,
      StackId: stackState.stackId,
      StackStatus: stackState.status as any,
      CreationTime: new Date("2024-01-01T00:00:00Z"),
      Description: "Minecraft Server Infrastructure",
      Parameters: [
        {
          ParameterKey: "InstanceType",
          ParameterValue: "t4g.medium",
        },
        {
          ParameterKey: "KeyName",
          ParameterValue: "minecraft-key",
        },
      ],
      Outputs: [
        {
          OutputKey: "InstanceId",
          OutputValue: instance.instanceId,
          Description: "EC2 Instance ID",
        },
        {
          OutputKey: "PublicIP",
          OutputValue: instance.publicIp || "N/A",
          Description: "Public IP Address",
        },
        {
          OutputKey: "AvailabilityZone",
          OutputValue: instance.availabilityZone || "us-east-1a",
          Description: "Availability Zone",
        },
      ],
      Tags: [
        {
          Key: "Project",
          Value: "Minecraft",
        },
        {
          Key: "Environment",
          Value: "Production",
        },
      ],
    };

    console.log(`[MOCK] Stack "${stackName}" status:`, stackState.status);
    return stack;
  },

  checkStackExists: async (stackName = "MinecraftStack"): Promise<boolean> => {
    console.log("[MOCK] checkStackExists called for:", stackName);
    const stateStore = getMockStateStore();

    // Check for fault injection
    const failureConfig = await stateStore.getOperationFailure("checkStackExists");
    if (failureConfig?.failNext || failureConfig?.alwaysFail) {
      if (failureConfig.failNext) {
        await stateStore.clearOperationFailure("checkStackExists");
      }
      const error = new Error(failureConfig.errorMessage || "Mock CloudFormation error");
      (error as any).name = failureConfig.errorCode || "ValidationError";
      throw error;
    }

    // Apply global latency if configured
    const latencyMs = await stateStore.getGlobalLatency();
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    // Get stack status from state store
    const stackState = await stateStore.getStackStatus();
    const exists = stackState.exists;

    console.log(`[MOCK] Stack "${stackName}" exists:`, exists);
    return exists;
  },
};
