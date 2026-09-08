import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanDeploymentArtifacts } from "../cloudflare/deploy-env";
import { isolatedBuildEnvironment, spawnIsolatedBuildChild } from "./build-child-isolation";
import { withNextBuildIsolation } from "./next-build-isolation";

export const PRODUCTION_BUILD_AUTH_SECRET_CANARY = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";

export const PRODUCTION_BUILD_MOCK_CANARIES = [
  "mc-aws-production-build-mock-securestring-canary-7d5b",
  "mc-aws-production-build-oauth-client-secret-canary-9a31",
  "mc-aws-production-build-oauth-refresh-token-canary-2f84",
] as const;

export const PRODUCTION_BUILD_ENV_DELETED_NAMES = [
  "AUTH_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "CLOUDFLARE_DNS_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DEPLOY_API_TOKEN",
  "CLOUDFLARE_PANEL_DNS_API_TOKEN",
  "MC_AGENT_RUNTIME_TOKEN",
  "MC_AGENT_RUNTIME_TOKEN_SHA256",
  "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
  "GITHUB_TOKEN",
] as const;

const CANARY_RELATIVE_PATH = ".local-artifacts/production-build-contract/mock-state.json";

export function seedProductionBuildMockState(root: string): string {
  const statePath = path.join(root, CANARY_RELATIVE_PATH);
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        ssm: {
          parameters: {
            "/mock/oauth-credentials": {
              type: "SecureString",
              value: PRODUCTION_BUILD_MOCK_CANARIES[0],
            },
          },
        },
        oauth: {
          client_secret: PRODUCTION_BUILD_MOCK_CANARIES[1],
          refresh_token: PRODUCTION_BUILD_MOCK_CANARIES[2],
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return statePath;
}

/** Seed a real Next dotenv candidate so the isolation contract proves it is hidden. */
export function seedProductionBuildCanaryDotenv(root: string): string | undefined {
  const dotenvPath = path.join(root, ".env.production.local");
  if (existsSync(dotenvPath)) return undefined;
  writeFileSync(dotenvPath, `AUTH_SECRET=${PRODUCTION_BUILD_AUTH_SECRET_CANARY}\n`, { mode: 0o600 });
  return dotenvPath;
}

export function productionBuildArtifactRoots(root: string): string[] {
  // `.next/cache` contains webpack's non-deployable binary cache and can retain
  // source/build-input strings. Scan every other Next output entry explicitly,
  // including root-level NFT manifests, plus the OpenNext output.
  const nextRoot = path.join(root, ".next");
  const nextOutputs = existsSync(nextRoot)
    ? readdirSync(nextRoot)
        .filter((entry) => entry !== "cache")
        .map((entry) => path.join(nextRoot, entry))
    : [];
  return [...nextOutputs, path.join(root, ".open-next")].filter(
    (artifactPath, index, all) => existsSync(artifactPath) && all.indexOf(artifactPath) === index
  );
}

export function assertProductionBuildArtifacts(
  root: string,
  canaries: readonly string[] = [...PRODUCTION_BUILD_MOCK_CANARIES, PRODUCTION_BUILD_AUTH_SECRET_CANARY]
): void {
  const artifactRoots = productionBuildArtifactRoots(root);
  if (!existsSync(path.join(root, ".next"))) {
    throw new Error("Production build contract failed: .next output is missing.");
  }
  scanDeploymentArtifacts(artifactRoots, canaries);
}

export function productionBuildEnvironment(
  root: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const overrides = productionBuildOverrides(root);
  return isolatedBuildEnvironment(root, {
    home: path.join(root, ".local-artifacts/production-build-contract/home"),
    tmpdir: path.join(root, ".local-artifacts/production-build-contract/tmp"),
    sourceEnvironment: { ...sourceEnvironment, PATH: sourceEnvironment.PATH ?? process.env.PATH },
    overrides,
  });
}

const productionBuildOverrides = (root: string): Record<string, string> => ({
  NODE_ENV: "production",
  MC_BACKEND_MODE: "aws",
  MC_MOCK_STATE_PATH: path.join(root, CANARY_RELATIVE_PATH),
  ENABLE_DEV_LOGIN: "",
  MC_AGENT_RUNTIME_ENABLED: "false",
  ADMIN_EMAIL: "ci@example.invalid",
  GOOGLE_CLIENT_ID: "ci-client-id",
  NEXT_PUBLIC_APP_URL: "https://ci.example.invalid",
  MC_LIFECYCLE_LOCK_TABLE_NAME: "ci-lifecycle-lock-table",
  MC_OPERATION_STATE_TABLE_NAME: "ci-operation-state-table",
});

export function runProductionBuildContract(root = process.cwd()): void {
  const canaryPath = seedProductionBuildMockState(root);
  const dotenvCanaryPath = seedProductionBuildCanaryDotenv(root);
  try {
    const result = withNextBuildIsolation(root, { sourceEnvironmentFile: ".env.production.local" }, () =>
      spawnIsolatedBuildChild("pnpm", ["build"], root, {
        cwd: root,
        home: path.join(root, ".local-artifacts/production-build-contract/home"),
        tmpdir: path.join(root, ".local-artifacts/production-build-contract/tmp"),
        overrides: productionBuildOverrides(root),
      })
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Production build failed with exit code ${String(result.status)}.`);
    assertProductionBuildArtifacts(root);
    console.log(
      "[BUILD-CONTRACT] Mock SecureString/OAuth canaries are absent from Next/OpenNext output and NFT manifests."
    );
  } finally {
    rmSync(path.dirname(canaryPath), { recursive: true, force: true });
    if (dotenvCanaryPath) rmSync(dotenvCanaryPath, { force: true });
  }
}

if (process.argv[1]?.endsWith("production-build-contract.ts")) {
  try {
    runProductionBuildContract();
  } catch (error) {
    console.error(`[BUILD-CONTRACT] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
