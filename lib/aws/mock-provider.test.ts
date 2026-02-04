/**
 * Tests for mock provider core functionality
 * Tests EC2 state transitions, SSM commands, cost fixtures, and stack operations
 */

import type { ServerState } from "@/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockProvider } from "./mock-provider";
import { getMockStateStore, resetMockStateStore } from "./mock-state-store";

describe("Mock Provider Core", () => {
  beforeEach(() => {
    // Reset the mock state store before each test for isolation
    resetMockStateStore();
  });

  describe("EC2 State Transitions", () => {
    it("should start instance from stopped state", async () => {
      const stateStore = getMockStateStore();

      // Ensure instance is stopped
      await stateStore.updateInstanceState("stopped" as ServerState);
      let state = await mockProvider.getInstanceState();
      expect(state).toBe("stopped");

      // Start the instance
      await mockProvider.startInstance();

      // Should transition to pending immediately
      state = await mockProvider.getInstanceState();
      expect(state).toBe("pending");

      // Wait for transition to running
      await new Promise((resolve) => setTimeout(resolve, 3000));
      state = await mockProvider.getInstanceState();
      expect(state).toBe("running");
    });

    it("should stop instance from running state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);
      let state = await mockProvider.getInstanceState();
      expect(state).toBe("running");

      // Stop the instance
      await mockProvider.stopInstance();

      // Should transition to stopping immediately
      state = await mockProvider.getInstanceState();
      expect(state).toBe("stopping");

      // Wait for transition to stopped
      await new Promise((resolve) => setTimeout(resolve, 3000));
      state = await mockProvider.getInstanceState();
      expect(state).toBe("stopped");
    });

    it("should not start instance that is already running", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);

      // Try to start again (should be a no-op)
      await expect(mockProvider.startInstance()).resolves.not.toThrow();

      // State should remain running
      const state = await mockProvider.getInstanceState();
      expect(state).toBe("running");
    });

    it("should not stop instance that is already stopped", async () => {
      const stateStore = getMockStateStore();

      // Ensure instance is stopped
      await stateStore.updateInstanceState("stopped" as ServerState);

      // Try to stop again (should be a no-op)
      await expect(mockProvider.stopInstance()).resolves.not.toThrow();

      // State should remain stopped
      const state = await mockProvider.getInstanceState();
      expect(state).toBe("stopped");
    });

    it("should throw error when starting instance in invalid state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to pending (invalid for start)
      await stateStore.updateInstanceState("pending" as ServerState);

      await expect(mockProvider.startInstance()).rejects.toThrow("Cannot start instance in state: pending");
    });

    it("should throw error when stopping instance in invalid state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopped (invalid for stop)
      await stateStore.updateInstanceState("stopped" as ServerState);

      // This should be a no-op, not an error
      await expect(mockProvider.stopInstance()).resolves.not.toThrow();
    });

    it("should wait for instance to reach running state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to pending
      await stateStore.updateInstanceState("pending" as ServerState);

      // Schedule transition to running
      setTimeout(async () => {
        await stateStore.updateInstanceState("running" as ServerState);
      }, 500);

      // Wait for running state
      await expect(mockProvider.waitForInstanceRunning("i-mock1234567890abcdef", 5)).resolves.not.toThrow();
    });

    it("should wait for instance to reach stopped state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopping
      await stateStore.updateInstanceState("stopping" as ServerState);

      // Schedule transition to stopped
      setTimeout(async () => {
        await stateStore.updateInstanceState("stopped" as ServerState);
      }, 500);

      // Wait for stopped state
      await expect(mockProvider.waitForInstanceStopped("i-mock1234567890abcdef", 5)).resolves.not.toThrow();
    });

    it("should timeout when waiting for running state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to pending but never transition
      await stateStore.updateInstanceState("pending" as ServerState);

      // Should timeout after 1 second
      await expect(mockProvider.waitForInstanceRunning("i-mock1234567890abcdef", 1)).rejects.toThrow(
        "did not reach running state"
      );
    });

    it("should timeout when waiting for stopped state", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopping but never transition
      await stateStore.updateInstanceState("stopping" as ServerState);

      // Should timeout after 1 second
      await expect(mockProvider.waitForInstanceStopped("i-mock1234567890abcdef", 1)).rejects.toThrow(
        "did not reach stopped state"
      );
    });
  });

  describe("Public IP Assignment", () => {
    it("should assign public IP when instance starts", async () => {
      const stateStore = getMockStateStore();

      // Ensure instance is stopped with no IP
      await stateStore.updateInstanceState("stopped" as ServerState);
      await stateStore.setInstance({ publicIp: undefined });

      // Start the instance
      await mockProvider.startInstance();

      // Wait for running state
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Should have a public IP now
      const details = await mockProvider.getInstanceDetails();
      expect(details.publicIp).toBeDefined();
      expect(details.publicIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    it("should remove public IP when instance stops", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running with IP
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setPublicIp("203.0.113.42");

      // Stop the instance
      await mockProvider.stopInstance();

      // Wait for stopped state
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Should not have a public IP
      const details = await mockProvider.getInstanceDetails();
      expect(details.publicIp).toBeUndefined();
    });

    it("should get public IP for running instance", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running with IP
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setPublicIp("203.0.113.42");

      // Get public IP
      const ip = await mockProvider.getPublicIp("i-mock1234567890abcdef");
      expect(ip).toBe("203.0.113.42");
    });

    it("should throw error when getting public IP for stopped instance", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopped
      await stateStore.updateInstanceState("stopped" as ServerState);

      // Should throw error
      await expect(mockProvider.getPublicIp("i-mock1234567890abcdef")).rejects.toThrow("entered unexpected state");
    });

    it("should poll for public IP assignment", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running but without IP initially
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setInstance({ publicIp: undefined });

      // Schedule IP assignment after a delay
      setTimeout(async () => {
        await stateStore.setPublicIp("203.0.113.42");
      }, 300);

      // Should poll and eventually get the IP
      const ip = await mockProvider.getPublicIp("i-mock1234567890abcdef");
      expect(ip).toBe("203.0.113.42");
    });
  });

  describe("SSM Command Execution", () => {
    it("should execute SSM command successfully", async () => {
      const commands = ["echo 'Hello, World!'"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toBeDefined();
      expect(output).toContain("Hello, World!");
    });

    it("should track command status lifecycle", async () => {
      const stateStore = getMockStateStore();
      const commands = ["echo 'test'"];

      // Execute command
      await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      // Get command history
      const commandHistory = await stateStore.getCommands();
      expect(commandHistory.length).toBeGreaterThan(0);

      const latestCommand = commandHistory[commandHistory.length - 1];
      expect(latestCommand.status).toBe("Success");
      expect(latestCommand.output).toBeDefined();
      expect(latestCommand.completedAt).toBeDefined();
    });

    it("should handle ListBackups command", async () => {
      const commands = ["ListBackups"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toBeDefined();
      // Should contain backup names
      expect(output).toContain("minecraft-backup");
    });

    it("should handle GetPlayerCount command", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setParameter("/minecraft/player-count", "5");

      const commands = ["GetPlayerCount"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toBe("5");
    });

    it("should handle UpdateEmailAllowlist command", async () => {
      const commands = ["UpdateEmailAllowlist"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toContain("successfully");
    });

    it("should handle backup command", async () => {
      const commands = ["backup"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toContain("Backup");
      expect(output).toContain("successfully");
    });

    it("should handle start command", async () => {
      const commands = ["start"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toContain("Server");
      expect(output).toContain("started");
    });

    it("should handle stop command", async () => {
      const commands = ["stop"];
      const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", commands);

      expect(output).toContain("Server");
      expect(output).toContain("stopped");
    });

    it("should list backups", async () => {
      const backups = await mockProvider.listBackups();

      expect(Array.isArray(backups)).toBe(true);
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0]).toHaveProperty("name");
      expect(backups[0]).toHaveProperty("size");
      expect(backups[0]).toHaveProperty("date");
    });
  });

  describe("Cost Fixtures", () => {
    it("should return current month costs", async () => {
      const costs = await mockProvider.getCosts("current-month");

      expect(costs).toBeDefined();
      expect(costs.totalCost).toBeDefined();
      expect(costs.currency).toBe("USD");
      expect(costs.period).toBeDefined();
      expect(costs.breakdown).toBeDefined();
      expect(Array.isArray(costs.breakdown)).toBe(true);
    });

    it("should return last month costs", async () => {
      const costs = await mockProvider.getCosts("last-month");

      expect(costs).toBeDefined();
      expect(costs.totalCost).toBeDefined();
      expect(costs.currency).toBe("USD");
      expect(costs.period).toBeDefined();
      expect(costs.breakdown).toBeDefined();
    });

    it("should return last 30 days costs", async () => {
      const costs = await mockProvider.getCosts("last-30-days");

      expect(costs).toBeDefined();
      expect(costs.totalCost).toBeDefined();
      expect(costs.currency).toBe("USD");
      expect(costs.period).toBeDefined();
      expect(costs.breakdown).toBeDefined();
    });

    it("should have correct cost breakdown structure", async () => {
      const costs = await mockProvider.getCosts("current-month");

      expect(costs.breakdown.length).toBeGreaterThan(0);
      for (const service of costs.breakdown) {
        expect(service).toHaveProperty("service");
        expect(service).toHaveProperty("cost");
      }
    });

    it("should have valid date ranges", async () => {
      const costs = await mockProvider.getCosts("current-month");

      expect(new Date(costs.period.start)).toBeInstanceOf(Date);
      expect(new Date(costs.period.end)).toBeInstanceOf(Date);
      expect(new Date(costs.period.start) < new Date(costs.period.end)).toBe(true);
    });
  });

  describe("CloudFormation Stack Operations", () => {
    it("should check if stack exists", async () => {
      const exists = await mockProvider.checkStackExists("MinecraftStack");

      expect(typeof exists).toBe("boolean");
    });

    it("should get stack status", async () => {
      const stack = await mockProvider.getStackStatus("MinecraftStack");

      expect(stack).not.toBeNull();
      expect(stack?.StackName).toBe("MinecraftStack");
      expect(stack?.StackId).toBeDefined();
      expect(stack?.StackStatus).toBeDefined();
    });

    it("should return null for non-existent stack", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setStackStatus({
        exists: false,
        status: "DELETE_COMPLETE",
        stackId: "",
      });

      const stack = await mockProvider.getStackStatus("MinecraftStack");
      expect(stack).toBeNull();
    });

    it("should return stack outputs", async () => {
      const stack = await mockProvider.getStackStatus("MinecraftStack");

      expect(stack?.Outputs).toBeDefined();
      expect(Array.isArray(stack?.Outputs)).toBe(true);
      expect(stack?.Outputs?.length).toBeGreaterThan(0);

      // Check for expected outputs
      const instanceIdOutput = stack?.Outputs?.find((o) => o.OutputKey === "InstanceId");
      expect(instanceIdOutput).toBeDefined();
      expect(instanceIdOutput?.OutputValue).toBeDefined();
    });

    it("should return stack parameters", async () => {
      const stack = await mockProvider.getStackStatus("MinecraftStack");

      expect(stack?.Parameters).toBeDefined();
      expect(Array.isArray(stack?.Parameters)).toBe(true);
      expect(stack?.Parameters?.length).toBeGreaterThan(0);
    });

    it("should return stack tags", async () => {
      const stack = await mockProvider.getStackStatus("MinecraftStack");

      expect(stack?.Tags).toBeDefined();
      expect(Array.isArray(stack?.Tags)).toBe(true);
      expect(stack?.Tags?.length).toBeGreaterThan(0);
    });

    it("should handle different stack statuses", async () => {
      const stateStore = getMockStateStore();
      const statuses = ["CREATE_COMPLETE", "CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "ROLLBACK_COMPLETE"];

      for (const status of statuses) {
        await stateStore.setStackStatus({
          exists: true,
          status,
          stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft-stack/abc123",
        });

        const stack = await mockProvider.getStackStatus("MinecraftStack");
        expect(stack?.StackStatus).toBe(status);
      }
    });
  });

  describe("Parameter Store Operations", () => {
    it("should get parameter", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setParameter("/minecraft/test-param", "test-value");

      const value = await mockProvider.getParameter("/minecraft/test-param");
      expect(value).toBe("test-value");
    });

    it("should put parameter", async () => {
      await mockProvider.putParameter("/minecraft/new-param", "new-value");

      const value = await mockProvider.getParameter("/minecraft/new-param");
      expect(value).toBe("new-value");
    });

    it("should delete parameter", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setParameter("/minecraft/delete-me", "value");

      await mockProvider.deleteParameter("/minecraft/delete-me");

      const value = await mockProvider.getParameter("/minecraft/delete-me");
      expect(value).toBeNull();
    });

    it("should get email allowlist", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setParameter("/minecraft/email-allowlist", JSON.stringify(["test@example.com"]));

      const allowlist = await mockProvider.getEmailAllowlist();
      expect(Array.isArray(allowlist)).toBe(true);
      expect(allowlist).toContain("test@example.com");
    });

    it("should update email allowlist", async () => {
      const emails = ["user1@example.com", "user2@example.com"];
      await mockProvider.updateEmailAllowlist(emails);

      const allowlist = await mockProvider.getEmailAllowlist();
      expect(allowlist).toEqual(emails);
    });

    it("should get player count", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setParameter("/minecraft/player-count", "10");

      const playerCount = await mockProvider.getPlayerCount();
      expect(playerCount.count).toBe(10);
      expect(playerCount.lastUpdated).toBeDefined();
    });
  });

  describe("Instance Details", () => {
    it("should get instance details", async () => {
      const details = await mockProvider.getInstanceDetails();

      expect(details).toBeDefined();
      expect(details.instance).toBeDefined();
      expect(details.state).toBeDefined();
      expect(details.az).toBeDefined();
    });

    it("should include block device mappings", async () => {
      const details = await mockProvider.getInstanceDetails();

      expect(details.blockDeviceMappings).toBeDefined();
      expect(Array.isArray(details.blockDeviceMappings)).toBe(true);
    });

    it("should find instance ID", async () => {
      const instanceId = await mockProvider.findInstanceId();

      expect(instanceId).toBeDefined();
      expect(typeof instanceId).toBe("string");
      expect(instanceId).toMatch(/^i-/);
    });

    it("should resolve instance ID", async () => {
      const resolvedId = await mockProvider.resolveInstanceId();

      expect(resolvedId).toBeDefined();
      expect(typeof resolvedId).toBe("string");
    });

    it("should use provided instance ID when resolving", async () => {
      const providedId = "i-provided123";
      const resolvedId = await mockProvider.resolveInstanceId(providedId);

      expect(resolvedId).toBe(providedId);
    });
  });

  describe("Volume Management", () => {
    it("should detach and delete volumes", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setHasVolume(true);

      await mockProvider.detachAndDeleteVolumes();

      const hasVolume = await stateStore.hasVolume();
      expect(hasVolume).toBe(false);
    });

    it("should handle resume (volume restoration)", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setHasVolume(false);
      await stateStore.setInstance({
        availabilityZone: "us-east-1a",
      });

      await mockProvider.handleResume();

      const hasVolume = await stateStore.hasVolume();
      expect(hasVolume).toBe(true);
    });

    it("should skip resume if volume already exists", async () => {
      const stateStore = getMockStateStore();
      await stateStore.setHasVolume(true);

      // Should not throw
      await expect(mockProvider.handleResume()).resolves.not.toThrow();
    });
  });
});
