import { expect, test } from "@playwright/test";
import { setupMocks } from "../mocks/handlers";
import { confirmDialog, waitForLoading, waitForPageLoad } from "./helpers";

test.describe("Server Operations", () => {
  test("starts server without confirmation", async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click start button
    await page.getByRole("button", { name: /start server/i }).click();

    // Should NOT show confirmation dialog
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Should show starting state
    await expect(page.getByText(/starting/i)).toBeVisible();
  });

  test("stops server without confirmation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click stop button
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should NOT show confirmation dialog
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Should show stopping state
    await expect(page.getByText(/stopping/i)).toBeVisible();
  });

  test("hibernate requires confirmation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/hibernate server/i)).toBeVisible();
    await expect(page.getByText(/backup your server, stop the instance/i)).toBeVisible();

    // Confirm hibernate
    await confirmDialog(page);

    // Verify action started
    await expect(page.getByText(/hibernating/i)).toBeVisible();
  });

  test("can cancel hibernate confirmation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/hibernate server/i)).toBeVisible();

    // Cancel hibernate
    await page.getByRole("button", { name: /cancel/i }).click();

    // Dialog should close
    await expect(page.getByText(/hibernate server/i)).not.toBeVisible();

    // Should not show hibernating state
    await expect(page.getByText(/hibernating/i)).not.toBeVisible();
  });

  test("resume with start fresh option", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByText(/resume world/i)).toBeVisible();

    // Should show two options
    await expect(page.getByRole("button", { name: /start fresh world/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /restore from backup/i })).toBeVisible();

    // Click start fresh
    await page.getByRole("button", { name: /start fresh world/i }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();

    // Should show resuming state
    await expect(page.getByText(/resuming/i)).toBeVisible();
  });

  test("resume with restore from backup option", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click restore from backup
    await page.getByRole("button", { name: /restore from backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/select backup/i)).toBeVisible();

    // Wait for backups to load
    await expect(page.getByText(/backup-2025-01-09\.tar\.gz/i)).toBeVisible();

    // Select a backup
    await page.getByRole("button", { name: /backup-2025-01-09\.tar\.gz/i }).click();

    // Confirm restore
    await page.getByRole("button", { name: /confirm restore/i }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();

    // Should show resuming state
    await expect(page.getByText(/resuming/i)).toBeVisible();
  });

  test("can cancel resume modal", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click close button
    await modal.getByRole("button", { name: "" }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();
  });

  test("can go back from backup selection to choice view", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click restore from backup
    await page.getByRole("button", { name: /restore from backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/select backup/i)).toBeVisible();

    // Click back button
    await page.getByRole("button", { name: /back/i }).click();

    // Should return to choice view
    await expect(page.getByText(/resume world/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /start fresh world/i })).toBeVisible();
  });

  test("shows loading state during start operation", async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click start button
    await page.getByRole("button", { name: /start server/i }).click();

    // Should show loading state
    await waitForLoading(page);

    // Verify action message is shown
    await expect(page.getByText(/starting minecraft server/i)).toBeVisible();
  });

  test("shows loading state during stop operation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click stop button
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should show loading state
    await waitForLoading(page);

    // Verify action message is shown
    await expect(page.getByText(/stopping minecraft server/i)).toBeVisible();
  });

  test("shows loading state during hibernate operation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Confirm hibernate
    await confirmDialog(page);

    // Should show loading state
    await waitForLoading(page);

    // Verify action message is shown
    await expect(page.getByText(/hibernating/i)).toBeVisible();
  });

  test("shows loading state during resume operation", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    await page.getByRole("button", { name: /start fresh world/i }).click();

    // Should show loading state
    await waitForLoading(page);

    // Verify action message is shown
    await expect(page.getByText(/resuming/i)).toBeVisible();
  });

  test("resume confirm restore is disabled until backup is selected", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Click restore from backup
    await page.getByRole("button", { name: /restore from backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/select backup/i)).toBeVisible();

    // Confirm restore button should be disabled initially
    const confirmButton = page.getByRole("button", { name: /confirm restore/i });
    await expect(confirmButton).toBeDisabled();

    // Select a backup
    await page.getByRole("button", { name: /backup-2025-01-09\.tar\.gz/i }).click();

    // Confirm restore button should now be enabled
    await expect(confirmButton).toBeEnabled();
  });
});
