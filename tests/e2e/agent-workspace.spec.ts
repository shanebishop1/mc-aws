import { expect, test } from "@playwright/test";
import { setupTestEnvironment } from "./setup";

test("admin runs mock agent approval, revocation, denial, cancellation, and cursor reconnect flows", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setupTestEnvironment(page);
  const cursors: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/agent/sessions/") && request.url().endsWith("/events")) {
      const cursor = request.headers()["last-event-id"];
      if (cursor) cursors.push(cursor);
    }
  });
  await page.goto("/agent", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Agent control room" })).toBeVisible();
  await page.getByRole("radio", { name: "Custom" }).click();
  await page.getByRole("combobox", { name: "workspace / write permission" }).selectOption("ask-once");
  await expect(page.getByRole("combobox", { name: "Provider profile" })).toHaveValue("local-fake", {
    timeout: 20_000,
  });
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("deterministic-v1", {
    timeout: 20_000,
  });
  await page
    .getByRole("textbox", { name: "Agent task" })
    .fill("Inspect server.properties and propose an exact safe change.");
  await page.getByRole("button", { name: "Dispatch task" }).click();

  // The first SSE route request may include a cold Next route-bundle compile.
  await expect(page.getByText("Task accepted by the deterministic control-plane fixture.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("list").getByText("server.properties", { exact: true })).toBeVisible();
  await expect(page.getByText("Session capability grant")).toBeVisible();
  await expect(page.getByText("Invocation", { exact: true })).toBeVisible();
  await expect(page.getByText("File diff summary", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Grant matching actions for session" }).click();
  await expect(page.getByText("approved", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Revoke grant" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => cursors.length).toBeGreaterThan(0);

  await page.getByRole("radio", { name: "Continue selected idle session" }).click();
  await page.getByRole("textbox", { name: "Agent task" }).fill("Explain the prior result using persisted context.");
  await page.getByRole("button", { name: "Continue session" }).click();
  await expect(page.getByText("Continuation accepted with persisted conversation context.")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("radio", { name: "New session" }).click();
  await page.getByRole("textbox", { name: "Agent task" }).fill("Propose another scoped configuration check.");
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("denied", { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Cancel session" }).click();
  await expect(page.getByLabel("Session status").getByText("cancelled", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: "Final result" })).toBeVisible({ timeout: 15_000 });
});
