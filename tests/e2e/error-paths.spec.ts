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

    // Inject fault for startInstance operation
    await injectFault(page, {
      operation: "startInstance",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "You have reached the maximum number of running instances",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /start server/i }).click();

    // Should show error message (check for the actual error message)
    await expect(page.getByText(/You have reached the maximum number of running instances/i)).toBeVisible({
      timeout: 10000,
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

    // Should show error message (check for the actual error message)
    await expect(page.getByText(/Instance is in an incorrect state for this operation/i)).toBeVisible({
      timeout: 10000,
    });
  });

  test("shows error when backup fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for executeSSMCommand operation
    await injectFault(page, {
      operation: "executeSSMCommand",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /backup/i }).click();
    await confirmDialog(page);

    // Should show error message (check for the actual error message)
    await expect(page.getByText(/The specified instance ID is not valid/i)).toBeVisible({ timeout: 10000 });
  });

  test("shows error when restore fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for executeSSMCommand operation
    await injectFault(page, {
      operation: "executeSSMCommand",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /restore/i }).click();
    await confirmDialog(page);

    // Should show error message (check for the actual error message)
    await expect(page.getByText(/The specified instance ID is not valid/i)).toBeVisible({ timeout: 10000 });
  });

  test("shows error when hibernate fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for stopInstance operation
    await injectFault(page, {
      operation: "stopInstance",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Instance is in an incorrect state for this operation",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /hibernate/i }).click();
    await confirmDialog(page);

    // Should show error message (check for the actual error message)
    await expect(page.getByText(/Instance is in an incorrect state for this operation/i)).toBeVisible({
      timeout: 10000,
    });
  });

  test("shows error when resume fails", async ({ page }) => {
    await setupHibernatedScenario(page);

    // Inject fault for startInstance operation
    await injectFault(page, {
      operation: "startInstance",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "You have reached the maximum number of running instances",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    await page.getByRole("button", { name: /Start Fresh World/i }).click();

    // Should show error message (check for the actual error message)
    await expect(page.getByText(/You have reached the maximum number of running instances/i)).toBeVisible({
      timeout: 10000,
    });
  });
});
