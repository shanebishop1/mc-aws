import { expect, test } from "@playwright/test";
import { setupMocks } from "../mocks/handlers";
import { confirmDialog } from "./helpers";

test.describe("Error Handling", () => {
  test("shows error when AWS connection fails on load", async ({ page }) => {
    await setupMocks(page, ["aws-error"]);
    await page.goto("/");

    // Should show Connection Error heading
    await expect(page.getByText(/Connection Error/i)).toBeVisible();

    // Should show error message
    await expect(page.getByText(/AWS connection failed/i)).toBeVisible();
  });

  test("shows error when start fails", async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);

    // Override start endpoint to return error
    await page.route("**/api/start", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to start instance",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /start server/i }).click();

    // Should show error message in footer
    await expect(page.getByText(/failed to start/i)).toBeVisible();
  });

  test("shows error when stop fails", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);

    // Override stop endpoint to return error
    await page.route("**/api/stop", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to stop instance",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should show error message
    await expect(page.getByText(/failed to stop/i)).toBeVisible();
  });

  test("shows error when backup fails", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);

    // Override backup to fail
    await page.route("**/api/backup", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to create backup",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /backup/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/backup.*failed|failed.*backup/i)).toBeVisible();
  });

  test("shows error when restore fails", async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);

    // Override restore to fail
    await page.route("**/api/restore", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to restore from backup",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /restore/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/restore.*failed|failed.*restore/i)).toBeVisible();
  });

  test("shows error when hibernate fails", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);

    // Override hibernate to fail
    await page.route("**/api/hibernate", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to hibernate server",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /hibernate/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/hibernate.*failed|failed.*hibernate/i)).toBeVisible();
  });

  test("shows error when resume fails", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);

    // Override resume to fail
    await page.route("**/api/resume", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to resume server",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /resume/i }).click();
    await confirmDialog(page);

    // Should show error message
    await expect(page.getByText(/resume.*failed|failed.*resume/i)).toBeVisible();
  });
});
