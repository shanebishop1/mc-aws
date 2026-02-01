/**
 * E2E Test Setup
 *
 * Shared setup and utilities for E2E tests using mock mode.
 * Provides mock control API helpers and authentication.
 */

import type { Page } from "@playwright/test";
import { SignJWT } from "jose";

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
 * Create a JWT token for dev authentication
 */
async function createDevToken(): Promise<string> {
  const secret = new TextEncoder().encode("dev-secret-placeholder");
  const token = await new SignJWT({
    email: "dev@localhost",
    role: "admin",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
  return token;
}

/**
 * Authenticate as dev user (dev@localhost)
 * This creates and sets a JWT cookie directly
 */
export async function authenticateAsDev(page: Page): Promise<void> {
  // Check if already authenticated
  const meResponse = await page.request.get("/api/auth/me");
  const meData = await meResponse.json();

  if (meData.authenticated) {
    console.log("[AUTH] Already authenticated");
    return;
  }

  // Create JWT token and set as cookie
  const token = await createDevToken();
  await page.context().addCookies([
    {
      name: "mc_session",
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      expires: -1,
    },
  ]);

  console.log("[AUTH] Set dev session cookie");

  // Navigate to home page
  await page.goto("/", { waitUntil: "domcontentloaded" });

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
