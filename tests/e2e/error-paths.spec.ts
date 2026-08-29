import { type Page, type Response, expect, test } from "@playwright/test";
import { confirmDialog } from "./helpers";
import { injectFault, setupHibernatedScenario, setupRunningScenario, setupStoppedScenario } from "./setup";

const unresolvedDispatchMessage = /Remote dispatch could not be confirmed/i;

const waitForActionResponse = (page: Page, endpoint: string): Promise<Response> =>
  page.waitForResponse(
    (response) => new URL(response.url()).pathname === endpoint && response.request().method() === "POST"
  );

async function expectAcceptedUnresolvedResponse(response: Response): Promise<void> {
  expect(response.status()).toBe(503);
  const data = (await response.json()) as {
    success?: boolean;
    error?: string;
    operation?: { status?: string };
  };
  expect(data.success).toBe(false);
  expect(data.error).toMatch(unresolvedDispatchMessage);
  expect(data.operation).toMatchObject({ status: "accepted" });
}

test.describe("Error Handling", () => {
  test.beforeEach(async ({ page }) => {
    // Reset and authenticate before each test
    await setupStoppedScenario(page);
  });

  test("shows error when AWS connection fails on load", async ({ page }) => {
    // Inject fault for getStackStatus operation
    await injectFault(page, {
      operation: "getStackStatus",
      alwaysFail: true,
      errorCode: "ValidationError",
      errorMessage: "Stack does not exist",
    });

    await page.goto("/");

    // Should show "Connection Error" message
    await expect(page.getByText(/Connection Error/i)).toBeVisible({ timeout: 10000 });
  });

  test("keeps an ambiguously dispatched start in accepted waiting state", async ({ page }) => {
    await setupStoppedScenario(page);

    // Inject fault for start operation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "You have reached the maximum number of running instances",
    });

    await page.goto("/");
    const responsePromise = waitForActionResponse(page, "/api/start");
    await page.getByRole("button", { name: /start server/i }).click();
    await expectAcceptedUnresolvedResponse(await responsePromise);

    await expect(
      page.getByRole("status").filter({ hasText: "Start request accepted. Waiting for completion…" })
    ).toBeVisible({
      timeout: 5000,
    });
  });

  test("keeps an ambiguously dispatched stop in accepted waiting state", async ({ page }) => {
    await setupRunningScenario(page);

    // Fail the transport after dispatch begins, leaving remote acceptance unresolved.
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Instance is in an incorrect state for this operation",
    });

    await page.goto("/");
    const responsePromise = waitForActionResponse(page, "/api/stop");
    await page.getByRole("button", { name: /stop server/i }).click();
    await expectAcceptedUnresolvedResponse(await responsePromise);

    await expect(
      page.getByRole("status").filter({ hasText: "Stop request accepted. Waiting for the server to stop…" })
    ).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows error when backup fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for backup Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    const response = await page.request.post("/api/backup", { data: {} });

    expect(response.status()).toBe(503);
    const data = (await response.json()) as {
      success?: boolean;
      error?: string;
      operation?: { id?: string; status?: string };
    };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(unresolvedDispatchMessage);
    expect(data.operation).toMatchObject({ status: "accepted" });

    const operationResponse = await page.request.get(`/api/operations/${data.operation?.id}`);
    expect(operationResponse.status()).toBe(200);
    expect(await operationResponse.json()).toMatchObject({ data: { status: "accepted" } });
  });

  test("shows error when restore fails", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for restore Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    // Restore flow is modal-driven and timing-sensitive in UI, so validate endpoint contract directly.
    const response = await page.request.post("/api/restore", {
      data: { backupName: "minecraft-backup-2025-01-15" },
    });

    expect(response.status()).toBe(503);
    const data = (await response.json()) as { success?: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(unresolvedDispatchMessage);
  });

  test("keeps an ambiguously dispatched hibernate in accepted waiting state", async ({ page }) => {
    await setupRunningScenario(page);

    // Inject fault for hibernate Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Instance is in an incorrect state for this operation",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /hibernate/i }).click();
    const responsePromise = waitForActionResponse(page, "/api/hibernate");
    await confirmDialog(page);
    await expectAcceptedUnresolvedResponse(await responsePromise);

    await expect(
      page.getByRole("status").filter({ hasText: "Hibernate request accepted. Waiting for completion…" })
    ).toBeVisible({
      timeout: 5000,
    });
  });

  test("keeps an ambiguously dispatched resume in accepted waiting state", async ({ page }) => {
    await setupHibernatedScenario(page);

    // Inject fault for resume Lambda invocation
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InstanceLimitExceeded",
      errorMessage: "You have reached the maximum number of running instances",
    });

    await page.goto("/");
    await page.getByRole("button", { name: /resume/i }).click();

    // Click start fresh
    const responsePromise = waitForActionResponse(page, "/api/resume");
    await page.getByRole("button", { name: /Start Fresh World/i }).click();
    await expectAcceptedUnresolvedResponse(await responsePromise);

    await expect(
      page.getByRole("status").filter({ hasText: "Resume request accepted. Waiting for completion…" })
    ).toBeVisible({
      timeout: 5000,
    });
  });
});
