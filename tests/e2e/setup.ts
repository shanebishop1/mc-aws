/**
 * E2E Test Setup
 *
 * Shared setup and utilities for E2E tests using mock mode.
 * Provides mock control API helpers and authentication.
 */

import type { Page } from "@playwright/test";

// ============================================================================
// Mock Control API Helpers
// ============================================================================

/**
 * Set the mock scenario via control API
 */
export async function setScenario(page: Page, scenario: string): Promise<void> {
  const response = await page.request.post("/api/mock/scenario", {
    data: { scenario },
  });

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to set scenario "${scenario}": ${error}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Failed to set scenario "${scenario}": ${result.error}`);
  }

  console.log(`[MOCK] Set scenario to: ${scenario}`);
}

/**
 * Inject a fault via control API
 */
export async function injectFault(
  page: Page,
  config: {
    operation: string;
    failNext?: boolean;
    alwaysFail?: boolean;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<void> {
  const response = await page.request.post("/api/mock/fault", {
    data: config,
  });

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to inject fault: ${error}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Failed to inject fault: ${result.error}`);
  }

  console.log(`[MOCK] Injected fault for operation: ${config.operation}`);
}

/**
 * Reset mock state to defaults
 */
export async function resetMockState(page: Page): Promise<void> {
  const response = await page.request.post("/api/mock/reset");

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to reset mock state: ${error}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Failed to reset mock state: ${result.error}`);
  }

  console.log("[MOCK] Reset mock state to defaults");
}

/**
 * Authenticate as dev user (dev@localhost)
 * This uses the dev login feature when ENABLE_DEV_LOGIN=true
 */
export async function authenticateAsDev(page: Page): Promise<void> {
  // Check if already authenticated
  const meResponse = await page.request.get("/api/auth/me");
  const meData = await meResponse.json();

  if (meData.authenticated) {
    console.log("[AUTH] Already authenticated");
    return;
  }

  // Navigate to dev login endpoint (it will set the cookie and redirect)
  await page.goto("/api/auth/dev-login", { waitUntil: "domcontentloaded" });

  // Wait for redirect to home page
  await page.waitForURL("/", { timeout: 10000 });

  // Verify we're authenticated
  const authCheck = await page.request.get("/api/auth/me");
  const authData = await authCheck.json();
  if (!authData.authenticated) {
    throw new Error("Failed to authenticate as dev user");
  }

  console.log("[AUTH] Authenticated as dev@localhost");
}

/**
 * Setup test environment with authentication and mock state
 */
export async function setupTestEnvironment(page: Page, scenario?: string): Promise<void> {
  // Authenticate as dev user first (required for mock control endpoints)
  await authenticateAsDev(page);

  // Reset mock state before test
  await resetMockState(page);

  // Set scenario if provided
  if (scenario) {
    await setScenario(page, scenario);
  }
}

// ============================================================================
// Scenario Helpers
// ============================================================================

/**
 * Setup scenario for stopped server
 */
export async function setupStoppedScenario(page: Page): Promise<void> {
  await setupTestEnvironment(page, "default");
}

/**
 * Setup scenario for running server
 */
export async function setupRunningScenario(page: Page): Promise<void> {
  await setupTestEnvironment(page, "running");
}

/**
 * Setup scenario for hibernated server
 */
export async function setupHibernatedScenario(page: Page): Promise<void> {
  await setupTestEnvironment(page, "hibernated");
}

/**
 * Setup scenario for high costs
 */
export async function setupHighCostScenario(page: Page): Promise<void> {
  await setupTestEnvironment(page, "high-cost");
}

/**
 * Setup scenario for many players
 */
export async function setupManyPlayersScenario(page: Page): Promise<void> {
  await setupTestEnvironment(page, "many-players");
}

/**
 * Setup scenario for errors
 */
export async function setupErrorsScenario(page: Page): Promise<void> {
  await setupTestEnvironment(page, "errors");
}

/**
 * Set an SSM parameter via mock control API
 */
export async function setMockParameter(
  page: Page,
  name: string,
  value: string,
  type: "String" | "SecureString" = "String"
): Promise<void> {
  const response = await page.request.post("/api/mock/patch", {
    data: {
      ssm: {
        parameters: {
          [name]: {
            value,
            type,
            lastModified: new Date().toISOString(),
          },
        },
      },
    },
  });

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to set parameter "${name}": ${error}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Failed to set parameter "${name}": ${result.error}`);
  }

  console.log(`[MOCK] Set parameter ${name} = ${value}`);
}
