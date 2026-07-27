import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWranglerDeployArgs,
  deriveWorkersDevPanel,
  googleOAuthCallbackUrl,
  prepareWranglerDeployConfig,
  validateCustomPanelUrl,
  validatePanelHostingEnvironment,
} from "./panel-hosting";

const workerName = "mc-aws-panel";
const kvId = "0123456789abcdef0123456789abcdef";
const kvPreviewId = "fedcba9876543210fedcba9876543210";

const createWranglerFixture = (): { sourcePath: string; outputPath: string } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-panel-hosting-"));
  const sourcePath = path.join(tempDir, "wrangler.jsonc");
  const outputPath = path.join(tempDir, "wrangler.deploy.jsonc");
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ name: workerName, kv_namespaces: [{ binding: "RUNTIME_STATE_SNAPSHOT_KV", id: "" }] })}\n`
  );
  return { sourcePath, outputPath };
};

describe("workers.dev panel URL", () => {
  it.each([
    ["account-name", "account-name.workers.dev"],
    ["account-name.workers.dev", "account-name.workers.dev"],
    ["https://mc-aws-panel.account-name.workers.dev", "account-name.workers.dev"],
  ])("derives the canonical URL from %s", (input, accountSubdomain) => {
    expect(deriveWorkersDevPanel(workerName, input)).toEqual({
      accountSubdomain,
      appUrl: "https://mc-aws-panel.account-name.workers.dev",
    });
  });

  it.each([
    "http://mc-aws-panel.account.workers.dev",
    "https://other-worker.account.workers.dev",
    "https://mc-aws-panel.account.workers.dev/path",
    "account.example.com",
  ])("rejects unsafe or mismatched input %s", (input) => {
    expect(() => deriveWorkersDevPanel(workerName, input)).toThrow();
  });

  it("produces the exact Google OAuth callback", () => {
    expect(googleOAuthCallbackUrl("https://mc-aws-panel.account.workers.dev")).toBe(
      "https://mc-aws-panel.account.workers.dev/api/auth/callback"
    );
  });
});

describe("custom panel URL", () => {
  it("accepts an HTTPS Cloudflare hostname origin", () => {
    expect(validateCustomPanelUrl("https://panel.example.com")).toBe("https://panel.example.com");
  });

  it.each([
    "http://panel.example.com",
    "https://panel.example.com/path",
    "https://panel.example.com:8443",
    "https://mc-aws-panel.account.workers.dev",
  ])("rejects an invalid custom origin %s", (input) => {
    expect(() => validateCustomPanelUrl(input)).toThrow();
  });
});

describe("Wrangler panel hosting deployment contract", () => {
  it("enables workers.dev in generated config and deploys without a route", () => {
    const { sourcePath, outputPath } = createWranglerFixture();
    const config = prepareWranglerDeployConfig({
      sourcePath,
      outputPath,
      runtimeStateSnapshotKvId: kvId,
      runtimeStateSnapshotKvPreviewId: kvPreviewId,
      panelHostingMode: "workers_dev",
    });

    expect(config.workers_dev).toBe(true);
    expect(buildWranglerDeployArgs({ configPath: outputPath, workerName, panelHostingMode: "workers_dev" })).toEqual([
      "deploy",
      "--config",
      outputPath,
      "--name",
      workerName,
    ]);
  });

  it.each([false, true])(
    "deliberately configures custom-host workers_dev=%s and includes the safe route",
    (enabled) => {
      const { sourcePath, outputPath } = createWranglerFixture();
      const config = prepareWranglerDeployConfig({
        sourcePath,
        outputPath,
        runtimeStateSnapshotKvId: kvId,
        runtimeStateSnapshotKvPreviewId: kvPreviewId,
        panelHostingMode: "custom",
        customWorkersDevEnabled: enabled,
      });

      expect(config.workers_dev).toBe(enabled);
      expect(
        buildWranglerDeployArgs({
          configPath: outputPath,
          workerName,
          panelHostingMode: "custom",
          customHostname: "panel.example.com",
        })
      ).toEqual(["deploy", "--config", outputPath, "--name", workerName, "--route", "panel.example.com/*"]);
    }
  );

  it("rejects a custom deploy without a valid route hostname", () => {
    expect(() =>
      buildWranglerDeployArgs({
        configPath: "wrangler.deploy.jsonc",
        workerName,
        panelHostingMode: "custom",
        customHostname: "panel.example.com/unsafe",
      })
    ).toThrow("valid custom panel hostname");
  });
});

describe("panel hosting environment validation", () => {
  it("requires the derived Workers URL", () => {
    expect(
      validatePanelHostingEnvironment(
        {
          PANEL_HOSTING_MODE: "workers_dev",
          CLOUDFLARE_WORKERS_SUBDOMAIN: "account.workers.dev",
          NEXT_PUBLIC_APP_URL: "https://mc-aws-panel.account.workers.dev",
        },
        workerName
      )
    ).toEqual({
      mode: "workers_dev",
      appUrl: "https://mc-aws-panel.account.workers.dev",
      workersDevEnabled: true,
    });
  });

  it("requires custom panel DNS credentials and an explicit workers.dev decision", () => {
    expect(() =>
      validatePanelHostingEnvironment(
        {
          PANEL_HOSTING_MODE: "custom",
          NEXT_PUBLIC_APP_URL: "https://panel.example.com",
        },
        workerName
      )
    ).toThrow("requires CLOUDFLARE_PANEL_ZONE_ID");

    expect(() =>
      validatePanelHostingEnvironment(
        {
          PANEL_HOSTING_MODE: "custom",
          NEXT_PUBLIC_APP_URL: "https://panel.example.com",
          CLOUDFLARE_PANEL_ZONE_ID: "0123456789abcdef0123456789abcdef",
          CLOUDFLARE_PANEL_DNS_API_TOKEN: "token",
        },
        workerName
      )
    ).toThrow("PANEL_WORKERS_DEV_ENABLED");
  });
});
