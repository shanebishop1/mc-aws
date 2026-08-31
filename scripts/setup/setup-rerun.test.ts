import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type MinecraftMode = "cloudflare" | "duckdns" | "raw_ip";
type PanelMode = "workers_dev" | "custom";

const rootDir = path.resolve(process.cwd());
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MC_AWS_SETUP_LIBRARY_ONLY: "1",
  AWS_REGION: "us-east-1",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  ADMIN_EMAIL: "admin@example.com",
  CLOUDFLARE_DNS_API_TOKEN: "",
  CLOUDFLARE_ZONE_ID: "",
  CLOUDFLARE_RECORD_ID: "",
  CLOUDFLARE_MC_DOMAIN: "",
  DUCKDNS_DOMAIN: "",
  DUCKDNS_TOKEN: "",
  CLOUDFLARE_WORKERS_SUBDOMAIN: "",
  CLOUDFLARE_PANEL_DNS_API_TOKEN: "",
  CLOUDFLARE_PANEL_ZONE_ID: "",
  PANEL_DNS_MANAGEMENT: "",
  PANEL_WORKERS_DEV_ENABLED: "",
};

const modeEnv = (minecraftMode: MinecraftMode, panelMode: PanelMode): NodeJS.ProcessEnv => {
  const values: NodeJS.ProcessEnv = {
    ...baseEnv,
    MC_CONNECTION_MODE: minecraftMode,
    PANEL_HOSTING_MODE: panelMode,
  };

  if (minecraftMode === "cloudflare") {
    values.CLOUDFLARE_DNS_API_TOKEN = "minecraft-dns-token";
    values.CLOUDFLARE_ZONE_ID = "minecraft-zone-id";
    values.CLOUDFLARE_MC_DOMAIN = "mc.example.com";
  } else if (minecraftMode === "duckdns") {
    values.DUCKDNS_DOMAIN = "myserver";
    values.DUCKDNS_TOKEN = "duck-token";
  }

  if (panelMode === "workers_dev") {
    values.CLOUDFLARE_WORKERS_SUBDOMAIN = "account.workers.dev";
    values.NEXT_PUBLIC_APP_URL = "https://mc-aws-panel.account.workers.dev";
  } else {
    values.CLOUDFLARE_PANEL_DNS_API_TOKEN = "panel-dns-token";
    values.CLOUDFLARE_PANEL_ZONE_ID = "panel-zone-id";
    values.PANEL_WORKERS_DEV_ENABLED = "false";
    values.NEXT_PUBLIC_APP_URL = "https://panel.example.com";
  }

  return values;
};

const runSetupFunction = (functionCall: string, env: NodeJS.ProcessEnv): string =>
  execFileSync("bash", ["-c", `source ./setup.sh; ${functionCall}`], {
    cwd: rootDir,
    env,
    encoding: "utf8",
  }).trim();

