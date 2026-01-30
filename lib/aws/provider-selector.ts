/**
 * Provider selector
 * Returns the appropriate AWS provider based on MC_BACKEND_MODE environment variable
 * Uses lazy initialization - AWS clients are only created when in AWS mode
 */

import { getBackendMode } from "../env";
import { awsProvider } from "./aws-provider";
import { mockProvider } from "./mock-provider";
import type { AwsProvider } from "./types";

/**
 * Cached provider instance
 * Initialized lazily on first call
 */
let cachedProvider: AwsProvider | null = null;

/**
 * Get the AWS provider based on the current backend mode
 * Uses lazy initialization to avoid creating AWS clients in mock mode
 *
 * @returns The appropriate provider (aws or mock)
 */
export function getProvider(): AwsProvider {
  // Return cached provider if already initialized
  if (cachedProvider) {
    return cachedProvider;
  }

  // Select provider based on backend mode - read dynamically from env
  const backendMode = getBackendMode();

  if (backendMode === "mock") {
    console.log("[Provider] Using mock provider (MC_BACKEND_MODE=mock)");
    cachedProvider = mockProvider;
  } else {
    console.log("[Provider] Using AWS provider (MC_BACKEND_MODE=aws)");
    cachedProvider = awsProvider;
  }

  return cachedProvider;
}

/**
 * Reset the cached provider
 * Useful for testing or when the backend mode changes
 */
export function resetProvider(): void {
  cachedProvider = null;
}
