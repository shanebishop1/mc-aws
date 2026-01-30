/**
 * Mock Mode E2E Tests
 *
 * These tests validate the full UI workflow in mock mode using the mock control API.
 * Tests are deterministic and isolated, using scenarios and fault injection.
 *
 * Prerequisites:
 * - MC_BACKEND_MODE=mock environment variable set
 * - ENABLE_DEV_LOGIN=true for dev authentication
 * - Local dev server running (pnpm dev)
 *
 * Run with: MC_BACKEND_MODE=mock pnpm test:e2e tests/mock-mode-e2e.spec.ts
 */

import { expect, test } from "@playwright/test";
import { navigateTo, waitForPageLoad } from "./e2e/helpers";

// ============================================================================
// Mock Control API Helpers
// ============================================================================

/**
 * Set the mock scenario via control API
 */
async function setScenario(page: any, scenario: string): Promise<void> {
  const response = await page.request.post("/api/mock/scenario", {
    data: { scenario },
  });

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to set scenario "${scenario}": ${error}`);
  }

  const result = await response.json();
  expect(result.success).toBe(true);
  console.log(`[MOCK] Set scenario to: ${scenario}`);
}

/**
 * Inject a fault via control API
 */
async function injectFault(
  page: any,
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
  expect(result.success).toBe(true);
  console.log(`[MOCK] Injected fault for operation: ${config.operation}`);
}

/**
 * Reset mock state to defaults
 */
async function resetMockState(page: any): Promise<void> {
  const response = await page.request.post("/api/mock/reset");

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to reset mock state: ${error}`);
  }

  const result = await response.json();
  expect(result.success).toBe(true);
  console.log("[MOCK] Reset mock state to defaults");
}

/**
 * Authenticate as dev user (dev@localhost)
 * This uses the dev login feature when ENABLE_DEV_LOGIN=true
 */
async function authenticateAsDev(page: any): Promise<void> {
  // Check if already authenticated
  const meResponse = await page.request.get("/api/auth/me");
  const meData = await meResponse.json();

  if (meData.authenticated) {
    console.log("[AUTH] Already authenticated");
    return;
  }

  // Navigate to dev login endpoint (it will set the cookie and redirect)
  await page.goto("/api/auth/dev-login");

  // Wait for redirect to home page
  await page.waitForURL("/");

  // Verify we're authenticated
  const authCheck = await page.request.get("/api/auth/me");
  const authData = await authCheck.json();
  expect(authData.authenticated).toBe(true);

  console.log("[AUTH] Authenticated as dev@localhost");
}

// ============================================================================
// Test Setup
// ============================================================================

test.beforeEach(async ({ page }) => {
  // Reset mock state before each test
  await resetMockState(page);

  // Authenticate as dev user
  await authenticateAsDev(page);
});

test.afterEach(async ({ page }) => {
  // Clean up mock state after each test
  await resetMockState(page);
});

// ============================================================================
// Test Scenarios
// ============================================================================

