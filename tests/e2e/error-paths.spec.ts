import { expect, test } from "@playwright/test";
import { confirmDialog } from "./helpers";
import { injectFault, setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

test.describe("Error Handling", () => {
  test.beforeEach(async ({ page }) => {
    // Reset and authenticate before each test
    await setupStoppedScenario(page);
  });

  test("shows error when AWS connection fails on load", async ({ page }) => {
    // Inject fault for getStackStatus operation
    await injectFault(page, {
      operation: "getStackStatus",
      alwaysFail: true,
      errorCode: "ValidationError",
      errorMessage: "Stack does not exist",
    });

    await page.goto("/");

    // Should show "Connection Error" message
    await expect(page.getByText(/Connection Error/i)).toBeVisible({ timeout: 10000 });
  });

  test("shows error when start fails", async ({ page }) => {
    await setupStoppedScenario(page);

    // Inject fault for start operation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "You have reached the maximum number of running instances",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /start server/i }).click();

    // API sanitizes provider errors to stable user-facing messages
    await expect(page.getByText(/Failed to start server/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows error when stop fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for stopInstance operation
    await injectFault(page, {
      operation: "stopInstance",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Instance is in an incorrect state for this operation",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /stop server/i }).click();

    // API sanitizes provider errors to stable user-facing messages
    await expect(page.getByText(/Failed to stop server/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows error when backup fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for backup Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /backup/i }).click();
    await confirmDialog(page);

    // API sanitizes provider errors to stable user-facing messages
    await expect(page.getByText(/Failed to create backup/i)).toBeVisible({ timeout: 5000 });
  });

  test("shows error when restore fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for restore Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    // Restore flow is modal-driven and timing-sensitive in UI, so validate endpoint contract directly.
    const response = await page.request.post("/api/restore", {
      data: { backupName: "minecraft-backup-2025-01-15" },
    });

    expect(response.status()).toBe(500);
    const data = (await response.json()) as { success?: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/Failed to restore backup/i);
  });

  test("shows error when hibernate fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for hibernate Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Instance is in an incorrect state for this operation",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /hibernate/i }).click();
    await confirmDialog(page);

    // API sanitizes provider errors to stable user-facing messages
    await expect(page.getByText(/Failed to hibernate server/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows error when resume fails", async ({ page }) => {
    await setupHibernatedScenario(page);

    // Inject fault for resume Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "You have reached the maximum number of running instances",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    await page.getByRole("button", { name: /Start Fresh World/i }).click();

    // API sanitizes provider errors to stable user-facing messages
    await expect(page.getByText(/Failed to resume server/i)).toBeVisible({
      timeout: 5000,
    });
  });
});
