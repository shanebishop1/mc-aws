import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(process.cwd());
const temporaryDirectories: string[] = [];
const oldImageId = `ami-${"1".repeat(17)}`;
const latestImageId = `ami-${"2".repeat(17)}`;

function makeHarness(initialPin?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-ami-pin-"));
  temporaryDirectories.push(directory);
  const productionEnv = path.join(directory, ".env.production");
  const localEnv = path.join(directory, ".env.local");
  const statePath = path.join(directory, "state.json");
  const awsPath = path.join(directory, "aws");
  writeFileSync(statePath, JSON.stringify({ latestImageId }));
  for (const envFile of [productionEnv, localEnv]) {
    writeFileSync(envFile, initialPin ? `OTHER=value\nAL2023_ARM64_AMI_ID=${initialPin}\n` : "OTHER=value\n", {
      mode: 0o600,
    });
  }
  writeFileSync(
    awsPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
const args = process.argv.slice(2);
if (args.includes("get-parameter")) {
  process.stdout.write(JSON.stringify({ Parameter: { Value: state.latestImageId } }));
} else if (args.includes("describe-images")) {
  const start = args.indexOf("--image-ids") + 1;
  const ids = [];
  for (let i = start; i < args.length && !args[i].startsWith("--"); i += 1) ids.push(args[i]);
  process.stdout.write(JSON.stringify({ Images: ids.map((ImageId) => ({
    ImageId, Architecture: "arm64", State: "available", RootDeviceType: "ebs",
    VirtualizationType: "hvm", OwnerId: "137112412989", Name: "al2023-ami-2026.08.01-kernel-6.1-arm64"
  })) }));
} else process.exit(2);
`,
    { mode: 0o755 }
  );
  chmodSync(awsPath, 0o755);

  const run = (command: "ensure" | "upgrade", confirm?: string) =>
    spawnSync(
      path.join(rootDir, "node_modules/.bin/tsx"),
      [
        "scripts/pin-al2023-ami.ts",
        command,
        "--region",
        "us-west-1",
        "--env-file",
        productionEnv,
        "--env-file",
        localEnv,
        ...(confirm ? ["--confirm", confirm] : []),
      ],
      {
        cwd: rootDir,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AL2023_ARM64_AMI_ID: "" },
        encoding: "utf8",
      }
    );
  return { run, productionEnv, localEnv };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ARM64 AL2023 AMI pinning", () => {
  it("resolves and persists an exact fresh pin in both reusable env files", () => {
    const harness = makeHarness();
    const result = harness.run("ensure");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(latestImageId);
    expect(readFileSync(harness.productionEnv, "utf8")).toContain(`AL2023_ARM64_AMI_ID=${latestImageId}`);
    expect(readFileSync(harness.localEnv, "utf8")).toContain(`AL2023_ARM64_AMI_ID=${latestImageId}`);
  });

  it("preserves an existing valid pin until an explicit exact upgrade confirmation", () => {
    const harness = makeHarness(oldImageId);
    const ensure = harness.run("ensure");
    expect(ensure.status, ensure.stderr).toBe(0);
    expect(ensure.stdout.trim()).toBe(oldImageId);
    expect(readFileSync(harness.productionEnv, "utf8")).toContain(`AL2023_ARM64_AMI_ID=${oldImageId}`);

    const refused = harness.run("upgrade", oldImageId);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`pass --confirm ${latestImageId}`);
    expect(readFileSync(harness.productionEnv, "utf8")).toContain(`AL2023_ARM64_AMI_ID=${oldImageId}`);

    const upgraded = harness.run("upgrade", latestImageId);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(readFileSync(harness.productionEnv, "utf8")).toContain(`AL2023_ARM64_AMI_ID=${latestImageId}`);
    expect(readFileSync(harness.localEnv, "utf8")).toContain(`AL2023_ARM64_AMI_ID=${latestImageId}`);
  });
});
