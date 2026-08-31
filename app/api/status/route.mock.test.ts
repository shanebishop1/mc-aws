/**
 * Tests for GET /api/status route handler in mock mode
 * Tests that the status endpoint works correctly with the mock provider
 */

import { getMockStateStore, resetMockStateStore } from "@/lib/aws/mock-state-store";
import { resetProvider } from "@/lib/aws/provider-selector";
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
      expect(body.data?.domain).toBeUndefined();
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
    it("should ignore instanceId from query parameter and use server-side resolution", async () => {
      const stateStore = getMockStateStore();

      // Set instance to running
      await stateStore.updateInstanceState("running" as ServerState);

      // Create mock request with instanceId query parameter (should be ignored)
      const req = createMockNextRequest("http://localhost/api/status?instanceId=i-custom123");

      // Call the route handler
      const res = await GET(req);
      const body = await parseNextResponse<ApiResponse<ServerStatusResponse>>(res);

      expect(body.success).toBe(true);
      // Should use the server-side resolved ID, not the query parameter
      expect(body.data?.instanceId).toBeDefined();
      expect(body.data?.instanceId).toMatch(/^i-/);
      expect(body.data?.instanceId).not.toBe("i-custom123");
    });
  });
});
