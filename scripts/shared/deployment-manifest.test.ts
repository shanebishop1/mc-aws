import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(process.cwd());
const script = path.join(rootDir, "scripts/shared/deployment-manifest.mjs");
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
  it("records monotonic SSM pre-existing and installation-created ownership facts", () => {
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
      test.run(["ssm-observe", "--name", "/minecraft/gdrive-token", "--state", "absent", "--type", "unknown"]).status
    ).toBe(0);
    expect(
      test.run(["ssm-observe", "--name", "/minecraft/gdrive-token", "--state", "existing", "--type", "SecureString"])
        .status
    ).toBe(0);
    expect(
      test.run(["ssm-observe", "--name", "/minecraft/github-pat", "--state", "existing", "--type", "SecureString"])
        .status
    ).toBe(0);
    const records = (test.read().aws as { ssmParameters: Array<Record<string, unknown>> }).ssmParameters;
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "/minecraft/gdrive-token",
          ownership: "created",
          observedBeforeSetup: "absent",
        }),
        expect.objectContaining({
          name: "/minecraft/github-pat",
          ownership: "preexisting",
          observedBeforeSetup: "existing",
        }),
      ])
    );
    const override = test.run([
      "ssm-stack-resource",
      "--name",
      "/minecraft/github-pat",
      "--type",
      "SecureString",
      "--logical-id",
      "LegacyPat",
    ]);
    expect(override.status).toBe(0);
    const migrated = (test.read().aws as { ssmParameters: Array<Record<string, unknown>> }).ssmParameters;
    expect(migrated).toContainEqual(
      expect.objectContaining({ name: "/minecraft/github-pat", ownership: "created", source: "exact-stack-resource" })
    );
  });

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

  it("resets fully torn-down Cloudflare identities so one-shot rebuild can re-inventory them", () => {
    const test = harness();
    const runOk = (args: string[]) => expect(test.run(args).status).toBe(0);
    runOk([
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
    ]);
    runOk([
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
      "custom",
      "--workers-dev",
      "false",
    ]);
    runOk(["cloudflare-deployed", "--deployment-id", deploymentId]);
    runOk([
      "route",
      "--zone",
      "b".repeat(32),
      "--id",
      "c".repeat(32),
      "--pattern",
      "panel.example.com/*",
      "--script",
      "mc-aws-panel",
      "--ownership",
      "created",
    ]);
    runOk(["kv", "--binding", "OWNED_KV", "--id", "d".repeat(32), "--title", "owned-kv", "--ownership", "created"]);
    runOk([
      "kv",
      "--binding",
      "PRESERVED_KV",
      "--id",
      "e".repeat(32),
      "--title",
      "preserved-kv",
      "--ownership",
      "preexisting",
    ]);
    for (const resource of [
      "cloudflare-routes",
      "cloudflare-worker",
      "cloudflare-kv",
      "cloudflare-dns",
      "cloudformation-stack",
    ]) {
      runOk(["mark-complete", "--resource", resource]);
    }
    runOk([
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
    ]);

    const cloudflare = test.read().cloudflare as {
      routes: unknown[];
      panelDnsRecords: unknown[];
      kvNamespaces: Array<{ binding: string }>;
    };
    expect(cloudflare.routes).toEqual([]);
    expect(cloudflare.panelDnsRecords).toEqual([]);
    expect(cloudflare.kvNamespaces).toEqual([expect.objectContaining({ binding: "PRESERVED_KV" })]);
  });

  it("allows an exact proven preexisting-to-created route ID replacement", () => {
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
        "preexisting",
        "--original-script",
        "mc-aws-panel",
      ]).status
    ).toBe(0);
    expect(
      test.run([
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
        "created",
        "--replaces-id",
        "b".repeat(32),
      ]).status
    ).toBe(0);
    expect((test.read().cloudflare as { routes: Array<Record<string, unknown>> }).routes[0]).toMatchObject({
      id: "c".repeat(32),
      script: "mc-aws-panel",
      ownership: "created",
      ownershipProven: true,
      createdByProject: true,
      originalScript: "",
    });
  });

  it("allows an exact proven created-to-created route ID replacement", () => {
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
    expect(
      test.run([
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
        "created",
        "--replaces-id",
        "b".repeat(32),
      ]).status
    ).toBe(0);
  });

  it("restores route manifest identity to absent or a verified recreated immutable ID", () => {
    const test = harness();
    const zone = "a".repeat(32);
    const first = "b".repeat(32);
    const replacement = "c".repeat(32);
    const recreated = "d".repeat(32);
    expect(
      test.run([
        "route",
        "--zone",
        zone,
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--ownership",
        "created",
      ]).status
    ).toBe(0);
    expect(
      test.run([
        "route",
        "--zone",
        zone,
        "--id",
        first,
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--ownership",
        "created",
      ]).status
    ).toBe(0);
    expect(
      test.run([
        "route",
        "--zone",
        zone,
        "--id",
        replacement,
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--ownership",
        "created",
        "--replaces-id",
        first,
      ]).status
    ).toBe(0);
    expect(
      test.run([
        "route-recovered",
        "--zone",
        zone,
        "--pattern",
        "panel.example.com/*",
        "--script",
        "mc-aws-panel",
        "--baseline-state",
        "present",
        "--expected-current-id",
        replacement,
        "--restored-id",
        recreated,
      ]).status
    ).toBe(0);
    expect((test.read().cloudflare as { routes: Array<{ id: string }> }).routes[0].id).toBe(recreated);
  });

  it("rejects a replacement when --replaces-id does not match the manifest", () => {
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
    const result = test.run([
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
      "created",
      "--replaces-id",
      "d".repeat(32),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the manifest route ID");
  });

  it("rejects replacement when the route target differs", () => {
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
        "other-worker",
        "--ownership",
        "preexisting",
        "--original-script",
        "other-worker",
      ]).status
    ).toBe(0);
    const result = test.run([
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
      "created",
      "--replaces-id",
      "b".repeat(32),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("target does not match");
  });

  it("rejects replacement of an unproven route", () => {
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
        "unproven",
      ]).status
    ).toBe(0);
    const result = test.run([
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
      "created",
      "--replaces-id",
      "b".repeat(32),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unproven ownership");
  });

  it("preserves preexisting ownership when the exact route ID is stable", () => {
    const test = harness();
    const routeArgs = [
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
      "mc-aws-panel",
    ];
    expect(test.run(routeArgs).status).toBe(0);
    expect(test.run(routeArgs).status).toBe(0);
    expect((test.read().cloudflare as { routes: Array<Record<string, unknown>> }).routes[0]).toMatchObject({
      id: "b".repeat(32),
      ownership: "preexisting",
      ownershipProven: true,
      createdByProject: false,
    });
  });

  it("reports only an exact validated project-created live route as created", () => {
    const test = harness();
    const zone = "a".repeat(32);
    const id = "b".repeat(32);
    const pattern = "panel.example.com/*";
    expect(
      test.run([
        "route",
        "--zone",
        zone,
        "--id",
        id,
        "--pattern",
        pattern,
        "--script",
        "mc-aws-panel",
        "--ownership",
        "created",
      ]).status
    ).toBe(0);
    const exact = test.run([
      "route-state",
      "--zone",
      zone,
      "--id",
      id,
      "--pattern",
      pattern,
      "--script",
      "mc-aws-panel",
    ]);
    expect(exact.status).toBe(0);
    expect(exact.stdout.trim()).toBe("created");

    const mismatched = test.run([
      "route-state",
      "--zone",
      zone,
      "--id",
      "c".repeat(32),
      "--pattern",
      pattern,
      "--script",
      "mc-aws-panel",
    ]);
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain("manifest/live route mismatch");
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