test.describe("Mock Mode E2E Tests", () => {
  test("Status Page - displays running server with IP, costs, and player count", async ({ page }) => {
    // Set scenario to running
    await setScenario(page, "running");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Verify server shows as running (Online)
    await expect(page.getByText(/online/i)).toBeVisible();

    // Verify public IP is displayed
    await expect(page.getByText(/203\.0\.113\.42/i)).toBeVisible();

    // Verify costs are displayed (should be visible in cost dashboard)
    // Click cost button to open dashboard
    await page.getByRole("button", { name: /costs/i }).click();
    await expect(page.getByTestId("cost-dashboard")).toBeVisible();
    await expect(page.getByText(/amazon ec2/i)).toBeVisible();
    await expect(page.getByText(/\$12\.50/i)).toBeVisible();

    // Close cost dashboard
    await page.getByRole("button", { name: "" }).nth(0).click();

    // Verify player count is shown
    await expect(page.getByText(/5 players online/i)).toBeVisible();
  });

  test("Start Flow - transitions from stopped to running", async ({ page }) => {
    // Set scenario to default (stopped)
    await setScenario(page, "default");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Verify server is stopped initially
    await expect(page.getByText(/stopped/i)).toBeVisible();

    // Click start button
    await page.getByRole("button", { name: /start server/i }).click();

    // Verify UI shows "starting" state (Starting...)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();

    // Wait for transition to running (mock should transition quickly)
    await page.waitForTimeout(2000);

    // Refresh to get updated status
    await page.reload();
    await waitForPageLoad(page);

    // Verify server is now running (Online)
    await expect(page.getByText(/online/i)).toBeVisible();

    // Verify public IP is now displayed
    await expect(page.getByText(/\d+\.\d+\.\d+\.\d+/i)).toBeVisible();
  });

  test("Stop Flow - transitions from running to stopped", async ({ page }) => {
    // Set scenario to running
    await setScenario(page, "running");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Verify server is running initially (Online)
    await expect(page.getByText(/online/i)).toBeVisible();

    // Click stop button
    await page.getByRole("button", { name: /stop server/i }).click();

    // Verify UI shows "stopping" state (Stopping...)
    await expect(page.getByText(/stopping\.\.\./i)).toBeVisible();

    // Wait for transition to stopped
    await page.waitForTimeout(2000);

    // Refresh to get updated status
    await page.reload();
    await waitForPageLoad(page);

    // Verify server is now stopped
    await expect(page.getByText(/stopped/i)).toBeVisible();

    // Verify public IP is no longer displayed
    await expect(page.getByText(/\d+\.\d+\.\d+\.\d+/i)).not.toBeVisible();
  });

  test("Backup Flow - displays error when backup operation fails", async ({ page }) => {
    // Set scenario to running
    await setScenario(page, "running");

    // Inject fault for backup operation
    await injectFault(page, {
      operation: "executeSSMCommand",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "Failed to execute backup command: Instance not found",
    });

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Click backup button
    await page.getByRole("button", { name: /backup/i }).click();

    // Verify backup dialog opens
    await expect(page.getByTestId("backup-dialog")).toBeVisible();
    await expect(page.getByText(/backup server/i)).toBeVisible();

    // Click backup button in dialog
    await page.getByRole("button", { name: /backup/i }).click();

    // Wait for error to appear
    await page.waitForTimeout(1000);

    // Verify error is displayed
    await expect(page.getByText(/failed to execute backup command/i)).toBeVisible();
    await expect(page.getByText(/instance not found/i)).toBeVisible();

    // Verify backup dialog is closed after error
    await expect(page.getByTestId("backup-dialog")).not.toBeVisible();
  });

  test("Backup Flow - succeeds when no fault is injected", async ({ page }) => {
    // Set scenario to running
    await setScenario(page, "running");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Click backup button
    await page.getByRole("button", { name: /backup/i }).click();

    // Verify backup dialog opens
    await expect(page.getByTestId("backup-dialog")).toBeVisible();
    await expect(page.getByText(/backup server/i)).toBeVisible();

    // Click backup button in dialog
    await page.getByRole("button", { name: /backup/i }).click();

    // Wait for backup to complete
    await page.waitForTimeout(1000);

    // Verify success message is displayed
    await expect(page.getByText(/backup completed successfully/i)).toBeVisible();

    // Verify backup dialog is closed after success
    await expect(page.getByTestId("backup-dialog")).not.toBeVisible();
  });

  test("Scenario switching - correctly transitions between states", async ({ page }) => {
    // Start with default (stopped)
    await setScenario(page, "default");
    await navigateTo(page, "/");
    await waitForPageLoad(page);
    await expect(page.getByText(/stopped/i)).toBeVisible();

    // Switch to running scenario
    await setScenario(page, "running");
    await page.reload();
    await waitForPageLoad(page);
    await expect(page.getByText(/online/i)).toBeVisible();

    // Switch to starting scenario
    await setScenario(page, "starting");
    await page.reload();
    await waitForPageLoad(page);
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();

    // Switch to stopping scenario
    await setScenario(page, "stopping");
    await page.reload();
    await waitForPageLoad(page);
    await expect(page.getByText(/stopping\.\.\./i)).toBeVisible();

    // Switch back to default
    await setScenario(page, "default");
    await page.reload();
    await waitForPageLoad(page);
    await expect(page.getByText(/stopped/i)).toBeVisible();
  });

  test("High cost scenario - displays elevated costs", async ({ page }) => {
    // Set scenario to high-cost
    await setScenario(page, "high-cost");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Open cost dashboard
    await page.getByRole("button", { name: /costs/i }).click();

    // Verify high costs are displayed
    await expect(page.getByText(/\$125\.50/i)).toBeVisible();
    await expect(page.getByText(/amazon ec2/i)).toBeVisible();
    await expect(page.getByText(/\$110\.00/i)).toBeVisible();

    // Close cost dashboard
    await page.getByRole("button", { name: /close/i }).click();
  });

  test("Many players scenario - displays high player count", async ({ page }) => {
    // Set scenario to many-players
    await setScenario(page, "many-players");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Verify high player count is displayed
    await expect(page.getByText(/18 players/i)).toBeVisible();
  });
});
