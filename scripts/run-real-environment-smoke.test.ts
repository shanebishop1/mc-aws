import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSmoke } from "./run-real-environment-smoke";

const sentinels = [
  "owner@example.invalid",
  "role-linked-admin",
  "i-0123456789abcdef0",
  "arn:aws:cloudformation:us-east-1:123456789012:stack/Sentinel/id",
  "203.0.113.42",
  "response-derived-identifier-7f6f8a",
  "RUNNING_OPERATIONAL_SENTINEL",
  "ACTIVE_SERVICE_SENTINEL",
  "98765.4321",
];

const originalEnv = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const response = (body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status: 200, headers });

const failedResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 503 });
const refreshProbe = "0123456789abcdef0123456789abcdef";
const refreshHeaders = { "x-status-cache": "MISS", "x-status-refresh-probe": refreshProbe };
const hitHeaders = { "x-status-cache": "HIT", "x-status-refresh-probe": refreshProbe };

describe("real-environment smoke reporting", () => {
  it("never writes response-derived identities to successful summaries or artifacts", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    const stepSummaryPath = path.join(directory, "step-summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: sentinels[4],
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_BACKEND_MODE: "aws",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_ENABLE_S5_ENVIRONMENT_PROBE: "true",
      SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE: "true",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
      GITHUB_STEP_SUMMARY: stepSummaryPath,
    };

    const replies = [
      response({ authenticated: true, email: sentinels[0], role: sentinels[1] }),
      response({ success: true, data: { instanceId: sentinels[2] } }),
      response({
        success: true,
        data: { instanceRunning: true, serviceActive: true, operationalDetail: sentinels[6] },
      }),
      response({ success: true, data: { instanceId: sentinels[2], domain: "expected.invalid" } }, refreshHeaders),
      response({ success: true, data: { instanceId: sentinels[2], serviceDetail: sentinels[7] } }, hitHeaders),
      response({ success: true, data: { stackId: sentinels[3] } }),
      response({ success: true, data: { totalCost: "98765.4321", responseId: sentinels[5] } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => replies.shift() ?? response({}))
    );

    expect(await runSmoke()).toBe(0);
    const emitted = `${readFileSync(artifactPath, "utf8")}\n${readFileSync(stepSummaryPath, "utf8")}`;
    for (const sentinel of sentinels) expect(emitted).not.toContain(sentinel);
    expect(emitted).not.toContain("x-status-cache");
    expect(emitted).not.toContain("HIT");
    expect(emitted).not.toContain("totalCost");
    expect(emitted).not.toContain("instanceRunning");
    expect(emitted).not.toContain("serviceActive");
    expect(emitted).toContain("Overall verdict: **PASS**");
    expect(emitted).toContain("authenticated contract passed");
    expect(emitted).toContain("real backend contract passed");
    expect(emitted).toContain("service contract passed");
    expect(emitted).toContain("runtime binding contract passed");
    expect(emitted).toContain("optional environment contract passed");
  });

  it("replaces exception messages with a fixed failure signal", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error(sentinels.join(" | "))))
    );

    expect(await runSmoke()).toBe(1);
    const emitted = readFileSync(artifactPath, "utf8");
    for (const sentinel of sentinels) expect(emitted).not.toContain(sentinel);
    expect(emitted).toContain("authenticated contract failed");
    expect(emitted).toContain("credentials/config");
  });

  it("marks the overall verdict failed when required S5 fails without exposing response details", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_ENABLE_S5_ENVIRONMENT_PROBE: "true",
      SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE: "true",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    const replies = [
      response({ authenticated: true, email: "redacted@example.invalid", role: "admin" }),
      response({ success: true, data: { instanceId: "i-real" } }),
      response({ success: true, data: { instanceRunning: true, serviceActive: true } }),
      response({ success: true, data: { instanceId: "i-real", domain: "expected.invalid" } }, refreshHeaders),
      response({ success: true, data: { instanceId: "i-real" } }, hitHeaders),
      response({ success: true }),
      failedResponse({ error: sentinels[5], totalCost: sentinels[8] }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => replies.shift() ?? response({}))
    );

    expect(await runSmoke()).toBe(1);
    const emitted = readFileSync(artifactPath, "utf8");
    expect(emitted).toContain("Overall verdict: **FAIL**");
    expect(emitted).toContain("| S5 | fail | optional environment contract failed |");
    expect(emitted).not.toContain(sentinels[5]);
    expect(emitted).not.toContain(sentinels[8]);
  });

  it("fails S4 unless the forced write is followed by a runtime-state cache hit", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    const replies = [
      response({ authenticated: true, email: "redacted@example.invalid", role: "admin" }),
      response({ success: true, data: { instanceId: "i-real" } }),
      response({ success: true, data: { instanceRunning: true, serviceActive: true } }),
      response({ success: true, data: { instanceId: "i-real", domain: "expected.invalid" } }, refreshHeaders),
      response(
        { success: true, data: { instanceId: "i-real" } },
        { "x-status-cache": "HIT", "x-status-refresh-probe": "fedcba9876543210fedcba9876543210" }
      ),
      response({ success: true, data: { exists: true } }),
    ];
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => replies.shift() ?? response({})
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await runSmoke()).toBe(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://smoke.invalid/api/status?refresh=1",
      expect.objectContaining({ method: "GET" })
    );
    const emitted = readFileSync(artifactPath, "utf8");
    expect(emitted).toContain("| S4 | fail | runtime binding contract failed |");
  });

  it("accepts the declared string totalCost contract", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_ENABLE_S5_ENVIRONMENT_PROBE: "true",
      SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE: "true",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    const replies = [
      response({ authenticated: true, email: "redacted@example.invalid", role: "admin" }),
      response({ success: true, data: { instanceId: "i-real" } }),
      response({ success: true, data: { instanceRunning: true, serviceActive: true } }),
      response({ success: true, data: { instanceId: "i-real", domain: "expected.invalid" } }, refreshHeaders),
      response({ success: true, data: { instanceId: "i-real" } }, hitHeaders),
      response({ success: true, data: { exists: true } }),
      response({ success: true, data: { totalCost: "12.3400" } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => replies.shift() ?? response({}))
    );

    expect(await runSmoke()).toBe(0);
    expect(readFileSync(artifactPath, "utf8")).toContain("optional environment contract passed");
  });

  it.each([undefined, "wrong.invalid"])("fails when the required DNS domain is %s", async (domain) => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    const replies = [
      response({ authenticated: true, email: "redacted@example.invalid", role: "admin" }),
      response({ success: true, data: { instanceId: "i-real" } }),
      response({ success: true, data: { instanceRunning: true, serviceActive: true } }),
      response({ success: true, data: { instanceId: "i-real", ...(domain ? { domain } : {}) } }, refreshHeaders),
      response({ success: true, data: { instanceId: "i-real" } }, hitHeaders),
      response({ success: true, data: { exists: true } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => replies.shift() ?? response({}))
    );

    expect(await runSmoke()).toBe(1);
    expect(readFileSync(artifactPath, "utf8")).toContain("| S4 | fail | runtime binding contract failed |");
  });

  it("requires expected-domain configuration before required checks run", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await runSmoke()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(artifactPath, "utf8")).toContain("authenticated contract failed");
  });

  it("aborts a timed-out request and still finalizes the summary", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-real-smoke-"));
    temporaryDirectories.push(directory);
    const artifactPath = path.join(directory, "summary.md");
    process.env = {
      ...originalEnv,
      SMOKE_BASE_URL: "https://smoke.invalid",
      SMOKE_ENVIRONMENT_LABEL: "redacted",
      SMOKE_SESSION_COOKIE: "safe-session-cookie-value",
      SMOKE_EXPECT_DOMAIN: "expected.invalid",
      SMOKE_REQUEST_TIMEOUT_MS: "100",
      SMOKE_SUMMARY_OUTPUT_PATH: artifactPath,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      })
    );

    expect(await runSmoke()).toBe(1);
    expect(readFileSync(artifactPath, "utf8")).toContain("Overall verdict: **FAIL**");
    expect(readFileSync(artifactPath, "utf8")).toContain("authenticated contract failed");
  });
});
