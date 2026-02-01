import { expect, test } from "@playwright/test";
import { confirmDialog, waitForLoading, waitForPageLoad } from "./helpers";
import { setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

test.describe("Server Operations", () => {
  test.beforeEach(async ({ page }) => {
    // Reset and authenticate before each test
    await setupStoppedScenario(page);
  });

  test("starts server without confirmation", async ({ page }) => {
    await setupStoppedScenario(page);
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
    await setupRunningScenario(page);
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
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Hibernate Server/i)).toBeVisible();
    await expect(
      page.getByText(/This will backup your server, stop the instance, and delete the volume to save costs/i)
    ).toBeVisible();

    // Confirm hibernate
    await confirmDialog(page);

    // Verify action started
    await expect(page.getByText(/hibernating/i)).toBeVisible();
  });

  test("can cancel hibernate confirmation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Hibernate Server/i)).toBeVisible();

    // Cancel hibernate
    await page.getByRole("button", { name: /cancel/i }).click();

    // Dialog should close
    await expect(page.getByText(/Hibernate Server/i)).not.toBeVisible();

    // Should not show hibernating state
    await expect(page.getByText(/hibernating/i)).not.toBeVisible();
  });

  test("resume with start fresh option", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByText(/Resume World/i)).toBeVisible();

    // Should show two options
    await expect(page.getByRole("button", { name: /Start Fresh World/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Restore from Backup/i })).toBeVisible();

    // Click start fresh
    await page.getByRole("button", { name: /Start Fresh World/i }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();

    // Should show resuming state (starting...)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
  });

  test("resume with restore from backup option", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click restore from backup
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/Select Backup/i)).toBeVisible();

    // Wait for backups to load
    await expect(page.getByRole("button", { name: /minecraft-backup-/i }).first()).toBeVisible({ timeout: 5000 });

    // Select a backup (first one)
    await page
      .getByRole("button", { name: /minecraft-backup-/i })
      .first()
      .click();

    // Confirm restore
    await page.getByRole("button", { name: /Confirm Restore/i }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();

    // Should show resuming state (starting...)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
  });

  test("can cancel resume modal", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click close button (SVG icon with no accessible name)
    await modal.locator("button.absolute.top-6.right-6").click();

    // Modal should close
    await expect(modal).not.toBeVisible();
  });

  test("can go back from backup selection to choice view", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click restore from backup
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/Select Backup/i)).toBeVisible();

    // Click back button
    await page.getByRole("button", { name: /Back/i }).click();

    // Should return to choice view
    await expect(page.getByText(/Resume World/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Start Fresh World/i })).toBeVisible();
  });

  test("shows loading state during start operation", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click start button
    await page.getByRole("button", { name: /start server/i }).click();

    // Should show starting state (wait for it to appear)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible({ timeout: 5000 });
  });

  test("shows loading state during stop operation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click stop button
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should show stopping state (wait for it to appear)
    await expect(page.getByText(/stopping\.\.\./i)).toBeVisible({ timeout: 5000 });
  });

  test("shows loading state during hibernate operation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Confirm hibernate
    await confirmDialog(page);

    // Should indicate progress (can briefly be Stopping... or quickly transition to Hibernating)
    await expect(page.getByTestId("server-status")).toContainText(/stopping\.\.\.|hibernating/i, { timeout: 5000 });
  });

  test("shows loading state during resume operation", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    await page.getByRole("button", { name: /Start Fresh World/i }).click();

    // Should show starting state (resume uses start operation)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible({ timeout: 5000 });
  });

  test("resume confirm restore is disabled until backup is selected", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Click restore from backup
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/Select Backup/i)).toBeVisible();

    // Confirm restore button should be disabled initially
    const confirmButton = page.getByRole("button", { name: /Confirm Restore/i });
    await expect(confirmButton).toBeDisabled();

    // Select a backup (first one)
    await page
      .getByRole("button", { name: /minecraft-backup-/i })
      .first()
      .click();

    // Confirm restore button should now be enabled
    await expect(confirmButton).toBeEnabled();
  });
});
