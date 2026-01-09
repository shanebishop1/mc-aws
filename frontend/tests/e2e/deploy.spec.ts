import { test, expect } from "@playwright/test";
import { setupMocks } from "../mocks/handlers";
import { confirmDialog } from "./helpers";

test.describe("Deploy Flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page, ["no-stack"]);
  });

  test("deploys successfully with Google Drive configured", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Verify confirmation dialog is visible
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/deploy minecraft server/i)).toBeVisible();
    await expect(page.getByText(/this will create a new minecraft server/i)).toBeVisible();

    // Verify confirmation input is required
    await expect(page.getByLabel(/type "deploy" to confirm/i)).toBeVisible();

    // Type "deploy" in confirmation input
    await page.getByRole("textbox").fill("deploy");

    // Click confirm button
    await page.getByRole("button", { name: /deploy/i }).click();

    // Verify success message
    await expect(page.getByText(/server deployed successfully/i)).toBeVisible();
  });

  test("shows Google Drive prompt when not configured", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-not-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Type "deploy" in confirmation input
    await page.getByRole("textbox").fill("deploy");

    // Click confirm button
    await page.getByRole("button", { name: /deploy/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();
    await expect(page.getByText(/set up backups/i)).toBeVisible();
    await expect(page.getByText(/configure google drive for automatic backups/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /set up google drive/i })).toBeVisible();
  });

  test("allows skipping Google Drive setup and deploying anyway", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-not-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Type "deploy" in confirmation input
    await page.getByRole("textbox").fill("deploy");

    // Click confirm button
    await page.getByRole("button", { name: /deploy/i }).click();

    // Should show Google Drive setup prompt
    await expect(page.getByTestId("gdrive-setup-prompt")).toBeVisible();

    // Click skip button
    await page.getByRole("button", { name: /skip for now/i }).click();

    // Verify success message
    await expect(page.getByText(/server deployed successfully/i)).toBeVisible();
  });

  test("cannot confirm without typing 'deploy'", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Verify confirm button is disabled initially
    const confirmButton = page.getByRole("button", { name: /deploy/i });
    await expect(confirmButton).toBeDisabled();

    // Type wrong text
    await page.getByRole("textbox").fill("incorrect");

    // Verify confirm button is still disabled
    await expect(confirmButton).toBeDisabled();

    // Type partial match
    await page.getByRole("textbox").fill("dep");

    // Verify confirm button is still disabled
    await expect(confirmButton).toBeDisabled();

    // Type case-sensitive "deploy"
    await page.getByRole("textbox").fill("DEPLOY");

    // Verify confirm button is still disabled (case sensitive)
    await expect(confirmButton).toBeDisabled();
  });

  test("shows loading state during deployment", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Type "deploy" in confirmation input
    await page.getByRole("textbox").fill("deploy");

    // Setup delay for loading state observation
    await page.route("**/api/deploy", async (route) => {
      // Small delay to ensure loading state is visible
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            message: "Deployment started",
            output: "Building Minecraft stack...",
          },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    // Click confirm button
    await page.getByRole("button", { name: /deploy/i }).click();

    // Verify button shows loading state
    await expect(page.getByRole("button", { name: /deploying\.\.\./i })).toBeVisible();

    // Wait for loading to complete
    await expect(page.getByText(/server deployed successfully/i)).toBeVisible();
  });

  test("shows error message when deployment fails", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Type "deploy" in confirmation input
    await page.getByRole("textbox").fill("deploy");

    // Mock failed deployment response
    await page.route("**/api/deploy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to create CloudFormation stack: Insufficient permissions",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    // Click confirm button
    await page.getByRole("button", { name: /deploy/i }).click();

    // Verify error message is shown
    await expect(page.getByText(/deployment failed/i)).toBeVisible();
    await expect(page.getByText(/insufficient permissions/i)).toBeVisible();

    // Verify button is no longer in loading state
    await expect(page.getByRole("button", { name: /deploy server/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /deploy server/i })).not.toHaveText(/deploying\.\.\./i);
  });

  test("can cancel deployment confirmation dialog", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Verify confirmation dialog is visible
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click cancel button
    await page.getByRole("button", { name: /cancel/i }).click();

    // Verify dialog is closed
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Verify deploy button is still visible and clickable
    await expect(page.getByRole("button", { name: /deploy server/i })).toBeVisible();
  });

  test("can close confirmation dialog by clicking outside", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Verify confirmation dialog is visible
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click outside the dialog (on the backdrop)
    const dialog = page.getByRole("dialog");
    const boundingBox = await dialog.boundingBox();
    if (boundingBox) {
      await page.mouse.click(boundingBox.x - 10, boundingBox.y - 10);
    }

    // Verify dialog is closed
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("shows proper confirmation prompt description", async ({ page }) => {
    await setupMocks(page, ["no-stack", "gdrive-configured"]);
    await page.goto("/");

    // Click deploy button
    await page.getByRole("button", { name: /deploy server/i }).click();

    // Verify dialog contains correct information
    await expect(page.getByText(/this will create a new minecraft server on aws/i)).toBeVisible();
    await expect(page.getByText(/required infrastructure/i)).toBeVisible();
    await expect(page.getByText(/ec2 instance, networking, storage, and lambda functions/i)).toBeVisible();
    await expect(page.getByText(/process takes several minutes to complete/i)).toBeVisible();

    // Verify label for confirmation input
    await expect(page.getByLabel(/type "deploy" to confirm/i)).toBeVisible();
  });
});
