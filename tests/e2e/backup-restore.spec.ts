import { expect, test } from "@playwright/test";
import { expectSuccessMessage, waitForPageLoad } from "./helpers";
import { setMockParameter, setupRunningScenario } from "./setup";

const openRunningServer = async (page: Parameters<typeof setupRunningScenario>[0]) => {
  await setupRunningScenario(page);
  await page.goto("/");
  await waitForPageLoad(page);
};

const seedBackups = async (page: Parameters<typeof setupRunningScenario>[0]) => {
  await setMockParameter(
    page,
    "/minecraft/backups-cache",
    JSON.stringify({
      backups: [
        { name: "minecraft-backup-2025-01-15" },
        { name: "minecraft-backup-2025-01-20" },
        { name: "minecraft-backup-2025-02-01" },
      ],
      cachedAt: Date.now(),
    })
  );
};

const openDriveAction = async (page: Parameters<typeof setupRunningScenario>[0], action: "backup" | "restore") => {
  const statusResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/gdrive/status" && response.request().method() === "GET"
  );
  await page.getByRole("button", { name: new RegExp(`^${action}$`, "i") }).click();
  expect((await statusResponse).ok()).toBe(true);
};

test.describe("Backup and Restore", () => {
  test.describe.configure({ timeout: 60_000 });

  test("completes a confirmed backup", async ({ page }) => {
    await openRunningServer(page);
    await openDriveAction(page, "backup");
    const dialog = page.getByTestId("backup-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^backup$/i }).click();
    await expectSuccessMessage(page, /Backup completed successfully/i);
  });

  test("restores the backup selected from the normal list", async ({ page }) => {
    await setupRunningScenario(page);
    await seedBackups(page);
    await page.goto("/");
    await waitForPageLoad(page);

    await openDriveAction(page, "restore");
    await expect(page.getByTestId("backup-selection-list")).toBeVisible();
    await page.getByText("minecraft-backup-2025-01-20", { exact: true }).click();
    await expect(page.getByTestId("restore-backup-input")).toHaveValue("minecraft-backup-2025-01-20");
    const restoreRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/restore" && request.method() === "POST"
    );
    await page.getByTestId("restore-confirm").click();
    expect((await restoreRequest).postDataJSON()).toEqual({ backupName: "minecraft-backup-2025-01-20" });
    await expectSuccessMessage(page, /Restore completed successfully/i);
  });

  test("submits a manually entered backup name", async ({ page }) => {
    await setupRunningScenario(page);
    await setMockParameter(page, "/minecraft/backups-cache", "", "String");
    await page.goto("/");
    await waitForPageLoad(page);

    await openDriveAction(page, "restore");
    const input = page.getByTestId("restore-backup-input");
    await input.fill("manual-backup-2025-02-03");
    await expect(page.getByText(/Restore backup: manual-backup-2025-02-03/i)).toBeVisible();
    const restoreRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/restore" && request.method() === "POST"
    );
    await page.getByTestId("restore-confirm").click();
    expect((await restoreRequest).postDataJSON()).toEqual({ backupName: "manual-backup-2025-02-03" });
    await expectSuccessMessage(page, /Restore completed successfully/i);
  });

  test("explains missing Google Drive for backup and restore and reports prompt closure", async ({ page }) => {
    await setupRunningScenario(page);
    await setMockParameter(page, "/minecraft/gdrive-token", "", "SecureString");
    await page.goto("/");
    await waitForPageLoad(page);

    for (const action of ["backup", "restore"] as const) {
      await openDriveAction(page, action);
      const prompt = page.getByTestId("gdrive-setup-prompt");
      await expect(prompt).toContainText(
        action === "backup" ? /Connect Google Drive to create backups/i : /Connect Google Drive to restore backups/i
      );
      await page.getByRole("button", { name: "Close Google Drive setup" }).click();
      await expect(prompt).not.toBeVisible();
      const errorToast = page.getByTestId("controls-section").getByRole("alert");
      await expect(errorToast).toContainText(/Google Drive is required for this operation/i);
      await page.getByRole("button", { name: "Dismiss error" }).click();
      await expect(errorToast).not.toBeVisible();
    }
  });

  test("cancelling backup and restore dialogs sends no operation POST", async ({ page }) => {
    await openRunningServer(page);
    const operationPosts: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST" && (pathname === "/api/backup" || pathname === "/api/restore")) {
        operationPosts.push(pathname);
      }
    });

    await openDriveAction(page, "backup");
    await page
      .getByTestId("backup-dialog")
      .getByRole("button", { name: /cancel/i })
      .click();
    await expect(page.getByTestId("backup-dialog")).not.toBeVisible();

    await openDriveAction(page, "restore");
    await page
      .getByTestId("restore-dialog")
      .getByRole("button", { name: /cancel/i })
      .click();
    await expect(page.getByTestId("restore-dialog")).not.toBeVisible();
    expect(operationPosts).toEqual([]);
  });
});
