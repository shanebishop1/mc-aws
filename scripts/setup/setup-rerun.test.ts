import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  AUTH_SECRET: Buffer.from([
    0xd3, 0x1a, 0xf7, 0x0c, 0x5e, 0x92, 0xb8, 0x4f, 0x01, 0x69, 0xc4, 0xe7, 0xab, 0x2d, 0x53, 0x81, 0xf6, 0xa0, 0xce,
    0x9d, 0x34, 0x78, 0xb2, 0x15, 0xc7, 0xe3, 0xf9, 0x02, 0x6d, 0x4a, 0xb1, 0xe8, 0xf0, 0xc5, 0xa7, 0xd2, 0xe9, 0xb3,
    0x14, 0x68, 0x9f, 0x03, 0xdc, 0x76, 0x2a, 0xe1, 0x58, 0xc0,
  ]).toString("base64url"),
  MC_AWS_ROTATE_AUTH_SECRET: "",
  MC_AGENT_RUNTIME_ENABLED: "false",
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

const authEnvironment = (directory: string, AUTH_SECRET: string): NodeJS.ProcessEnv => ({
  ...baseEnv,
  AUTH_SECRET,
  TEST_PRODUCTION_ENV: path.join(directory, ".env.production"),
  TEST_LOCAL_ENV: path.join(directory, ".env.local"),
});

const runAuthSetupFunction = (functionCall: string, env: NodeJS.ProcessEnv): string =>
  runSetupFunction(
    `PRODUCTION_ENV_FILE="$TEST_PRODUCTION_ENV"; LOCAL_ENV_FILE="$TEST_LOCAL_ENV"; ${functionCall}`,
    env
  );

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

describe("setup AUTH_SECRET rotation", () => {
  it("accepts an existing production-safe value but rejects a weak non-placeholder value", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-auth-secret-"));
    try {
      expect(
        runAuthSetupFunction(
          "ensure_auth_secret; printf accepted",
          authEnvironment(directory, baseEnv.AUTH_SECRET as string)
        )
      ).toBe("accepted");

      expect(
        runAuthSetupFunction(
          "if ensure_auth_secret; then printf accepted; else printf rotation-required; fi",
          authEnvironment(directory, "weak-existing-value-that-is-not-a-placeholder")
        )
      ).toBe("rotation-required");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an explicit flag to generate a safe rotation and never prints the secret", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-auth-secret-"));
    const productionEnv = path.join(directory, ".env.production");
    const localEnv = path.join(directory, ".env.local");
    try {
      const output = runAuthSetupFunction("ensure_auth_secret; printf rotated", {
        ...authEnvironment(directory, "weak-existing-value-that-is-not-a-placeholder"),
        MC_AWS_ROTATE_AUTH_SECRET: "1",
      });
      const generated = readFileSync(productionEnv, "utf8").trim().replace("AUTH_SECRET=", "");
      expect(output).toBe("rotated");
      expect(output).not.toContain(generated);
      expect(generated).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(readFileSync(localEnv, "utf8")).toContain("AUTH_SECRET=");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit rotation for every formerly accepted noncanonical form", () => {
    for (const AUTH_SECRET of [
      "8f2a7c91d4e6b3085a1f9c72e4d6a8037b5c1e94f2a860d3c7e59b14a826f0d9",
      Buffer.from("machine-looking-but-human-auth-secret-material").toString("base64"),
      "vQ7!mZ2@pL9#xR4$kT8%wN3^cF6&hJ1*eD5-sA0_gY",
    ]) {
      const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-auth-secret-"));
      try {
        expect(
          runAuthSetupFunction(
            "if ensure_auth_secret; then printf accepted; else printf rotation-required; fi",
            authEnvironment(directory, AUTH_SECRET)
          )
        ).toBe("rotation-required");
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
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

  it("defers fresh-stack recovery-capsule adoption until operation-state outputs exist", () => {
    const source = readFileSync(path.join(rootDir, "setup.sh"), "utf8");
    const prepare = source.indexOf("prepare_backup_recovery_capsule_adoption");
    const deferred = source.indexOf("MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED", prepare);
    const deploy = source.indexOf("pnpm exec cdk deploy");
    const operationOutput = source.indexOf('write_env_files "MC_OPERATION_STATE_TABLE_NAME"', deploy);
    const postDeployAdoption = source.indexOf("export MC_AWS_FRESH_STACK=false");
    expect(prepare).toBeGreaterThan(-1);
    expect(deferred).toBeGreaterThan(prepare);
    expect(deploy).toBeGreaterThan(deferred);
    expect(operationOutput).toBeGreaterThan(deploy);
    expect(postDeployAdoption).toBeGreaterThan(operationOutput);
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
