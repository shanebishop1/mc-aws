import { expect, test } from "@playwright/test";
import { navigateTo, waitForPageLoad } from "./e2e/helpers";
import { setupRunningScenario, setupStoppedScenario } from "./e2e/setup";

test.describe("Mock mode full flows", () => {
  test("renders the running status dashboard", async ({ page }) => {
    await setupRunningScenario(page);
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    await expect(page.locator("h2").getByText("Online", { exact: true })).toBeVisible();
    await expect(page.getByText(/5 players online/i)).toBeVisible();
    await page.getByRole("button", { name: /open cost dashboard/i }).click();
    const costsResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/costs" && response.status() === 200
    );
    await page.getByRole("button", { name: /generate report/i }).click();
    await costsResponse;
    await expect(page.getByTestId("cost-dashboard").getByText(/amazon ec2/i)).toBeVisible();
    await expect(page.getByTestId("cost-dashboard").getByText(/\$15\.50/i)).toBeVisible();
  });

  test("transitions a full Start flow from stopped to running", async ({ page }) => {
    await setupStoppedScenario(page);
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    const responsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/start" && response.status() === 202
    );
    await page.getByRole("button", { name: /start server/i }).click();
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
    await responsePromise;
    await expect(page.locator("h2").getByText("Online", { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test("transitions a full Stop flow from running to stopped", async ({ page }) => {
    await setupRunningScenario(page);
    await navigateTo(page, "/");
    await waitForPageLoad(page);

    const responsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/stop" && response.status() === 202
    );
    await page.getByRole("button", { name: /stop server/i }).click();
    await expect(page.getByText(/stopping\.\.\./i)).toBeVisible();
    await responsePromise;
    await expect(page.locator("h2").getByText(/stopped/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /start server/i })).toBeVisible();
  });
});
