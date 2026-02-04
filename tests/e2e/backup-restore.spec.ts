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

    // Verify success message (backup is now asynchronous)
    await expectSuccessMessage(page, /Backup started asynchronously/i);
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

    // Set mock backups cache with sample backups
    const mockBackups = {
      backups: [
        { name: "minecraft-backup-2025-01-15" },
        { name: "minecraft-backup-2025-01-20" },
        { name: "minecraft-backup-2025-02-01" },
      ],
      cachedAt: Date.now(),
    };
    await setMockParameter(page, "/minecraft/backups-cache", JSON.stringify(mockBackups), "String");

    await page.goto("/");
    await waitForPageLoad(page);

    // Wait for the restore button to be visible
    await page.getByRole("button", { name: /restore/i }).waitFor({ state: "visible" });

    // Click the main restore button
    await page.getByRole("button", { name: /restore/i }).click();

    // Should show restore dialog with backup selection
    await expect(page.getByTestId("restore-dialog")).toBeVisible();
    await expect(page.getByText(/Restore Backup/i)).toBeVisible();
    await expect(page.getByText(/Select a backup to restore from Google Drive/i)).toBeVisible();

    // Wait for backup list to load
    await expect(page.getByTestId("backup-selection-list")).toBeVisible({ timeout: 5000 });

    // Select a backup from the list
    await page.getByText("minecraft-backup-2025-01-20").click();

    // Verify the selected backup name is visible in the input
    const backupInput = page.getByTestId("restore-backup-input");
    await expect(backupInput).toHaveValue("minecraft-backup-2025-01-20");

    // Verify the confirmation summary shows the selected backup
    await expect(page.getByText(/Restore backup: minecraft-backup-2025-01-20/i)).toBeVisible();

    // Click the restore confirm button
    await page.getByTestId("restore-confirm").click();

    // Verify success message (restore is now asynchronous)
    await expectSuccessMessage(page, /Restore started asynchronously/i);
  });

  test("restore with manual input when listing fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Set empty/invalid backups cache to simulate listing failure
    await setMockParameter(page, "/minecraft/backups-cache", "", "String");

    await page.goto("/");
    await waitForPageLoad(page);

    // Wait for the restore button to be visible
    await page.getByRole("button", { name: /restore/i }).waitFor({ state: "visible" });

    // Click the main restore button
    await page.getByRole("button", { name: /restore/i }).click();

    // Should show restore dialog
    await expect(page.getByTestId("restore-dialog")).toBeVisible();
    await expect(page.getByText(/Restore Backup/i)).toBeVisible();

    // Type a backup name manually
    const backupInput = page.getByTestId("restore-backup-input");
    await backupInput.fill("manual-backup-2025-02-03");

    // Verify the confirmation summary shows the typed backup
    await expect(page.getByText(/Restore backup: manual-backup-2025-02-03/i)).toBeVisible();

    // Click the restore confirm button
    await page.getByTestId("restore-confirm").click();

    // Verify success message
    await expectSuccessMessage(page, /Restore started asynchronously/i);
  });

  test("restore shows Google Drive prompt when not configured", async ({ page }) => {
    // Setup running scenario
    await setupRunningScenario(page);

    // Clear Google Drive token to simulate not configured
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");

    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt (not restore dialog)
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Google Drive Required/i)).toBeVisible();
    await expect(page.getByText(/Connect Google Drive to restore backups/i)).toBeVisible();

    // Should NOT show restore dialog
    await expect(page.getByTestId("restore-dialog")).not.toBeVisible();
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

    // Should show restore dialog
    await expect(page.getByTestId("restore-dialog")).toBeVisible();
    await expect(page.getByText(/Restore Backup/i)).toBeVisible();

    // Cancel the dialog
    await page
      .getByTestId("restore-dialog")
      .getByRole("button", { name: /cancel/i })
      .click();

    // Dialog should close
    await expect(page.getByTestId("restore-dialog")).not.toBeVisible();

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
