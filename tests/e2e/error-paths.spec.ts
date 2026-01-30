import { expect, test } from "@playwright/test";
import { confirmDialog, waitForPageLoad } from "./helpers";
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

    // Should show error message
    await expect(page.getByText(/stack does not exist/i)).toBeVisible();
  });

  test("shows error when start fails", async ({ page }) => {
    await setupStoppedScenario(page);

    // Inject fault for startInstance operation
    await injectFault(page, {
      operation: "startInstance",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "Failed to start instance",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /start server/i }).click();

    // Should show error message
    await expect(page.getByText(/failed to start/i)).toBeVisible();
  });

  test("shows error when stop fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for stopInstance operation
    await injectFault(page, {
      operation: "stopInstance",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Failed to stop instance",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should show error message
    await expect(page.getByText(/failed to stop/i)).toBeVisible();
  });

  test("shows error when backup fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for executeSSMCommand operation
    await injectFault(page, {
      operation: "executeSSMCommand",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "Failed to create backup",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /backup/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/backup.*failed|failed.*backup/i)).toBeVisible();
  });

  test("shows error when restore fails", async ({ page }) => {
    await setupStoppedScenario(page);

    // Inject fault for executeSSMCommand operation
    await injectFault(page, {
      operation: "executeSSMCommand",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "Failed to restore from backup",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /restore/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/restore.*failed|failed.*restore/i)).toBeVisible();
  });

  test("shows error when hibernate fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for stopInstance operation
    await injectFault(page, {
      operation: "stopInstance",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Failed to hibernate server",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /hibernate/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/hibernate.*failed|failed.*hibernate/i)).toBeVisible();
  });

  test("shows error when resume fails", async ({ page }) => {
    await setupHibernatedScenario(page);

    // Inject fault for startInstance operation
    await injectFault(page, {
      operation: "startInstance",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "Failed to resume server",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    await page.getByRole("button", { name: /start fresh world/i }).click();

    // Should show error message
    await expect(page.getByText(/resume.*failed|failed.*resume/i)).toBeVisible();
  });
});
