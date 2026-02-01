import { expect, test } from "@playwright/test";
import { confirmDialog, expectErrorMessage, expectSuccessMessage, waitForPageLoad } from "./helpers";
import { setMockParameter, setupRunningScenario } from "./setup";

test.describe("Backup and Restore", () => {
  // Note: setupRunningScenario already handles authentication and reset in each test

  test("backup with confirmation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Wait for the backup button to be visible (requires status fetch to complete)
    await page.getByRole("button", { name: /backup/i }).waitFor({ state: "visible" });

    // Click the main backup button
    await page.getByRole("button", { name: /backup/i }).click();

    // Should show backup dialog
    await expect(page.getByTestId("backup-dialog")).toBeVisible();
    await expect(page.getByText(/Backup Server/i)).toBeVisible();
    await expect(page.getByText(/Create a backup of your server and upload it to Google Drive/i)).toBeVisible();

    // Click the Backup button in the dialog (scoped to the dialog)
    await page
      .getByTestId("backup-dialog")
      .getByRole("button", { name: /backup/i })
      .click();

    // Verify success message
    await expectSuccessMessage(page, /backup completed successfully/i);
  });

  test("backup shows Google Drive prompt when not configured", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show Google Drive setup prompt (not confirmation dialog)
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Google Drive Required/i)).toBeVisible();
    await expect(page.getByText(/Connect Google Drive to create backups/i)).toBeVisible();

    // Should NOT show confirmation dialog
    await expect(page.getByTestId("backup-dialog")).not.toBeVisible();
  });

  test("backup blocked without Google Drive setup", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Close the prompt without setting up
    await page.keyboard.press("Escape");

    // Should show error about needing Google Drive
    await expect(page.getByText(/Google Drive is required for this operation/i)).toBeVisible();
  });

  test("restore with confirmation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Wait for the restore button to be visible
    await page.getByRole("button", { name: /restore/i }).waitFor({ state: "visible" });

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Restore Server/i)).toBeVisible();
    await expect(page.getByText(/This will restore your server from a backup on Google Drive/i)).toBeVisible();
    await expect(page.getByText(/Any unsaved progress will be lost/i)).toBeVisible();

    // Confirm the action (scoped to the dialog)
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /restore/i })
      .click();

    // Verify success message
    await expectSuccessMessage(page, /restore completed successfully/i);
  });

  test("restore shows Google Drive prompt when not configured", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt (not confirmation dialog)
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Google Drive Required/i)).toBeVisible();
    await expect(page.getByText(/Connect Google Drive to restore backups/i)).toBeVisible();

    // Should NOT show confirmation dialog
    await expect(page.getByText(/Restore Server/i)).not.toBeVisible();
  });

  test("restore blocked without Google Drive setup", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Close the prompt without setting up
    await page.keyboard.press("Escape");

    // Should show error about needing Google Drive
    await expect(page.getByText(/Google Drive is required for this operation/i)).toBeVisible();
  });

  test("backup and restore buttons only visible when server is running", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // When running, backup/restore buttons should be visible
    const backupButton = page.getByRole("button", { name: /backup/i });
    const restoreButton = page.getByRole("button", { name: /restore/i });

    await expect(backupButton).toBeVisible();
    await expect(restoreButton).toBeVisible();
  });

  test("backup confirmation can be cancelled", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Backup Server/i)).toBeVisible();

    // Cancel the dialog
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /cancel/i })
      .click();

    // Dialog should close
    await expect(page.getByText(/Backup Server/i)).not.toBeVisible();

    // No success message should appear
    await expect(page.getByText(/backup completed successfully/i)).not.toBeVisible();
  });

  test("restore confirmation can be cancelled", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Restore Server/i)).toBeVisible();

    // Cancel the dialog
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /cancel/i })
      .click();

    // Dialog should close
    await expect(page.getByText(/Restore Server/i)).not.toBeVisible();

    // No success message should appear
    await expect(page.getByText(/restore completed successfully/i)).not.toBeVisible();
  });

  test("backup prompt close button shows error", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Click the close button (X)
    await page.getByRole("button", { name: /close modal/i }).click();

    // Should show error about needing Google Drive (look for the error toast)
    await expect(page.locator("p.text-sm.text-red-700")).toContainText("Google Drive is required for this operation");
  });

  test("restore prompt close button shows error", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Click the close button (X)
    await page.getByRole("button", { name: /close modal/i }).click();

    // Should show error about needing Google Drive (look for the error toast)
    await expect(page.locator("p.text-sm.text-red-700")).toContainText("Google Drive is required for this operation");
  });
});
