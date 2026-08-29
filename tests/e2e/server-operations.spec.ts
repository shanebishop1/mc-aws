import { expect, test } from "@playwright/test";
import { confirmDialog, waitForLoading, waitForPageLoad } from "./helpers";
import { setMockParameter, setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

const seedBackupsCache = async (page: Parameters<typeof setupHibernatedScenario>[0]) => {
  await setMockParameter(
    page,
    "/minecraft/backups-cache",
    JSON.stringify({
      backups: [{ name: "minecraft-backup-2025-01-15" }, { name: "minecraft-backup-2025-01-20" }],
      cachedAt: Date.now(),
    })
  );
};

test.describe("Server Operations", () => {
  test.beforeEach(async ({ page }) => {
    // Reset and authenticate before each test
    await setupStoppedScenario(page);
  });

  test("starts server without confirmation", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click start button
    await page.getByRole("button", { name: /start server/i }).click();

    // Should NOT show confirmation dialog
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Should show starting state
    await expect(page.getByText(/starting/i)).toBeVisible();
  });

  test("stops server without confirmation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click stop button
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should NOT show confirmation dialog
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Should show stopping state
    await expect(page.getByText(/stopping/i)).toBeVisible();
  });

  test("reports stop completion only after status reaches stopped", async ({ page }) => {
    test.setTimeout(60_000);
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);
    const stopButton = page.getByRole("button", { name: /stop server/i });
    await expect(stopButton).toBeVisible({ timeout: 15_000 });
    await page.route("**/api/stop", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          operation: { schemaVersion: 1, id: "stop-status-only", type: "stop", status: "accepted" },
          timestamp: new Date().toISOString(),
        }),
      });
    });
    await page.route("**/api/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            state: "stopped",
            instanceId: "i-test",
            hasVolume: true,
            lastUpdated: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await stopButton.click();
    await expect(page.getByText("Stop completed successfully.", { exact: true })).toBeVisible();
  });

  test("hibernate requires confirmation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Hibernate Server/i)).toBeVisible();
    await expect(
      page.getByText(/This will backup your server, stop the instance, and delete the volume to save costs/i)
    ).toBeVisible();

    // Confirm hibernate
    await confirmDialog(page);

    // Verify action started
    await expect(page.getByTestId("server-status")).toContainText(/stopping\.\.\.|hibernating/i);
  });

  test("can cancel hibernate confirmation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Should show confirmation dialog
    await expect(page.getByText(/Hibernate Server/i)).toBeVisible();

    // Cancel hibernate
    await page.getByRole("button", { name: /cancel/i }).click();

    // Dialog should close
    await expect(page.getByText(/Hibernate Server/i)).not.toBeVisible();

    // Should not show hibernating state
    await expect(page.getByText(/hibernating/i)).not.toBeVisible();
  });

  test("resume with start fresh option", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByText(/Resume World/i)).toBeVisible();

    // Should show two options
    await expect(page.getByRole("button", { name: /Start Fresh World/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Restore from Backup/i })).toBeVisible();

    // Click start fresh
    await page.getByRole("button", { name: /Start Fresh World/i }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();

    // Should show resuming state (starting...)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
  });

  test("resume with restore from backup option", async ({ page }) => {
    await setupHibernatedScenario(page);
    await seedBackupsCache(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click restore from backup
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/Select Backup/i)).toBeVisible();

    // Wait for backups to load
    await expect(page.getByRole("button", { name: /minecraft-backup-/i }).first()).toBeVisible({ timeout: 10000 });

    // Select a backup (first one)
    await page
      .getByRole("button", { name: /minecraft-backup-/i })
      .first()
      .click();

    // Confirm restore
    await page.getByRole("button", { name: /Confirm Restore/i }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();

    // Should show resuming state (starting...)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
  });

  test("can cancel resume modal", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click the named close button
    await page.getByRole("button", { name: "Close resume dialog" }).click();

    // Modal should close
    await expect(modal).not.toBeVisible();
  });

  test("can go back from backup selection to choice view", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Should show resume modal
    const modal = page.getByTestId("resume-modal");
    await expect(modal).toBeVisible();

    // Click restore from backup
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/Select Backup/i)).toBeVisible();

    // Click back button
    await page.getByRole("button", { name: /Back/i }).click();

    // Should return to choice view
    await expect(page.getByText(/Resume World/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Start Fresh World/i })).toBeVisible();
  });

  test("shows loading state during start operation", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click start button
    await page.getByRole("button", { name: /start server/i }).click();

    // Should show starting state (wait for it to appear)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible({ timeout: 5000 });
  });

  test("polls operation status and reports asynchronous start failure", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.route("**/api/start", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          operation: { schemaVersion: 1, id: "start-e2e-failure", type: "start", status: "accepted" },
          data: { message: "Start accepted" },
          timestamp: new Date().toISOString(),
        }),
      });
    });
    await page.route("**/api/operations/start-e2e-failure", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            schemaVersion: 1,
            id: "start-e2e-failure",
            type: "start",
            route: "/api/start",
            status: "failed",
            requestedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastError: "Instance failed health checks",
            history: [],
          },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /start server/i }).click();

    await expect(page.getByText("Failed: Instance failed health checks", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /start server/i })).toBeEnabled();
    await expect(page.getByText("Start completed successfully.")).not.toBeVisible();
  });

  test("continues polling when a 503 preserves an accepted operation", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.route("**/api/start", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Remote dispatch could not be confirmed",
          operation: { id: "start-unconfirmed", type: "start", status: "accepted" },
          timestamp: new Date().toISOString(),
        }),
      });
    });
    await page.route("**/api/operations/start-unconfirmed", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            schemaVersion: 1,
            id: "start-unconfirmed",
            type: "start",
            route: "/api/start",
            status: "completed",
            requestedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /start server/i }).click();

    await expect(page.getByText("Start completed successfully.")).toBeVisible();
    await expect(page.getByText(/Failed: Remote dispatch could not be confirmed/)).not.toBeVisible();
  });

  for (const scenario of [
    { name: "terminal failure", expected: "Failed: Accepted operation failed", status: 200 },
    { name: "authorization failure", expected: "Failed: Your session expired. Please sign in again.", status: 401 },
    { name: "timeout", expected: "Failed: Operation timed out while waiting for completion", status: 200 },
  ] as const) {
    test(`recovers from accepted-503 polling ${scenario.name} without an unhandled rejection`, async ({ page }) => {
      await setupStoppedScenario(page);
      const pageErrors: Error[] = [];
      page.on("pageerror", (error) => pageErrors.push(error));
      await page.route("**/api/start", async (route) => {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Remote dispatch could not be confirmed",
            operation: { id: "start-poll-recovery", type: "start", status: "accepted" },
            timestamp: new Date().toISOString(),
          }),
        });
      });
      await page.route("**/api/operations/start-poll-recovery", async (route) => {
        if (scenario.status === 401) {
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ success: false, error: "Authentication required" }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              schemaVersion: 1,
              id: "start-poll-recovery",
              type: "start",
              route: "/api/start",
              status: "failed",
              requestedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastError: "Accepted operation failed",
            },
            timestamp: new Date().toISOString(),
          }),
        });
      });

      await page.goto("/");
      await waitForPageLoad(page);
      if (scenario.name === "timeout") {
        await page.evaluate(() => {
          let now = Date.now();
          Date.now = () => {
            now += 18 * 60 * 1000;
            return now;
          };
        });
      }
      await page.getByRole("button", { name: /start server/i }).click();

      await expect(page.getByText(scenario.expected, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /start server/i })).toBeEnabled();
      expect(pageErrors).toEqual([]);
    });
  }

  test("does not begin operation polling when the page unmounts during the action POST", async ({ page }) => {
    await setupStoppedScenario(page);
    let operationPolls = 0;
    await page.route("**/api/start", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route
        .fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            operation: { schemaVersion: 1, id: "start-after-unmount", type: "start", status: "accepted" },
            timestamp: new Date().toISOString(),
          }),
        })
        .catch(() => undefined);
    });
    await page.route("**/api/operations/start-after-unmount", async (route) => {
      operationPolls += 1;
      await route.fulfill({ status: 500, body: "unexpected poll" });
    });

    await page.goto("/");
    await waitForPageLoad(page);
    const postStarted = page.waitForRequest("**/api/start");
    await page.getByRole("button", { name: /start server/i }).click();
    await postStarted;
    await page.goto("about:blank");
    await page.waitForTimeout(600);

    expect(operationPolls).toBe(0);
  });

  test("keeps the resume dialog close control reachable at 320 by 568", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /^resume$/i }).click();

    const dialog = page.getByRole("dialog", { name: "Resume World" });
    const closeButton = page.getByRole("button", { name: "Close resume dialog" });
    await expect(dialog).toBeVisible();
    await expect(closeButton).toBeInViewport();
    await closeButton.click();
    await expect(dialog).not.toBeVisible();
  });

  test("shows loading state during stop operation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click stop button
    await page.getByRole("button", { name: /stop server/i }).click();

    // Should show stopping state (wait for it to appear)
    await expect(page.getByText(/stopping\.\.\./i)).toBeVisible({ timeout: 5000 });
  });

  test("shows loading state during hibernate operation", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click hibernate button
    await page.getByRole("button", { name: /hibernate/i }).click();

    // Confirm hibernate
    await confirmDialog(page);

    // Should indicate progress (can briefly be Stopping... or quickly transition to Hibernating)
    await expect(page.getByTestId("server-status")).toContainText(/stopping\.\.\.|hibernating/i, { timeout: 5000 });
  });

  test("shows loading state during resume operation", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    await page.getByRole("button", { name: /Start Fresh World/i }).click();

    // Should show starting state (resume uses start operation)
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible({ timeout: 5000 });
  });

  test("resume confirm restore is disabled until backup is selected", async ({ page }) => {
    await setupHibernatedScenario(page);
    await seedBackupsCache(page);
    await page.goto("/");
    await waitForPageLoad(page);

    // Click resume button
    await page.getByRole("button", { name: /resume/i }).click();

    // Click restore from backup
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    // Should switch to backups view
    await expect(page.getByText(/Select Backup/i)).toBeVisible();

    // Confirm restore button should be disabled initially
    const confirmButton = page.getByRole("button", { name: /Confirm Restore/i });
    await expect(confirmButton).toBeDisabled();

    // Select a backup (first one)
    await page
      .getByRole("button", { name: /minecraft-backup-/i })
      .first()
      .click();

    // Confirm restore button should now be enabled
    await expect(confirmButton).toBeEnabled();
  });
});
