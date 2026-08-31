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
  test.describe.configure({ timeout: 60_000 });

  test("cost and email panels retain reachable close controls", async ({ page }) => {
    await setSmallViewport(page);
    await setupStoppedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: "Open cost dashboard" }).click();
    const costClose = page.getByRole("button", { name: "Close cost dashboard" });
    await expectReachable(costClose);
    await costClose.click();

    await page.getByRole("button", { name: "Open email management" }).click();
    const emailClose = page.getByRole("button", { name: "Close email management" });
    await expectReachable(emailClose);
    await emailClose.click();
  });

  test("resume dialog retains a reachable working close control", async ({ page }) => {
    await setSmallViewport(page);
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /^resume$/i }).click();
    const dialog = page.getByRole("dialog", { name: "Resume World" });
    const close = page.getByRole("button", { name: "Close resume dialog" });
    await expectReachable(close);
    await close.click();
    await expect(dialog).not.toBeVisible();
  });

  test("Google Drive, backup, restore, and confirmation dialogs retain reachable controls", async ({ page }) => {
    await setSmallViewport(page);
    await setupRunningScenario(page);
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");
    await page.goto("/");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /^backup$/i }).click();
    const driveClose = page.getByRole("button", { name: "Close Google Drive setup" });
    await expectReachable(driveClose);
    await driveClose.click();

    await setMockParameter(page, "/minecraft/gdrive-token", "mock-token", "SecureString");
    await page.reload();
    await waitForPageLoad(page);

    await page.getByRole("button", { name: /^backup$/i }).click();
    const backupClose = page.getByTestId("backup-dialog").getByRole("button", { name: "Close dialog" });
    await expectReachable(backupClose);
    await backupClose.click();

    await page.getByRole("button", { name: /^restore$/i }).click();
    const restoreClose = page.getByTestId("restore-dialog").getByRole("button", { name: "Close dialog" });
    await expectReachable(restoreClose);
    await restoreClose.click();

    await page.getByRole("button", { name: /^hibernate$/i }).click();
    await expectReachable(page.getByTestId("confirmation-dialog").getByRole("button", { name: "Close dialog" }));
  });
});
