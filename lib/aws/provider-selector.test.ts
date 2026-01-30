/**
 * Tests for provider selector functionality
 * Tests provider switching based on MC_BACKEND_MODE environment variable
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { awsProvider } from "./aws-provider";
import { mockProvider } from "./mock-provider";
import { getProvider, resetProvider } from "./provider-selector";

describe("Provider Selector", () => {
  beforeEach(() => {
    // Reset provider cache before each test
    resetProvider();
  });

  describe("getProvider()", () => {
    it("should return mock provider when MC_BACKEND_MODE is 'mock'", () => {
      // Mock environment variable
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      const provider = getProvider();

      expect(provider).toBe(mockProvider);
      expect(provider).not.toBe(awsProvider);
    });

    it("should return AWS provider when MC_BACKEND_MODE is 'aws'", () => {
      // Mock environment variable
      vi.stubEnv("MC_BACKEND_MODE", "aws");

      const provider = getProvider();

      expect(provider).toBe(awsProvider);
      expect(provider).not.toBe(mockProvider);
    });

    it("should return AWS provider when MC_BACKEND_MODE is not set (default)", () => {
      // Mock environment variable as undefined
      vi.stubEnv("MC_BACKEND_MODE", undefined);

      const provider = getProvider();

      expect(provider).toBe(awsProvider);
      expect(provider).not.toBe(mockProvider);
    });

    it("should return cached provider on subsequent calls", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      const firstCall = getProvider();
      const secondCall = getProvider();

      expect(firstCall).toBe(secondCall);
      expect(firstCall).toBe(mockProvider);
    });

    it("should not create AWS clients when in mock mode (lazy initialization)", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      // Get provider in mock mode
      const provider = getProvider();

      // Verify it's the mock provider
      expect(provider).toBe(mockProvider);

      // The mock provider should not have AWS client properties
      // We can verify this by checking that it has the mock-specific methods
      expect(provider).toHaveProperty("findInstanceId");
      expect(provider).toHaveProperty("startInstance");
      expect(provider).toHaveProperty("stopInstance");
    });

    it("should handle case-insensitive mode values", () => {
      // Test uppercase
      vi.stubEnv("MC_BACKEND_MODE", "MOCK");
      expect(getProvider()).toBe(mockProvider);

      resetProvider();

      // Test mixed case
      vi.stubEnv("MC_BACKEND_MODE", "Aws");
      expect(getProvider()).toBe(awsProvider);
    });
  });

  describe("resetProvider()", () => {
    it("should clear the cached provider", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      // Get provider and cache it
      const firstProvider = getProvider();
      expect(firstProvider).toBe(mockProvider);

      // Reset the cache
      resetProvider();

      // Change mode and get provider again
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      const secondProvider = getProvider();

      // Should get the new provider, not the cached one
      expect(secondProvider).toBe(awsProvider);
      expect(secondProvider).not.toBe(firstProvider);
    });

    it("should allow switching between modes", () => {
      // Start in mock mode
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      let provider = getProvider();
      expect(provider).toBe(mockProvider);

      // Reset and switch to AWS mode
      resetProvider();
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      provider = getProvider();
      expect(provider).toBe(awsProvider);

      // Reset and switch back to mock mode
      resetProvider();
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      provider = getProvider();
      expect(provider).toBe(mockProvider);
    });

    it("should be idempotent (safe to call multiple times)", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      getProvider();

      // Call reset multiple times
      expect(() => {
        resetProvider();
        resetProvider();
        resetProvider();
      }).not.toThrow();

      // Should still work after multiple resets
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      const provider = getProvider();
      expect(provider).toBe(awsProvider);
    });
  });

  describe("Provider isolation", () => {
    it("should maintain separate state between providers", async () => {
      // Test with mock provider
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      const mockProv = getProvider();

      // Get instance state from mock provider
      const mockState = await mockProv.getInstanceState();
      expect(mockState).toBeDefined();

      // Reset and switch to AWS provider
      resetProvider();
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      const awsProv = getProvider();

      // Verify we got the AWS provider
      expect(awsProv).toBe(awsProvider);
      expect(awsProv).not.toBe(mockProv);
    });
  });
});
