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
import { authenticateAsDev } from "./e2e/setup";

// ============================================================================
// Mock Control API Helpers
// ============================================================================

import type { Page } from "@playwright/test";

/**
 * Set the mock scenario via control API
 */
async function setScenario(page: Page, scenario: string): Promise<void> {
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
  expect(result.success).toBe(true);
  console.log(`[MOCK] Injected fault for operation: ${config.operation}`);
}

/**
 * Reset mock state to defaults
 */
async function resetMockState(page: Page): Promise<void> {
  const response = await page.request.post("/api/mock/reset");

  if (!response.ok()) {
    const error = await response.text();
    throw new Error(`Failed to reset mock state: ${error}`);
  }

  const result = await response.json();
  expect(result.success).toBe(true);
  console.log("[MOCK] Reset mock state to defaults");
}

// ============================================================================
// Test Setup
// ============================================================================

test.beforeEach(async ({ page }) => {
  // Authenticate as dev user FIRST (before any API calls that require auth)
  await authenticateAsDev(page);

  // Reset mock state after authentication
  await resetMockState(page);
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

    // Wait a moment for the scenario to be applied
    await page.waitForTimeout(500);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Reload to ensure scenario state is reflected on the page
    await page.reload();
    await waitForPageLoad(page);

    // Verify server shows as running (Online)
    await expect(page.getByText("Online", { exact: true })).toBeVisible();

    // Verify public IP is displayed (check for the specific IP)
    await expect(page.getByText(/203\.0\.113\.42/i)).toBeVisible();

    // Verify player count is shown
    await expect(page.getByText(/5 players online/i)).toBeVisible();

    // Verify costs are displayed (should be visible in cost dashboard)
    // Click cost button to open dashboard
    await page.getByRole("button", { name: /costs/i }).click();
    await expect(page.getByTestId("cost-dashboard")).toBeVisible();

    // Click "Generate Report" button to fetch cost data
    await page.getByRole("button", { name: /generate report/i }).click();

    // Wait for cost data to load
    await page.waitForTimeout(1000);

    // Verify cost data is displayed
    await expect(page.getByText(/amazon ec2/i)).toBeVisible();
    await expect(page.getByText(/\$15\.50/i)).toBeVisible();

    // Close cost dashboard by clicking the Close button
    await page.getByRole("button", { name: /close/i }).click();
  });

  test("Start Flow - transitions from stopped to running", async ({ page }) => {
    // Set scenario to default (stopped)
    await setScenario(page, "default");

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Verify server is stopped initially
    await expect(page.getByText(/stopped/i)).toBeVisible();

    // Click start button and wait for the start API to complete
    const startResponse = page.waitForResponse(
      (response) => response.url().includes("/api/start") && response.status() === 200
    );
    await page.getByRole("button", { name: /start server/i }).click();

    // Verify UI shows "starting" state (Starting...)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();

    // Ensure the start operation finished before asserting final state
    await startResponse;

    // Verify server is now running (Online)
    await expect(page.locator("h2").getByText("Online", { exact: true })).toBeVisible({ timeout: 20000 });

    // Verify public IP is now displayed
    await expect(page.getByTestId("server-status").getByText(/\d+\.\d+\.\d+\.\d+/i)).toBeVisible({
      timeout: 20000,
    });
  });

  test("Stop Flow - transitions from running to stopped", async ({ page }) => {
    // Set scenario to running BEFORE navigating to ensure state is ready
    await setScenario(page, "running");
    await page.waitForTimeout(500); // Give scenario time to apply

    // Navigate to status page - fresh load with running scenario already set
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Wait for all critical API responses to complete
    await page.waitForResponse((response) => response.url().includes("/api/auth/me") && response.status() === 200);
    await page.waitForResponse((response) => response.url().includes("/api/status") && response.status() === 200);
    await page.waitForTimeout(1000); // Give React time to render with updated state

    // Verify server is running initially (Online status text in the main heading) before attempting to stop
    await expect(page.locator("h2").getByText("Online", { exact: true })).toBeVisible({ timeout: 5000 });

    // Wait for the stop button to be visible (admin-only button, only shows when running)
    const stopButton = page.getByRole("button", { name: /stop server/i });
    await expect(stopButton).toBeVisible({ timeout: 5000 });

    // Click stop button
    await stopButton.click();

    // Verify UI shows "stopping" state (Stopping...)
    await expect(page.getByText(/stopping\.\.\./i)).toBeVisible();

    // Wait for transition to stopped (STOPPING_DELAY_MS is 2500ms + buffer)
    await page.waitForTimeout(3500);

    // Refresh to get updated status
    await page.reload();
    await waitForPageLoad(page);

    // Wait for status API to return stopped state
    await page.waitForResponse((response) => response.url().includes("/api/status") && response.status() === 200);
    await page.waitForTimeout(500); // Give React time to render

    // Verify server is now stopped (check the h2 heading for status)
    await expect(page.locator("h2").getByText(/stopped/i)).toBeVisible({ timeout: 5000 });

    // Verify public IP is no longer displayed (when stopped, IP shows as transparent/placeholder)
    // The IP element exists but has transparent text class when not available
    const ipElement = page.locator("span.font-sans.text-xs.text-transparent").filter({ hasText: /\d+\.\d+\.\d+\.\d+/ });
    await expect(ipElement).toBeVisible();
  });

  test("Backup Flow - displays error when backup operation fails", async ({ page }) => {
    // Set scenario to running
    await setScenario(page, "running");
    await page.waitForTimeout(500); // Give scenario time to apply

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

    // Reload to ensure scenario state is reflected on the page
    await page.reload();
    await waitForPageLoad(page);

    // Click backup button
    await page.getByRole("button", { name: /backup/i }).click();

    // Verify backup dialog opens
    await expect(page.getByTestId("backup-dialog")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/backup server/i)).toBeVisible();

    // Click backup button in dialog (the confirm button)
    const backupButtons = page.getByRole("button", { name: /backup/i });
    await backupButtons.nth(1).click();

    // Wait for error to appear
    await expect(page.getByText(/failed to execute backup command/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/instance not found/i)).toBeVisible();

    // Verify backup dialog is closed after error
    await expect(page.getByTestId("backup-dialog")).not.toBeVisible();
  });

  test("Backup Flow - succeeds when no fault is injected", async ({ page }) => {
    // Set scenario to running
    await setScenario(page, "running");
    await page.waitForTimeout(500); // Give scenario time to apply

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Reload to ensure scenario state is reflected on the page
    await page.reload();
    await waitForPageLoad(page);

    // Click backup button in the main UI
    const mainBackupButton = page.locator("section").getByRole("button", { name: /backup/i });
    await mainBackupButton.click();

    // Verify backup dialog opens
    await expect(page.getByTestId("backup-dialog")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/backup server/i)).toBeVisible();

    // Click backup button in the dialog (confirm button)
    const dialogBackupButton = page.getByTestId("backup-dialog").getByRole("button", { name: /backup/i });
    await dialogBackupButton.click();

    // Wait for success message to appear
    await expect(page.getByText(/backup completed successfully/i)).toBeVisible({ timeout: 5000 });

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
    await expect(page.getByText("Online", { exact: true })).toBeVisible();

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
    await page.reload();
    await waitForPageLoad(page);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Open cost dashboard
    await page.getByRole("button", { name: /costs/i }).click();

    // Click "Generate Report" button to fetch cost data
    await page.getByRole("button", { name: /generate report/i }).click();

    // Wait for cost data to load
    await page.waitForTimeout(1000);

    // Verify high costs are displayed (format: "$ 125.50" with space)
    await expect(page.getByText(/\$\s*125\.50/i)).toBeVisible();
    await expect(page.getByText(/amazon ec2/i)).toBeVisible();
    await expect(page.getByText(/\$\s*110\.00/i)).toBeVisible();

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
