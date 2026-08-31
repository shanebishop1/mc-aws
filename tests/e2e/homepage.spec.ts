import { expect, test } from "@playwright/test";
import { navigateTo, waitForPageLoad } from "./helpers";
import { setupErrorsScenario, setupStoppedScenario } from "./setup";

test("Connection Error suppresses all mutating server controls", async ({ page }) => {
  await setupErrorsScenario(page);
  await navigateTo(page, "/");

  await expect(page.getByRole("heading", { name: /Connection Error/i })).toBeVisible();
  for (const action of ["start", "stop", "hibernate", "resume", "backup", "restore"]) {
    await expect(page.getByRole("button", { name: new RegExp(action, "i") })).not.toBeVisible();
  }
});

test("unauthenticated Start opens login and preserves the pending action", async ({ page }) => {
  await setupStoppedScenario(page);
  await page.context().clearCookies();
  await navigateTo(page, "/");
  await waitForPageLoad(page);

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: /start server/i }).click();
  const popup = await popupPromise;

  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("mc_pending_action"))).toBe("start");
  await popup.close();
});
