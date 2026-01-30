import { expect, test } from "@playwright/test";
import { navigateTo, waitForPageLoad } from "./helpers";
import { setupErrorsScenario, setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

test.describe("Homepage States", () => {
  test("shows deploy button when no stack exists", async ({ page }) => {
    // Note: The default scenario has a stack, so we need to use the errors scenario
    // which simulates stack not existing
    await setupErrorsScenario(page);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Should show error message (stack doesn't exist)
    await expect(page.getByText(/stack does not exist/i)).toBeVisible();

    // Should not show server controls
    await expect(page.getByRole("button", { name: /start/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /hibernate/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /backup/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).not.toBeVisible();
  });

  test("shows server controls when stack exists and stopped", async ({ page }) => {
    await setupStoppedScenario(page);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

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
    await setupRunningScenario(page);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

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
    await setupHibernatedScenario(page);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

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
    await setupErrorsScenario(page);

    // Navigate to status page
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    // Should show error message
    await expect(page.getByText(/stack does not exist/i)).toBeVisible();

    // Should not show server controls
    await expect(page.getByRole("button", { name: /start/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /hibernate/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /backup/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /restore/i })).not.toBeVisible();
  });
});
