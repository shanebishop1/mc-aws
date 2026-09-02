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
    it("should return mock provider when MC_BACKEND_MODE is 'mock'", async () => {
      // Mock environment variable
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      const provider = await getProvider();

      expect(provider).toBe(mockProvider);
      expect(provider).not.toBe(awsProvider);
    });

    it("should return AWS provider when MC_BACKEND_MODE is 'aws'", async () => {
      // Mock environment variable
      vi.stubEnv("MC_BACKEND_MODE", "aws");

      const provider = await getProvider();

      expect(provider).toBe(awsProvider);
      expect(provider).not.toBe(mockProvider);
    });

    it("should return AWS provider when MC_BACKEND_MODE is not set (default)", async () => {
      // Mock environment variable as undefined
      vi.stubEnv("MC_BACKEND_MODE", undefined);

      const provider = await getProvider();

      expect(provider).toBe(awsProvider);
      expect(provider).not.toBe(mockProvider);
    });

    it("should return cached provider on subsequent calls", async () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      const firstCall = getProvider();
      const secondCall = getProvider();

      expect(firstCall).toBe(secondCall);
      await expect(firstCall).resolves.toBe(mockProvider);
    });

    it("should handle case-insensitive mode values", async () => {
      // Test uppercase
      vi.stubEnv("MC_BACKEND_MODE", "MOCK");
      await expect(getProvider()).resolves.toBe(mockProvider);

      resetProvider();

      // Test mixed case
      vi.stubEnv("MC_BACKEND_MODE", "Aws");
      await expect(getProvider()).resolves.toBe(awsProvider);
    });
  });

  describe("resetProvider()", () => {
    it("should clear the cached provider", async () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");

      // Get provider and cache it
      const firstProvider = await getProvider();
      expect(firstProvider).toBe(mockProvider);

      // Reset the cache
      resetProvider();

      // Change mode and get provider again
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      const secondProvider = await getProvider();

      // Should get the new provider, not the cached one
      expect(secondProvider).toBe(awsProvider);
      expect(secondProvider).not.toBe(firstProvider);
    });

    it("should be idempotent (safe to call multiple times)", async () => {
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
      const provider = await getProvider();
      expect(provider).toBe(awsProvider);
    });
  });
});
