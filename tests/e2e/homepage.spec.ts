import { test, expect } from "@playwright/test";
import { setupMocks } from "../mocks/handlers";
import { waitForPageLoad } from "./helpers";

test.describe("Homepage States", () => {
  test("shows deploy button when no stack exists", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Should show deploy button
    await expect(page.getByRole("button", { name: /deploy/i })).toBeVisible();
    await expect(page.getByText(/no server deployed/i)).toBeVisible();

    // Should not show server controls
    await expect(page.getByRole("button", { name: /start/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /hibernate/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /backup/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).not.toBeVisible();
  });

  test("shows server controls when stack exists and stopped", async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Should not show deploy button
    await expect(page.getByRole("button", { name: /deploy/i })).not.toBeVisible();
    await expect(page.getByText(/no server deployed/i)).not.toBeVisible();

    // Should show Start Server button
    await expect(page.getByRole("button", { name: /start/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /start server/i })).toBeVisible();

    // Should show Hibernate button
    await expect(page.getByRole("button", { name: /hibernate/i })).toBeVisible();

    // Should not show Stop, Resume, or Backup/Restore buttons
    await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /backup/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).not.toBeVisible();
  });

  test("shows server controls when stack exists and running", async ({ page }) => {
    await setupMocks(page, ["stack-running", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Should not show deploy button
    await expect(page.getByRole("button", { name: /deploy/i })).not.toBeVisible();
    await expect(page.getByText(/no server deployed/i)).not.toBeVisible();

    // Should show Stop Server button
    await expect(page.getByRole("button", { name: /stop/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /stop server/i })).toBeVisible();

    // Should show Backup and Restore buttons
    await expect(page.getByRole("button", { name: /backup/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).toBeVisible();

    // Should not show Start, Hibernate, or Resume buttons
    await expect(page.getByRole("button", { name: /start/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /hibernate/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).not.toBeVisible();
  });

  test("shows server controls when stack exists and hibernating", async ({ page }) => {
    await setupMocks(page, ["stack-hibernating", "gdrive-configured"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Should not show deploy button
    await expect(page.getByRole("button", { name: /deploy/i })).not.toBeVisible();
    await expect(page.getByText(/no server deployed/i)).not.toBeVisible();

    // Should show Resume button
    await expect(page.getByRole("button", { name: /resume/i })).toBeVisible();

    // Should not show Start, Stop, Hibernate, or Backup/Restore buttons
    await expect(page.getByRole("button", { name: /start/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /hibernate/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /backup/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).not.toBeVisible();
  });

  test("shows error message when AWS error occurs", async ({ page }) => {
    await setupMocks(page, ["aws-error"]);
    await page.goto("/");
    await waitForPageLoad(page);

    // Should show error message
    await expect(page.getByText(/connection error/i)).toBeVisible();
    await expect(page.getByText(/aws connection failed/i)).toBeVisible();

    // Should NOT show deploy button
    await expect(page.getByRole("button", { name: /deploy/i })).not.toBeVisible();

    // Should not show server controls
    await expect(page.getByRole("button", { name: /start/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /hibernate/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /backup/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).not.toBeVisible();
  });
});
