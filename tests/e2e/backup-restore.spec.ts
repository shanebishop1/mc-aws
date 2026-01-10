import { expect, test } from "@playwright/test";
import { setupMocks } from "../mocks/handlers";
import { confirmDialog, expectErrorMessage, expectSuccessMessage, waitForPageLoad } from "./helpers";

test.describe("Backup and Restore", () => {
  test("backup with confirmation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/backup server/i)).toBeVisible();
    await expect(page.getByText(/upload it to google drive/i)).toBeVisible();

    // Confirm the action
    await confirmDialog(page);

    // Verify success message
    await expectSuccessMessage(page, /backup completed successfully/i);
  });

  test("backup shows Google Drive prompt when not configured", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-not-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show Google Drive setup prompt (not confirmation dialog)
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();
    await expect(page.getByText(/google drive required/i)).toBeVisible();
    await expect(page.getByText(/configure google drive to create backups/i)).toBeVisible();

    // Should NOT show confirmation dialog
    await expect(page.getByText(/backup server/i)).not.toBeVisible();
  });

  test("backup blocked without Google Drive setup", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-not-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Close the prompt without setting up
    await page.keyboard.press("Escape");

    // Should show error about needing Google Drive
    await expectErrorMessage(page, /google drive is required/i);
  });

  test("restore with confirmation", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/restore server/i)).toBeVisible();
    await expect(page.getByText(/this will restore your server from a backup/i)).toBeVisible();
    await expect(page.getByText(/any unsaved progress will be lost/i)).toBeVisible();

    // Confirm the action
    await confirmDialog(page);

    // Verify success message
    await expectSuccessMessage(page, /restore completed successfully/i);
  });

  test("restore shows Google Drive prompt when not configured", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-not-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt (not confirmation dialog)
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();
    await expect(page.getByText(/google drive required/i)).toBeVisible();
    await expect(page.getByText(/configure google drive to restore backups/i)).toBeVisible();

    // Should NOT show confirmation dialog
    await expect(page.getByText(/restore server/i)).not.toBeVisible();
  });

  test("restore blocked without Google Drive setup", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-not-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Close the prompt without setting up
    await page.keyboard.press("Escape");

    // Should show error about needing Google Drive
    await expectErrorMessage(page, /google drive is required/i);
  });

  test("backup and restore buttons only visible when server is running", async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // When stopped, backup/restore buttons should not be visible
    const backupButton = page.getByRole("button", { name: /backup/i });
    const restoreButton = page.getByRole("button", { name: /restore/i });

    await expect(backupButton).not.toBeVisible();
    await expect(restoreButton).not.toBeVisible();

    // Note: Testing visibility when running would require changing the server state
    // which is covered by other tests
  });

  test("backup confirmation can be cancelled", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/backup server/i)).toBeVisible();

    // Cancel the dialog
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /cancel/i })
      .click();

    // Dialog should close
    await expect(page.getByText(/backup server/i)).not.toBeVisible();

    // No success message should appear
    await expect(page.getByText(/backup completed successfully/i)).not.toBeVisible();
  });

  test("restore confirmation can be cancelled", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/restore server/i)).toBeVisible();

    // Cancel the dialog
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /cancel/i })
      .click();

    // Dialog should close
    await expect(page.getByText(/restore server/i)).not.toBeVisible();

    // No success message should appear
    await expect(page.getByText(/restore completed successfully/i)).not.toBeVisible();
  });

  test("backup prompt close button shows error", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-not-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /backup/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Click the close button (X)
    await page.getByRole("button", { name: /close modal/i }).click();

    // Should show error about needing Google Drive
    await expectErrorMessage(page, /google drive is required/i);
  });

  test("restore prompt close button shows error", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-not-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /restore/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Click the close button (X)
    await page.getByRole("button", { name: /close modal/i }).click();

    // Should show error about needing Google Drive
    await expectErrorMessage(page, /google drive is required/i);
  });
});
