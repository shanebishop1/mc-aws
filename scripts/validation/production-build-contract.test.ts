import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_BUILD_AUTH_SECRET_CANARY,
  PRODUCTION_BUILD_MOCK_CANARIES,
  assertProductionBuildArtifacts,
  productionBuildEnvironment,
  seedProductionBuildCanaryDotenv,
  seedProductionBuildMockState,
} from "./production-build-contract";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function buildRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-aws-production-build-contract-"));
  roots.push(root);
  mkdirSync(path.join(root, ".next/standalone/server"), { recursive: true });
  mkdirSync(path.join(root, ".open-next"), { recursive: true });
  writeFileSync(path.join(root, ".next/BUILD_ID"), "clean-build");
  writeFileSync(path.join(root, ".next/standalone/server/index.js"), "export const server = true;\n");
  writeFileSync(path.join(root, ".next/server.nft.json"), '{"files":["server/index.js"]}\n');
  writeFileSync(path.join(root, ".open-next/worker.js"), "export default {};\n");
  return root;
}

describe("production build mock-state contract", () => {
  it("deletes inherited credentials before constructing the build environment", () => {
    const root = buildRoot();
    const environment = productionBuildEnvironment(root, {
      NODE_ENV: "test",
      AUTH_SECRET: "auth-secret-canary",
      ADMIN_EMAIL: "operator@example.com",
      AWS_ACCESS_KEY_ID: "aws-access-key-canary",
      AWS_SECRET_ACCESS_KEY: "aws-secret-key-canary",
      AWS_SESSION_TOKEN: "aws-session-canary",
      GOOGLE_CLIENT_SECRET: "google-client-canary",
      CLOUDFLARE_DNS_API_TOKEN: "dns-token-canary",
      CLOUDFLARE_API_TOKEN: "cloudflare-token-canary",
      CLOUDFLARE_DEPLOY_API_TOKEN: "deploy-token-canary",
      CLOUDFLARE_PANEL_DNS_API_TOKEN: "panel-token-canary",
      MC_AGENT_RUNTIME_TOKEN: "runtime-token-canary",
      MC_AGENT_RUNTIME_TOKEN_SHA256: "runtime-hash-canary",
      MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8: "backup-key-canary",
      GITHUB_TOKEN: "github-token-canary",
    });

    expect(environment.AUTH_SECRET).toBeUndefined();
    expect(environment.ADMIN_EMAIL).toBe("ci@example.invalid");
    expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.AWS_SESSION_TOKEN).toBeUndefined();
    expect(environment.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(environment.CLOUDFLARE_DNS_API_TOKEN).toBeUndefined();
    expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(environment.CLOUDFLARE_DEPLOY_API_TOKEN).toBeUndefined();
    expect(environment.CLOUDFLARE_PANEL_DNS_API_TOKEN).toBeUndefined();
    expect(environment.MC_AGENT_RUNTIME_TOKEN).toBeUndefined();
    expect(environment.MC_AGENT_RUNTIME_TOKEN_SHA256).toBeUndefined();
    expect(environment.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.MC_BACKEND_MODE).toBe("aws");
    expect(environment.MC_MOCK_STATE_PATH).toBe(
      path.join(root, ".local-artifacts/production-build-contract/mock-state.json")
    );
  });

  it("seeds the canary only under excluded local artifacts", () => {
    const root = buildRoot();
    const canaryPath = seedProductionBuildMockState(root);

    expect(canaryPath).toBe(path.join(root, ".local-artifacts/production-build-contract/mock-state.json"));
    expect(existsSync(canaryPath)).toBe(true);
    expect(() => assertProductionBuildArtifacts(root)).not.toThrow();
  });

  it("seeds the canonical auth canary in a hidden dotenv candidate", () => {
    const root = buildRoot();
    const dotenvPath = seedProductionBuildCanaryDotenv(root);

    if (!dotenvPath) throw new Error("expected a new dotenv canary");
    expect(dotenvPath).toBe(path.join(root, ".env.production.local"));
    expect(readFileSync(dotenvPath, "utf8")).toBe(`AUTH_SECRET=${PRODUCTION_BUILD_AUTH_SECRET_CANARY}\n`);
  });

  it("fails when a canary is copied into a standalone or NFT output", () => {
    const root = buildRoot();
    seedProductionBuildMockState(root);
    writeFileSync(path.join(root, ".next/standalone/server/leak.js"), PRODUCTION_BUILD_MOCK_CANARIES[0]);

    expect(() => assertProductionBuildArtifacts(root)).toThrow("Deploy artifact scan found forbidden secret material");
  });
});
