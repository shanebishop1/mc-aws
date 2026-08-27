import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();
const setupPath = path.join(rootDir, "setup.sh");
const setupSource = readFileSync(setupPath, "utf8");
const command = `source "${setupPath}"; CDK_DEFAULT_ACCOUNT=123456789012; CDK_DEFAULT_REGION=us-east-1; STACK_NAME=MinecraftStack; print_deployment_preflight`;

function runPreflight(confirm?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MC_AWS_SETUP_LIBRARY_ONLY: "1" };

  return spawnSync("bash", ["-c", command], {
    cwd: rootDir,
    env,
    encoding: "utf8",
    input: confirm ? `${confirm}\n` : undefined,
  });
}

describe("public setup deployment preflight", () => {
  it("validates the server profile before AWS inspection or deployment state mutation", () => {
    expect(setupSource.indexOf("run_with_mise pnpm profile:validate")).toBeLessThan(
      setupSource.indexOf("aws cloudformation describe-stacks")
    );
    expect(setupSource.indexOf("run_with_mise pnpm profile:init")).toBeLessThan(
      setupSource.indexOf("Starting interactive setup wizard")
    );
  });

  it("runs the read-only SES preflight after AWS identity and before deployment mutations", () => {
    const envReload = setupSource.indexOf(
      'load_env_file "$PRODUCTION_ENV_FILE" || true',
      setupSource.indexOf("# Reload env")
    );
    const awsIdentity = setupSource.indexOf("if ! ensure_cdk_defaults", envReload);
    const sesPreflight = setupSource.indexOf("scripts/ses-preflight.ts", awsIdentity);

    expect(envReload).toBeGreaterThan(-1);
    expect(awsIdentity).toBeGreaterThan(envReload);
    expect(sesPreflight).toBeGreaterThan(awsIdentity);
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("ensure_al2023_ami_pin", sesPreflight));
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("migrate-existing-deployment.ts", sesPreflight));
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("deployment-manifest.mjs aws-init", sesPreflight));
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("pnpm exec cdk deploy", sesPreflight));
  });

  it("refuses a non-interactive deployment without explicit confirmation", () => {
    const result = runPreflight();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("AWS account: 123456789012");
    expect(result.stdout).toContain("AWS region:  us-east-1");
    expect(result.stdout).toContain("t4g.medium");
    expect(result.stdout).toContain("pnpm destroy:execute");
    expect(result.stdout).toContain("Deployment cancelled");
  });

  it("accepts an explicit DEPLOY confirmation", () => {
    const result = runPreflight("DEPLOY");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Estimated recurring cost (not a quote)");
    expect(result.stdout).toContain("Deployment explicitly confirmed");
  });
});
