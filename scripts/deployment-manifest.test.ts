import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(process.cwd());
const script = path.join(rootDir, "scripts/deployment-manifest.mjs");
const directories: string[] = [];
const account = "123456789012";
const region = "us-east-1";
const stack = "MinecraftStack";
const stackId = `arn:aws:cloudformation:${region}:${account}:stack/${stack}/stack-id`;
const cfAccount = "a".repeat(32);
const deploymentId = "11111111-2222-4333-8444-555555555555";

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-manifest-"));
  directories.push(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const run = (args: string[]) =>
    spawnSync("node", [script, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, MC_AWS_DEPLOYMENT_MANIFEST: manifestPath },
    });
  return {
    manifestPath,
    run,
    read: () => JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("deployment ownership manifest transitions", () => {
  it("refuses to adopt a same-name existing stack without immutable prior identity", () => {
    const test = harness();
    const result = test.run([
      "aws-init",
      "--account",
      account,
      "--region",
      region,
      "--stack",
      stack,
      "--stack-state",
      "existing",
      "--stack-id",
      stackId,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("same-name stack");
  });

  it("retains stack ownership only for the exact prior StackId", () => {
    const test = harness();
    expect(
      test.run([
        "aws-init",
        "--account",
        account,
        "--region",
        region,
        "--stack",
        stack,
        "--stack-state",
        "absent",
        "--stack-id",
        "unknown",
      ]).status
    ).toBe(0);
    expect(
      test.run([
        "aws-deployed",
        "--stack-id",
        stackId,
        "--instance-id",
        `i-${"1".repeat(17)}`,
        "--runtime-user",
        "mc-aws-runtime-user",
      ]).status
    ).toBe(0);
    expect(
      test.run([
        "aws-init",
        "--account",
        account,
        "--region",
        region,
        "--stack",
        stack,
        "--stack-state",
        "existing",
        "--stack-id",
        stackId,
      ]).status
    ).toBe(0);
    const replacement = test.run([
      "aws-init",
      "--account",
      account,
      "--region",
      region,
      "--stack",
      stack,
      "--stack-state",
      "existing",
      "--stack-id",
      stackId.replace("stack-id", "replacement-id"),
    ]);
    expect(replacement.status).not.toBe(0);
  });

  it("refuses a pre-existing Worker unless its provider deployment ID matches", () => {
    const test = harness();
    const initialize = test.run([
      "cloudflare-init",
      "--account",
      cfAccount,
      "--worker",
      "mc-aws-panel",
      "--worker-state",
      "existing",
      "--live-deployment",
      deploymentId,
      "--mode",
      "workers_dev",
      "--workers-dev",
      "true",
    ]);
    expect(initialize.status).not.toBe(0);
    expect(initialize.stderr).toContain("refusing to overwrite code or secrets");

    expect(
      test.run([
        "cloudflare-init",
        "--account",
        cfAccount,
        "--worker",
        "mc-aws-panel",
        "--worker-state",
        "absent",
        "--live-deployment",
        "none",
        "--mode",
        "workers_dev",
        "--workers-dev",
        "true",
      ]).status
    ).toBe(0);
    expect(test.run(["cloudflare-deployed", "--deployment-id", deploymentId]).status).toBe(0);
    expect(
      test.run([
        "cloudflare-init",
        "--account",
        cfAccount,
        "--worker",
        "mc-aws-panel",
        "--worker-state",
        "existing",
        "--live-deployment",
        deploymentId,
        "--mode",
        "workers_dev",
        "--workers-dev",
        "true",
      ]).status
    ).toBe(0);
  });

  it("rejects same-pattern route ID replacement instead of inheriting ownership", () => {
    const test = harness();
    expect(
      test.run([
        "route",
        "--zone",
        "a".repeat(32),
        "--id",
        "b".repeat(32),
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--ownership",
        "created",
      ]).status
    ).toBe(0);
    const replaced = test.run([
      "route",
      "--zone",
      "a".repeat(32),
      "--id",
      "c".repeat(32),
      "--pattern",
      "panel.example.com/*",
      "--script",
      "mc-aws-panel",
      "--ownership",
      "preexisting",
      "--original-script",
      "old-worker",
    ]);
    expect(replaced.status).not.toBe(0);
    expect(replaced.stderr).toContain("route identity changed");

    const preexisting = harness();
    expect(
      preexisting.run([
        "route",
        "--zone",
        "a".repeat(32),
        "--id",
        "b".repeat(32),
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--ownership",
        "preexisting",
        "--original-script",
        "old-worker",
      ]).status
    ).toBe(0);
    expect(
      preexisting.run([
        "route",
        "--zone",
        "a".repeat(32),
        "--id",
        "c".repeat(32),
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--ownership",
        "preexisting",
        "--original-script",
        "old-worker",
      ]).status
    ).not.toBe(0);
  });

  it("writes mode 0600 and rejects subsequent wrong-mode tampering", () => {
    const test = harness();
    expect(
      test.run([
        "aws-init",
        "--account",
        account,
        "--region",
        region,
        "--stack",
        stack,
        "--stack-state",
        "absent",
        "--stack-id",
        "unknown",
      ]).status
    ).toBe(0);
    chmodSync(test.manifestPath, 0o644);
    expect(test.run(["validate"]).status).not.toBe(0);
    expect(test.read().project).toBe("mc-aws");
  });

  it("rejects malformed provider IDs and unknown fields", () => {
    const test = harness();
    writeFileSync(
      test.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        project: "mc-aws",
        aws: { accountId: "not-an-account", dlmPolicies: [] },
        cloudflare: { routes: [], kvNamespaces: [], panelDnsRecords: [] },
        teardown: { completedResources: [] },
        unknownOwnershipOverride: true,
      }),
      { mode: 0o600 }
    );
    chmodSync(test.manifestPath, 0o600);
    const result = test.run(["validate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a recognized|malformed/);
  });
});
