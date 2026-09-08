import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  it.each([
    ["absent", 0, "absent"],
    ["preexisting", 0, "existing"],
    ["AccessDenied", 1, ""],
    ["ThrottlingException", 1, ""],
    ["TimeoutError", 1, ""],
    ["ParameterNotFoundish", 1, ""],
    ["empty", 1, ""],
  ])("treats only exact SSM absence as absent (%s)", (mode, expectedStatus, expectedState) => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-ssm-probe-"));
    const aws = path.join(directory, "aws");
    writeFileSync(
      aws,
      `#!/usr/bin/env bash
if [[ "${mode}" == "absent" ]]; then printf '%s' 'ParameterNotFound: exact parameter is absent' >&2; exit 1; fi
if [[ "${mode}" == "preexisting" ]]; then printf '%s' 'SecureString'; exit 0; fi
if [[ "${mode}" == "empty" ]]; then exit 0; fi
printf '%s' '${mode}: probe failed' >&2; exit 1
`,
      { mode: 0o700 }
    );
    chmodSync(aws, 0o700);
    try {
      const result = spawnSync("bash", ["-c", "source ./setup.sh; probe_ssm_parameter /minecraft/gdrive-token"], {
        cwd: rootDir,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MC_AWS_SETUP_LIBRARY_ONLY: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(expectedStatus);
      if (expectedState) expect(result.stdout.trim()).toContain(expectedState);
      else expect(result.stdout).not.toMatch(/\tabsent\t/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
    const sesPreflight = setupSource.indexOf("scripts/setup/ses-preflight.ts", awsIdentity);

    expect(envReload).toBeGreaterThan(-1);
    expect(awsIdentity).toBeGreaterThan(envReload);
    expect(sesPreflight).toBeGreaterThan(awsIdentity);
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("ensure_al2023_ami_pin", sesPreflight));
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("scripts/aws/migrate-existing-deployment.ts", sesPreflight));
    expect(sesPreflight).toBeLessThan(
      setupSource.indexOf("scripts/shared/deployment-manifest.mjs aws-init", sesPreflight)
    );
    expect(sesPreflight).toBeLessThan(setupSource.indexOf("pnpm exec cdk deploy", sesPreflight));
  });

  it("records SSM ownership observations before CDK can mutate parameters", () => {
    const probes = setupSource.indexOf("Completed fail-closed pre-deployment SSM ownership probes");
    const ownershipInventory = setupSource.indexOf("Recorded pre-deployment SSM ownership facts");
    const deploy = setupSource.indexOf("pnpm exec cdk deploy", ownershipInventory);
    expect(probes).toBeGreaterThan(-1);
    expect(probes).toBeLessThan(setupSource.indexOf("scripts/shared/deployment-manifest.mjs aws-init"));
    expect(ownershipInventory).toBeGreaterThan(setupSource.indexOf("scripts/shared/deployment-manifest.mjs aws-init"));
    expect(deploy).toBeGreaterThan(ownershipInventory);
    expect(setupSource).toContain("scripts/shared/deployment-manifest.mjs ssm-stack-resource");
  });

  it("pins the bootstrapped executor receipt verifier before Worker deployment", () => {
    const discovery = setupSource.indexOf('step "Pinning executor terminal receipt verifier"');
    const manifestPin = setupSource.indexOf("executor-receipt --key-id", discovery);
    const envPin = setupSource.indexOf('write_env_files "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS"', manifestPin);
    const workerDeploy = setupSource.indexOf("run_with_mise pnpm deploy:cf", envPin);

    expect(discovery).toBeGreaterThan(setupSource.indexOf("scripts/shared/deployment-manifest.mjs aws-deployed"));
    expect(manifestPin).toBeGreaterThan(discovery);
    expect(envPin).toBeGreaterThan(manifestPin);
    expect(workerDeploy).toBeGreaterThan(envPin);
  });

  it("guards and confirms before DNS mutation and never forwards removed token parameters", () => {
    const guard = setupSource.indexOf("--assert-standard-deploy-safe");
    const confirmation = setupSource.indexOf("print_deployment_preflight", guard);
    const materialize = setupSource.indexOf("scripts/setup/materialize-dns-secrets.ts", confirmation);
    const deploy = setupSource.indexOf("pnpm exec cdk deploy", materialize);

    expect(guard).toBeGreaterThan(-1);
    expect(confirmation).toBeGreaterThan(guard);
    expect(materialize).toBeGreaterThan(confirmation);
    expect(deploy).toBeGreaterThan(materialize);
    expect(setupSource).not.toContain("CloudflareTokenParam");
    expect(setupSource).not.toContain("DuckDnsTokenParam");
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
