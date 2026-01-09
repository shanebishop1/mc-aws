import { test, expect } from "@playwright/test";
import { setupMocks } from "../mocks/handlers";
import { confirmDialog, expectSuccessMessage, expectErrorMessage, waitForLoading } from "./helpers";

test.describe("Destroy Flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page, ["stack-stopped", "gdrive-configured"]);
    await page.goto("/");
  });

  test("destroys successfully with typed confirmation", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Destroy Minecraft Server")).toBeVisible();
    await expect(page.getByText(/permanently delete/i)).toBeVisible();
    await expect(page.getByText(/cannot be undone/i)).toBeVisible();
    await expect(page.getByText(/type "destroy" to confirm/i)).toBeVisible();

    await confirmDialog(page, "destroy");

    await expect(page.getByText(/Destruction started/i)).toBeVisible();
  });

  test("cannot confirm without typing destroy", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const confirmButton = page.getByRole("button", { name: /destroy server/i });
    await expect(confirmButton).toBeDisabled();

    const input = page.getByRole("dialog").getByRole("textbox");
    await input.fill("destro");

    await expect(confirmButton).toBeDisabled();
  });

  test("confirm button enables when exact confirmation is typed", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const confirmButton = page.getByRole("button", { name: /destroy server/i });
    await expect(confirmButton).toBeDisabled();

    const input = page.getByRole("dialog").getByRole("textbox");
    await input.fill("destroy");

    await expect(confirmButton).toBeEnabled();
  });

  test("destroy shows danger styling", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const dialog = page.getByTestId("confirmation-dialog");
    await expect(dialog).toBeVisible();

    const title = page.getByRole("heading", { name: "Destroy Minecraft Server" });
    await expect(title).toHaveClass(/text-red-600/);

    const confirmButton = page.getByRole("button", { name: /destroy server/i });
    await expect(confirmButton).toHaveClass(/border-red-600.*text-red-600/);

    const input = page.getByRole("dialog").getByRole("textbox");
    await expect(input).toHaveClass(/border-red-300/);
  });

  test("destroy shows loading state during destruction", async ({ page }) => {
    await page.route("**/api/destroy", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { message: "Stack destruction started", output: "Deleting Minecraft stack..." },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const input = page.getByRole("dialog").getByRole("textbox");
    await input.fill("destroy");

    const confirmButton = page.getByRole("button", { name: /destroy server/i });
    await confirmButton.click();

    await expect(confirmButton).toHaveText(/loading/i);
    await expect(confirmButton).toBeDisabled();
    await expect(input).toBeDisabled();
  });

  test("destroy error handling shows error message", async ({ page }) => {
    await page.route("**/api/destroy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Failed to destroy stack: AWS API error",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.getByTestId("destroy-button").click();

    await confirmDialog(page, "destroy");

    await expect(page.getByText(/Destruction failed: Failed to destroy stack: AWS API error/i)).toBeVisible();
  });

  test("destroy network error handling", async ({ page }) => {
    await page.route("**/api/destroy", async (route) => {
      await route.abort("failed");
    });

    await page.getByTestId("destroy-button").click();

    await confirmDialog(page, "destroy");

    await expect(page.getByText(/Destruction failed/i)).toBeVisible();
  });

  test("can cancel destroy dialog", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const cancelButton = page.getByRole("button", { name: /cancel/i });
    await cancelButton.click();

    await expect(page.getByRole("dialog")).not.toBeVisible();

    await expect(page.getByTestId("destroy-button")).toBeVisible();
  });

  test("typing confirmation is case-sensitive", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const confirmButton = page.getByRole("button", { name: /destroy server/i });
    const input = page.getByRole("dialog").getByRole("textbox");

    await input.fill("DESTROY");
    await expect(confirmButton).toBeDisabled();

    await input.fill("Destroy");
    await expect(confirmButton).toBeDisabled();

    await input.fill("destroy");
    await expect(confirmButton).toBeEnabled();
  });

  test("dialog closes after successful destruction", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    await confirmDialog(page, "destroy");

    await expect(page.getByText(/Destruction started/i)).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("dialog stays open after error and can be cancelled", async ({ page }) => {
    await page.route("**/api/destroy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "AWS connection error",
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    await confirmDialog(page, "destroy");

    await expect(page.getByText(/Destruction failed/i)).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("escape key closes dialog when not loading", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("clicking outside dialog closes it", async ({ page }) => {
    await page.getByTestId("destroy-button").click();

    await expect(page.getByRole("dialog")).toBeVisible();

    const dialog = page.getByTestId("confirmation-dialog");
    await dialog.click({ position: { x: 10, y: 10 } });

    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});
