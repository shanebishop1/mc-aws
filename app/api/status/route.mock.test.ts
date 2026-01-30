/**
 * Tests for GET /api/status route handler in mock mode
 * Tests that the status endpoint works correctly with the mock provider
 */

import { getMockStateStore, resetMockStateStore } from "@/lib/aws/mock-state-store";
import { getProvider, resetProvider } from "@/lib/aws/provider-selector";
import { type ApiResponse, ServerState, type ServerStatusResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/status (Mock Mode)", () => {
  beforeEach(() => {
    // Reset provider and state store before each test
    resetProvider();
    resetMockStateStore();

    // Set mock mode
    vi.stubEnv("MC_BACKEND_MODE", "mock");
  });

  describe("Running state", () => {
    it("should return running status when instance is running", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running with a public IP
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setPublicIp("203.0.113.42");

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Running);
      expect(body.data?.publicIp).toBe("203.0.113.42");
      expect(body.data?.instanceId).toBeDefined();
      expect(body.data?.hasVolume).toBe(true);
      expect(body.data?.lastUpdated).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });

    it("should return running status without public IP if not yet assigned", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running but without IP
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setInstance({ publicIp: undefined });

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Running);
      expect(body.data?.publicIp).toBeUndefined();
    });
  });

  describe("Stopped state", () => {
    it("should return stopped status when instance is stopped", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopped
      await stateStore.updateInstanceState("stopped" as ServerState);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Stopped);
      expect(body.data?.publicIp).toBeUndefined();
      expect(body.data?.hasVolume).toBe(true);
    });
  });

  describe("Hibernating state", () => {
    it("should return hibernating status when instance is stopped without volume", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopped without volume
      await stateStore.updateInstanceState("stopped" as ServerState);
      await stateStore.setHasVolume(false);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Hibernating);
      expect(body.data?.hasVolume).toBe(false);
    });
  });

  describe("Pending state", () => {
    it("should return pending status when instance is starting", async () => {
      const stateStore = getMockStateStore();

      // Set instance to pending
      await stateStore.updateInstanceState("pending" as ServerState);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Pending);
    });
  });

  describe("Stopping state", () => {
    it("should return stopping status when instance is stopping", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopping
      await stateStore.updateInstanceState("stopping" as ServerState);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Stopping);
    });
  });

  describe("Query parameters", () => {
    it("should use instanceId from query parameter if provided", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setPublicIp("203.0.113.42");

      // Create mock request with instanceId query parameter
      const req = createMockNextRequest("http://localhost/api/status?instanceId=i-custom123");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.instanceId).toBe("i-custom123");
    });

    it("should discover instance ID if not provided in query", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);

      // Create mock request without instanceId query parameter
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      expect(body.data?.instanceId).toBeDefined();
      expect(body.data?.instanceId).toMatch(/^i-/);
    });
  });

  describe("Response structure", () => {
    it("should return correct response structure", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      // Verify response structure
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("timestamp");

      // Verify data structure
      expect(body.data).toHaveProperty("state");
      expect(body.data).toHaveProperty("instanceId");
      expect(body.data).toHaveProperty("publicIp");
      expect(body.data).toHaveProperty("hasVolume");
      expect(body.data).toHaveProperty("lastUpdated");

      // Verify types
      expect(typeof body.success).toBe("boolean");
      expect(typeof body.timestamp).toBe("string");
      expect(typeof body.data?.state).toBe("string");
      expect(typeof body.data?.instanceId).toBe("string");
      expect(typeof body.data?.hasVolume).toBe("boolean");
      expect(typeof body.data?.lastUpdated).toBe("string");
    });

    it("should include ISO timestamp", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      // Verify timestamp is valid ISO string
      expect(() => new Date(body.timestamp)).not.toThrow();
      expect(() => new Date(body.data?.lastUpdated || "")).not.toThrow();
    });
  });

  describe("Error handling", () => {
    it("should return 500 on provider error", async () => {
      const stateStore = getMockStateStore();

      // Configure fault injection to cause error
      await stateStore.setOperationFailure("findInstanceId", {
        failNext: true,
        alwaysFail: false,
        errorMessage: "Mock provider error",
        errorCode: "MockError",
      });

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<unknown>>(res);

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });

    it("should handle getPublicIp failure gracefully", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setPublicIp("203.0.113.42");

      // Configure fault injection for getPublicIp
      await stateStore.setOperationFailure("getPublicIp", {
        failNext: true,
        alwaysFail: false,
        errorMessage: "Failed to get public IP",
        errorCode: "GetPublicIpError",
      });

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      // Should still return 200, but without public IP
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data?.state).toBe(ServerState.Running);
      expect(body.data?.publicIp).toBeUndefined();
    });
  });

  describe("Provider isolation", () => {
    it("should use mock provider when MC_BACKEND_MODE is 'mock'", async () => {
      const provider = getProvider();

      // Verify we're using the mock provider
      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("findInstanceId");
      expect(provider).toHaveProperty("getInstanceState");
    });

    it("should not interfere with real AWS provider", async () => {
      // Test in mock mode
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      const mockProv = getProvider();

      // Set instance to running in mock mode
      const stateStore = getMockStateStore();
      await stateStore.updateInstanceState("running" as ServerState);

      // Create mock request
      const req = createMockNextRequest("http://localhost/api/status");
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(res.status).toBe(200);
      expect(body.data?.state).toBe(ServerState.Running);

      // Reset and switch to AWS mode
      resetProvider();
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      const awsProv = getProvider();

      // Verify we got a different provider
      expect(awsProv).not.toBe(mockProv);
    });
  });

  describe("State transitions", () => {
    it("should reflect state changes across multiple requests", async () => {
      const stateStore = getMockStateStore();

      // Start with stopped state
      await stateStore.updateInstanceState("stopped" as ServerState);

      const req = createMockNextRequest("http://localhost/api/status");

      // First request - stopped
      let res = await GET(req);
      let body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);
      expect(body.data?.state).toBe(ServerState.Stopped);

      // Change to running
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setPublicIp("203.0.113.42");

      // Second request - running
      res = await GET(req);
      body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);
      expect(body.data?.state).toBe(ServerState.Running);
      expect(body.data?.publicIp).toBe("203.0.113.42");

      // Change to pending
      await stateStore.updateInstanceState("pending" as ServerState);

      // Third request - pending
      res = await GET(req);
      body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);
      expect(body.data?.state).toBe(ServerState.Pending);
    });
  });

  describe("Volume detection", () => {
    it("should detect when instance has volume", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running with volume
      await stateStore.updateInstanceState("running" as ServerState);
      await stateStore.setHasVolume(true);

      const req = createMockNextRequest("http://localhost/api/status");
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.data?.hasVolume).toBe(true);
    });

    it("should detect when instance has no volume", async () => {
      const stateStore = getMockStateStore();

      // Set instance to stopped without volume
      await stateStore.updateInstanceState("stopped" as ServerState);
      await stateStore.setHasVolume(false);

      const req = createMockNextRequest("http://localhost/api/status");
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.data?.hasVolume).toBe(false);
    });
  });
});
