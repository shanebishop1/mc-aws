import { expect, test } from "@playwright/test";
import { confirmDialog, waitForPageLoad } from "./helpers";
import { setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

const acceptedOperation = (id: string, type = "start") => ({ schemaVersion: 1, id, type, status: "accepted" });

const operationState = (id: string, status: "completed" | "failed", lastError?: string) => ({
  success: true,
  data: {
    schemaVersion: 1,
    id,
    type: id.startsWith("stop") ? "stop" : "start",
    route: id.startsWith("stop") ? "/api/stop" : "/api/start",
    status,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError,
    history: [],
  },
  timestamp: new Date().toISOString(),
});

test.describe("Server operation orchestration", () => {
  test("reports Stop completion only after server status reaches stopped", async ({ page }) => {
    test.setTimeout(60_000);
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);

    let stopStarted = false;
    let mayReportStopped = false;
    let postActionStoppingResponses = 0;
    let releaseSecondStatus: (() => void) | undefined;
    let markSecondStatusRequested: (() => void) | undefined;
    const secondStatusRequested = new Promise<void>((resolve) => {
      markSecondStatusRequested = resolve;
    });
    const secondStatusGate = new Promise<void>((resolve) => {
      releaseSecondStatus = resolve;
    });
    await page.route("**/api/stop", (route) => {
      stopStarted = true;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ success: true, operation: acceptedOperation("stop-status-only", "stop") }),
      });
    });
    await page.route("**/api/operations/stop-status-only", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(operationState("stop-status-only", "completed")),
      })
    );
    await page.route("**/api/status", async (route) => {
      if (stopStarted) {
        postActionStoppingResponses += 1;
        if (postActionStoppingResponses === 2) {
          markSecondStatusRequested?.();
          await secondStatusGate;
        }
      }
      const state = !stopStarted ? "running" : mayReportStopped ? "stopped" : "stopping";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            state,
            instanceId: "i-test",
            hasVolume: true,
            lastUpdated: new Date().toISOString(),
          },
        }),
      });
    });

    await page.getByRole("button", { name: /stop server/i }).click();
    await expect(page.getByTestId("server-status")).toContainText(/stopping/i);
    await secondStatusRequested;
    await page.waitForTimeout(100);
    await expect(page.getByText("Stop completed successfully.", { exact: true })).not.toBeVisible();
    mayReportStopped = true;
    releaseSecondStatus?.();
    await expect(page.getByText("Stop completed successfully.", { exact: true })).toBeVisible();
  });

  test("cancels Hibernate without a POST, then confirms and exposes its loading state", async ({ page }) => {
    await setupRunningScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);
    let hibernatePosts = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/hibernate" && request.method() === "POST") hibernatePosts += 1;
    });

    await page.getByRole("button", { name: /^hibernate$/i }).click();
    await expect(
      page.getByText(/This will backup your server, stop the instance, and delete the volume/i)
    ).toBeVisible();
    await page
      .getByTestId("confirmation-dialog")
      .getByRole("button", { name: /cancel/i })
      .click();
    await expect(page.getByTestId("confirmation-dialog")).not.toBeVisible();
    expect(hibernatePosts).toBe(0);

    await page.getByRole("button", { name: /^hibernate$/i }).click();
    const hibernateRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/hibernate" && request.method() === "POST"
    );
    await confirmDialog(page);
    await hibernateRequest;
    await expect(page.getByTestId("server-status")).toContainText(/stopping|hibernating/i);
  });

  test("resumes a fresh world and exposes its loading state", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /^resume$/i }).click();
    const resumeRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/resume" && request.method() === "POST"
    );
    await page.getByRole("button", { name: /Start Fresh World/i }).click();
    expect((await resumeRequest).postDataJSON()).toEqual({ restoreMode: "fresh" });
    await expect(page.getByTestId("resume-modal")).not.toBeVisible();
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
  });

  test("resumes a named backup with back navigation and guarded confirmation", async ({ page }) => {
    await setupHibernatedScenario(page);
    await page.route("**/api/backups**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            status: "listing",
            backups: [{ name: "minecraft-backup-2025-01-15" }, { name: "minecraft-backup-2025-01-20" }],
            count: 2,
          },
        }),
      })
    );
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /^resume$/i }).click();
    await page.getByRole("button", { name: /Restore from Backup/i }).click();
    await page.getByRole("button", { name: /^Back$/i }).click();
    await expect(page.getByRole("button", { name: /Start Fresh World/i })).toBeVisible();
    await page.getByRole("button", { name: /Restore from Backup/i }).click();

    const confirm = page.getByRole("button", { name: /Confirm Restore/i });
    await expect(confirm).toBeDisabled();
    await page.getByRole("button", { name: "minecraft-backup-2025-01-20" }).click();
    await expect(confirm).toBeEnabled();
    const resumeRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/resume" && request.method() === "POST"
    );
    await confirm.click();
    expect((await resumeRequest).postDataJSON()).toEqual({
      restoreMode: "named",
      backupName: "minecraft-backup-2025-01-20",
    });
    await expect(page.getByTestId("resume-modal")).not.toBeVisible();
    await expect(page.getByText(/starting\.\.\./i)).toBeVisible();
  });

  test("polls and reports an asynchronous Start terminal failure", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.route("**/api/start", (route) =>
      route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ success: true, operation: acceptedOperation("start-e2e-failure") }),
      })
    );
    await page.route("**/api/operations/start-e2e-failure", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(operationState("start-e2e-failure", "failed", "Instance failed health checks")),
      })
    );
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /start server/i }).click();
    await expect(page.getByText("Failed: Instance failed health checks", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /start server/i })).toBeEnabled();
  });

  test("hands an accepted 503 response off to operation polling", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.route("**/api/start", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Remote dispatch could not be confirmed",
          operation: acceptedOperation("start-unconfirmed"),
        }),
      })
    );
    await page.route("**/api/operations/start-unconfirmed", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(operationState("start-unconfirmed", "completed")),
      })
    );
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /start server/i }).click();
    await expect(page.getByText("Start completed successfully.")).toBeVisible();
    await expect(page.getByText(/Failed: Remote dispatch could not be confirmed/)).not.toBeVisible();
  });

  test("recovers from accepted-503 polling authorization failure without an unhandled rejection", async ({ page }) => {
    await setupStoppedScenario(page);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/api/start", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Remote dispatch could not be confirmed",
          operation: acceptedOperation("start-auth-failure"),
        }),
      })
    );
    await page.route("**/api/operations/start-auth-failure", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Authentication required" }),
      })
    );
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /start server/i }).click();
    await expect(page.getByText("Failed: Your session expired. Please sign in again.", { exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("recovers from an accepted operation timeout without an unhandled rejection", async ({ page }) => {
    await setupStoppedScenario(page);
    await page.clock.install({ time: new Date("2026-08-31T12:00:00.000Z") });
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/api/start", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Remote dispatch could not be confirmed",
          operation: acceptedOperation("start-timeout"),
        }),
      })
    );
    let operationPolls = 0;
    await page.route("**/api/operations/start-timeout", (route) => {
      operationPolls += 1;
      const now = new Date();
      const body = {
        success: true,
        data: {
          ...operationState("start-timeout", "failed").data,
          status: "running",
          phase: "executing",
          lastError: undefined,
        },
        timestamp: now.toISOString(),
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/");
    await waitForPageLoad(page);
    await page.getByRole("button", { name: /start server/i }).click();
    await expect.poll(() => operationPolls).toBeGreaterThan(0);
    await page.clock.fastForward(17 * 60 * 1000 + 1);

    await expect(
      page.getByText("Failed: Operation timed out while waiting for completion", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /start server/i })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });

  test("cancels before polling when the page unmounts during the action POST", async ({ page }) => {
    await setupStoppedScenario(page);
    let operationPolls = 0;
    await page.route("**/api/start", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route
        .fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ success: true, operation: acceptedOperation("start-after-unmount") }),
        })
        .catch(() => undefined);
    });
    await page.route("**/api/operations/start-after-unmount", (route) => {
      operationPolls += 1;
      return route.fulfill({ status: 500, body: "unexpected poll" });
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
});