describe("setup rerun mode detection", () => {
  it.each([
    ["cloudflare", "workers_dev"],
    ["cloudflare", "custom"],
    ["duckdns", "workers_dev"],
    ["duckdns", "custom"],
    ["raw_ip", "workers_dev"],
    ["raw_ip", "custom"],
  ] satisfies Array<[MinecraftMode, PanelMode]>)(
    "accepts Minecraft %s crossed with panel %s",
    (minecraftMode, panelMode) => {
      expect(runSetupFunction("get_missing_required_credentials", modeEnv(minecraftMode, panelMode))).toBe("");
    }
  );

  it("does not require Cloudflare Minecraft values or a record ID for DuckDNS reruns", () => {
    const env = modeEnv("duckdns", "workers_dev");
    env.MC_CONNECTION_MODE = "";
    expect(runSetupFunction("get_missing_required_credentials", env)).toBe("");
  });

  it("infers legacy Cloudflare Minecraft reruns without requiring the unused record ID", () => {
    const env = modeEnv("cloudflare", "workers_dev");
    env.MC_CONNECTION_MODE = "";
    env.CLOUDFLARE_RECORD_ID = "";
    expect(runSetupFunction("get_missing_required_credentials", env)).toBe("");
    expect(runSetupFunction("minecraft_connection_target", env)).toBe("mc.example.com");
  });

  it("does not require any Minecraft DNS credentials for raw-IP reruns", () => {
    const env = modeEnv("raw_ip", "workers_dev");
    env.MC_CONNECTION_MODE = "";
    expect(runSetupFunction("get_missing_required_credentials", env)).toBe("");
  });

  it("reports mode-specific missing values", () => {
    const duckDnsEnv = modeEnv("duckdns", "workers_dev");
    duckDnsEnv.DUCKDNS_TOKEN = "";
    expect(runSetupFunction("get_missing_required_credentials", duckDnsEnv)).toBe("DUCKDNS_TOKEN");

    const customPanelEnv = modeEnv("raw_ip", "custom");
    customPanelEnv.CLOUDFLARE_PANEL_ZONE_ID = "";
    expect(runSetupFunction("get_missing_required_credentials", customPanelEnv)).toBe("CLOUDFLARE_PANEL_ZONE_ID");
  });

  it("allows external custom panel DNS without a persisted panel token", () => {
    const env = modeEnv("raw_ip", "custom");
    env.PANEL_DNS_MANAGEMENT = "external";
    env.CLOUDFLARE_PANEL_DNS_API_TOKEN = "";

    expect(runSetupFunction("get_missing_required_credentials", env)).toBe("");
  });

  it("rejects invalid explicit mode names", () => {
    const invalidMinecraft = modeEnv("raw_ip", "workers_dev");
    invalidMinecraft.MC_CONNECTION_MODE = "none";
    expect(runSetupFunction("get_missing_required_credentials", invalidMinecraft)).toBe("MC_CONNECTION_MODE");

    const invalidPanel = modeEnv("raw_ip", "workers_dev");
    invalidPanel.PANEL_HOSTING_MODE = "workers";
    expect(runSetupFunction("get_missing_required_credentials", invalidPanel)).toBe("PANEL_HOSTING_MODE");
  });
});

describe("setup completion connection output", () => {
  it.each([
    ["cloudflare", "mc.example.com"],
    ["duckdns", "myserver.duckdns.org"],
    ["raw_ip", "the public IP shown in the control panel"],
  ] satisfies Array<[MinecraftMode, string]>)("prints the correct target for %s", (minecraftMode, expected) => {
    expect(runSetupFunction("minecraft_connection_target", modeEnv(minecraftMode, "workers_dev"))).toBe(expected);
  });
});

describe("setup immutable AMI integration", () => {
  it("invokes the pinning command with both reusable deployment env files", () => {
    const source = readFileSync(path.join(rootDir, "setup.sh"), "utf8");
    expect(source).toContain("scripts/setup/pin-al2023-ami.ts ensure");
    expect(source).toContain('--env-file "$PRODUCTION_ENV_FILE"');
    expect(source).toContain('--env-file "$LOCAL_ENV_FILE"');
    expect(source.indexOf("ensure_al2023_ami_pin")).toBeLessThan(
      source.indexOf("scripts/aws/migrate-existing-deployment.ts")
    );
  });

  it("persists both dual-v1 table outputs before any Worker deployment", () => {
    const source = readFileSync(path.join(rootDir, "setup.sh"), "utf8");
    const captureLock = source.indexOf("LifecycleLockTableName");
    const captureOperations = source.indexOf("OperationStateTableName");
    const writeLock = source.indexOf('write_env_files "MC_LIFECYCLE_LOCK_TABLE_NAME"');
    const writeOperations = source.indexOf('write_env_files "MC_OPERATION_STATE_TABLE_NAME"');
    const workerDeploy = source.indexOf("pnpm deploy:cf");
    expect(captureLock).toBeGreaterThan(-1);
    expect(captureOperations).toBeGreaterThan(-1);
    expect(writeLock).toBeGreaterThan(captureLock);
    expect(writeOperations).toBeGreaterThan(captureOperations);
    expect(writeLock).toBeLessThan(workerDeploy);
    expect(writeOperations).toBeLessThan(workerDeploy);
  });
});
