import { type Page, type Response, expect, test } from "@playwright/test";
import { injectFault, setupRunningScenario } from "./setup";

const waitForPost = (page: Page, endpoint: string): Promise<Response> =>
  page.waitForResponse(
    (response) => new URL(response.url()).pathname === endpoint && response.request().method() === "POST"
  );

const expectAcceptedUnresolved = async (response: { status(): number; json(): Promise<unknown> }) => {
  expect(response.status()).toBe(503);
  const data = (await response.json()) as {
    success?: boolean;
    error?: string;
    operation?: { id?: string; status?: string };
  };
  expect(data).toMatchObject({
    success: false,
    operation: { status: "accepted" },
  });
  expect(data.error).toMatch(/Remote dispatch could not be confirmed/i);
  return data.operation?.id;
};

test.describe("Ambiguous dispatch", () => {
  test("keeps Stop waiting and pollable after transport acceptance is unresolved", async ({ page }) => {
    await setupRunningScenario(page);
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "IncorrectState",
      errorMessage: "Instance is in an incorrect state for this operation",
    });
    await page.goto("/");

    const responsePromise = waitForPost(page, "/api/stop");
    await page.getByRole("button", { name: /stop server/i }).click();
    const operationId = await expectAcceptedUnresolved(await responsePromise);

    await expect(
      page.getByRole("status").filter({ hasText: "Stop request accepted. Waiting for the server to stop…" })
    ).toBeVisible();
    const operationResponse = await page.request.get(`/api/operations/${operationId}`);
    expect(operationResponse.status()).toBe(200);
    expect(await operationResponse.json()).toMatchObject({ data: { status: "accepted" } });
  });

  test("persists an accepted Backup operation after an unresolved transport failure", async ({ page }) => {
    await setupRunningScenario(page);
    await injectFault(page, {
      operation: "invokeLambda",
      failNext: true,
      errorCode: "InvalidInstanceId",
      errorMessage: "The specified instance ID is not valid",
    });

    const operationId = await expectAcceptedUnresolved(await page.request.post("/api/backup", { data: {} }));
    const operationResponse = await page.request.get(`/api/operations/${operationId}`);
    expect(operationResponse.status()).toBe(200);
    expect(await operationResponse.json()).toMatchObject({
      data: { id: operationId, type: "backup", status: "accepted", phase: "dispatching" },
    });
  });
});
