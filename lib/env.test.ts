/**
 * Tests for environment variable validation and retrieval
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the actual module without mocking
import { env, getBackendMode, getEnv, getNodeEnv, validateAwsCredentials, validateRuntimeEnvironment } from "./env";

describe("Environment Variables", () => {
  beforeEach(() => {
    // Reset environment variables before each test
    vi.unstubAllEnvs();
  });

  describe("getEnv()", () => {
    it("should return environment variable value when set", () => {
      vi.stubEnv("TEST_VAR", "test-value");
      expect(getEnv("TEST_VAR")).toBe("test-value");
    });

    it("should return empty string for missing required variable", () => {
      expect(getEnv("MISSING_VAR")).toBe("");
    });
  });

  describe("getBackendMode()", () => {
    it("should default to 'aws' when MC_BACKEND_MODE is not set", () => {
      vi.stubEnv("MC_BACKEND_MODE", undefined);
      expect(getBackendMode()).toBe("aws");
    });

    it("should return 'mock' when MC_BACKEND_MODE is 'mock' in non-production", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      vi.stubEnv("NODE_ENV", "development");
      expect(getBackendMode()).toBe("mock");
    });

    it.each([
      ["explicit", "aws"],
      ["default", undefined],
    ])("accepts %s AWS mode in production", (_variant, mode) => {
      vi.stubEnv("MC_BACKEND_MODE", mode);
      vi.stubEnv("NODE_ENV", "production");

      expect(getBackendMode()).toBe("aws");
    });

    it("should throw error when MC_BACKEND_MODE is 'mock' in production", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      vi.stubEnv("NODE_ENV", "production");

      expect(() => getBackendMode()).toThrow(
        'MC_BACKEND_MODE="mock" is not allowed in production. Set MC_BACKEND_MODE="aws" or unset NODE_ENV.'
      );
    });

    it("should handle case-insensitive mode values", () => {
      vi.stubEnv("MC_BACKEND_MODE", "MOCK");
      vi.stubEnv("NODE_ENV", "development");
      expect(getBackendMode()).toBe("mock");

      vi.stubEnv("MC_BACKEND_MODE", "AWS");
      expect(getBackendMode()).toBe("aws");
    });

    it("should throw error for invalid mode value", () => {
      vi.stubEnv("MC_BACKEND_MODE", "invalid");
      expect(() => getBackendMode()).toThrow('Invalid MC_BACKEND_MODE value: "invalid". Must be "aws" or "mock".');
    });
  });

  describe("validateAwsCredentials()", () => {
    it("should skip validation in mock mode", () => {
      vi.stubEnv("MC_BACKEND_MODE", "mock");
      vi.stubEnv("NODE_ENV", "development");

      // Should not throw even with missing credentials
      expect(() => validateAwsCredentials()).not.toThrow();
    });

    it("should throw error when required AWS credentials are missing in AWS mode", () => {
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      vi.stubEnv("AWS_REGION", "");
      vi.stubEnv("AWS_ACCOUNT_ID", "");

      expect(() => validateAwsCredentials()).toThrow("Missing required AWS credentials in AWS mode");
    });

    it("should not throw when all required AWS credentials are present in AWS mode", () => {
      vi.stubEnv("MC_BACKEND_MODE", "aws");
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_ACCOUNT_ID", "123456789012");
      // INSTANCE_ID is required - must be set in .env file

      expect(() => validateAwsCredentials()).not.toThrow();
    });
  });

  describe("validateRuntimeEnvironment()", () => {
    it("should throw in production when worker-required config is missing", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("AUTH_SECRET", undefined);

      expect(() => validateRuntimeEnvironment()).toThrow("Strict production runtime validation failed");
    });

    it("should not throw outside production when worker-required config is missing", () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("AUTH_SECRET", undefined);

      expect(() => validateRuntimeEnvironment()).not.toThrow();
    });
  });
});
