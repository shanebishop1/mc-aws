import { type Locator, expect, test } from "@playwright/test";
import { waitForPageLoad } from "./helpers";
import { setMockParameter, setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

const setSmallViewport = async (page: Parameters<typeof setupStoppedScenario>[0]) => {
  await page.setViewportSize({ width: 320, height: 568 });
};

const expectReachable = async (control: Locator) => {
  await expect(control).toBeVisible();
  await expect(control).toBeInViewport();
  await expect(control).toBeEnabled();
};

test.describe("Small viewport dialogs", () => {
  // A fresh Next.js dev server may spend most of Playwright's 30s default compiling
  // the authenticated panel/API routes before these viewport assertions begin.
  test.describe.configure({ timeout: 60_000 });

  test("cost and email panels retain reachable close controls", async ({ page }) => {
    await setSmallViewport(page);
    await setupStoppedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: "Open cost dashboard" }).click();
    await expectReachable(page.getByRole("button", { name: "Close cost dashboard" }));
    await page.getByRole("button", { name: "Close cost dashboard" }).click();

    await page.getByRole("button", { name: "Open email management" }).click();
    const emailClose = page.getByRole("button", { name: "Close email management" });
    await expectReachable(emailClose);
    await emailClose.click();
  });

  test("resume dialog retains a reachable close control", async ({ page }) => {
    await setSmallViewport(page);
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /^resume$/i }).click();
    await expectReachable(page.getByRole("button", { name: "Close resume dialog" }));
  });

  test("Google Drive, backup, restore, and confirmation dialogs retain reachable controls", async ({ page }) => {
    await setSmallViewport(page);
    await setupRunningScenario(page);
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /^backup$/i }).click();
    await expectReachable(page.getByRole("button", { name: "Close Google Drive setup" }));
    await page.getByRole("button", { name: "Close Google Drive setup" }).click();

    await setMockParameter(page, "/minecraft/gdrive-token", "mock-token", "SecureString");
    await page.reload();
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /^backup$/i }).click();
    const backupDialog = page.getByTestId("backup-dialog");
    await expectReachable(backupDialog.getByRole("button", { name: "Close dialog" }));
    await backupDialog.getByRole("button", { name: "Close dialog" }).click();

    await page.getByRole("button", { name: /^restore$/i }).click();
    const restoreDialog = page.getByTestId("restore-dialog");
    await expectReachable(restoreDialog.getByRole("button", { name: "Close dialog" }));
    await restoreDialog.getByRole("button", { name: "Close dialog" }).click();

    await page.getByRole("button", { name: /^hibernate$/i }).click();
    const confirmation = page.getByTestId("confirmation-dialog");
    await expectReachable(confirmation.getByRole("button", { name: "Close dialog" }));
  });
});
