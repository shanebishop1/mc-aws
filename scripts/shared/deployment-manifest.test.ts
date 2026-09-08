import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const claimToken = "11111111-2222-4333-8444-555555555555";
const cfAccount = "a".repeat(32);
const deploymentId = "11111111-2222-4333-8444-555555555555";
const uploadConfigSha256 = "e".repeat(64);
const processStart = (pid: number) => {
  const source = readFileSync(`/proc/${pid}/stat`, "utf8");
  return source
    .slice(source.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
};
const deploymentReceipt = (versionId: string, scriptEtag: string, artifactMerkleSha256: string, verifier: string) =>
  createHash("sha256")
    .update(
      [
        "mc-aws/cloudflare-deployment-receipt/v1",
        deploymentId,
        versionId,
        scriptEtag,
        artifactMerkleSha256,
        verifier,
        uploadConfigSha256,
      ]
        .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
        .join("|")
    )
    .digest("hex");

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
  const spawnRun = (args: string[], extraEnvironment: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...extraEnvironment, NODE_ENV: "test" };
      childEnvironment.MC_AWS_DEPLOYMENT_MANIFEST = manifestPath;
      const child = spawn("node", [script, ...args], {
        cwd: rootDir,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const spawnWithInheritedFd = (args: string[], descriptor: number, extraEnvironment: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...extraEnvironment, NODE_ENV: "test" };
      childEnvironment.MC_AWS_DEPLOYMENT_MANIFEST = manifestPath;
      childEnvironment.MC_AWS_DEPLOYMENT_MANIFEST_LOCK_FD = "3";
      childEnvironment.MC_AWS_DEPLOYMENT_MANIFEST_LOCK_OWNER_PID = String(process.pid);
      childEnvironment.MC_AWS_DEPLOYMENT_MANIFEST_LOCK_OWNER_START = processStart(process.pid);
      const child = spawn(
        "/usr/bin/flock",
        [
          "--nonblock",
          "--exclusive",
          `${manifestPath}.lock`,
          "/bin/sh",
          "-c",
          'export MC_AWS_DEPLOYMENT_MANIFEST_LOCK_PARENT_PID="$PPID"; exec "$@"',
          "mc-aws-manifest-child",
          "node",
          script,
          ...args,
        ],
        {
          cwd: rootDir,
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe", descriptor],
        }
      ) as ChildProcess;
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  return {
    manifestPath,
    run,
    spawnRun,
    spawnWithInheritedFd,
    read: () => JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("deployment ownership manifest transitions", () => {
  it("rejects forged markers and FDs for a different file, while acquiring a free inherited FD", async () => {
    const test = harness();
    const forged = await test.spawnRun(["validate"], { MC_AWS_DEPLOYMENT_MANIFEST_LOCK_HELD: "1" });
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toContain("inherited locked FD");

    const lock = openSync(`${test.manifestPath}.lock`, "a+", 0o600);
    try {
      const unlocked = await test.spawnWithInheritedFd(["validate"], lock);
      expect(unlocked.status, unlocked.stderr).toBe(0);
    } finally {
      closeSync(lock);
    }

    const wrong = openSync(`${test.manifestPath}.wrong-lock`, "a+", 0o600);
    try {
      const mismatched = await test.spawnWithInheritedFd(["validate"], wrong);
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.stderr).toContain("does not match");
    } finally {
      closeSync(wrong);
    }
  });

  it("rejects an inherited same-inode FD when another writer owns the advisory lock", async () => {
    const test = harness();
    const ownedDirectory = directories.pop();
    const lockPath = `${test.manifestPath}.lock`;
    const lock = openSync(lockPath, "a+", 0o600);
    closeSync(lock);
    const holder = spawn("/usr/bin/flock", ["--exclusive", lockPath, "sleep", "5"], {
      stdio: "ignore",
    });
    try {
      let contenderHasLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = spawnSync("/usr/bin/flock", ["--nonblock", "--exclusive", lockPath, "/bin/true"]);
        if (probe.status !== 0) {
          contenderHasLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(contenderHasLock).toBe(true);
      const sameInode = openSync(`${test.manifestPath}.lock`, "a+", 0o600);
      try {
        const forged = await test.spawnWithInheritedFd(["validate"], sameInode);
        expect(forged.status, forged.stderr).not.toBe(0);
      } finally {
        closeSync(sameInode);
      }
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a piggybacked inherited FD whose parent is not the flock wrapper", async () => {
    const test = harness();
    const lock = openSync(`${test.manifestPath}.lock`, "a+", 0o600);
    try {
      const child = spawn("node", [script, "validate"], {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MC_AWS_DEPLOYMENT_MANIFEST: test.manifestPath,
          MC_AWS_DEPLOYMENT_MANIFEST_LOCK_FD: "3",
          MC_AWS_DEPLOYMENT_MANIFEST_LOCK_PARENT_PID: String(process.pid),
        },
        stdio: ["ignore", "ignore", "pipe", lock],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk;
      });
      const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(status, stderr).not.toBe(0);
      expect(stderr).toContain("flock wrapper");
    } finally {
      closeSync(lock);
    }
  });

  it("rejects an unlocked manifest FD when the flock wrapper owns another file", async () => {
    const test = harness();
    const otherLockPath = `${test.manifestPath}.other-lock`;
    const manifestLock = openSync(`${test.manifestPath}.lock`, "a+", 0o600);
    const ownerStart = processStart(process.pid);
    try {
      const child = spawn(
        "/usr/bin/flock",
        [
          "--nonblock",
          "--exclusive",
          otherLockPath,
          "/bin/sh",
          "-c",
          'export MC_AWS_DEPLOYMENT_MANIFEST_LOCK_PARENT_PID="$PPID"; exec "$@"',
          "mc-aws-manifest-child",
          "node",
          script,
          "validate",
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            NODE_ENV: "test",
            MC_AWS_DEPLOYMENT_MANIFEST: test.manifestPath,
            MC_AWS_DEPLOYMENT_MANIFEST_LOCK_FD: "3",
            MC_AWS_DEPLOYMENT_MANIFEST_LOCK_OWNER_PID: String(process.pid),
            MC_AWS_DEPLOYMENT_MANIFEST_LOCK_OWNER_START: ownerStart,
          },
          stdio: ["ignore", "ignore", "pipe", manifestLock],
        }
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk;
      });
      const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(status, stderr).not.toBe(0);
      expect(stderr).toContain("device/inode");
    } finally {
      closeSync(manifestLock);
      rmSync(otherLockPath, { force: true });
    }
  });

  it("advances a monotonic root revision for every successful write", () => {
    const test = harness();
    const first = test.run(["mark-complete", "--resource", "cloudformation-stack"]);
    expect(first.status, first.stderr).toBe(0);
    expect(test.read().revision).toBe(1);
    const second = test.run(["mark-complete", "--resource", "final-data-preservation"]);
    expect(second.status, second.stderr).toBe(0);
    expect(test.read().revision).toBe(2);
  });

  it("migrates a legacy manifest under the lock without inferring ownership", () => {
    const test = harness();
    writeFileSync(
      test.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        project: "mc-aws",
        aws: {
          accountId: account,
          region,
          stack: {
            name: stack,
            id: "",
            createdByProject: false,
            observedBeforeSetup: "absent",
            claimToken,
          },
          dlmPolicies: [],
        },
        cloudflare: { routes: [], kvNamespaces: [], panelDnsRecords: [] },
        teardown: { completedResources: [] },
      }),
      { mode: 0o600 }
    );
    expect(test.run(["mark-complete", "--resource", "cloudformation-stack"]).status).toBe(0);
    expect(test.read()).toMatchObject({ revision: 1, aws: { ssmParameters: [] } });
  });

  it("does not migrate a legacy local receipt digest into provider attestation", () => {
    const test = harness();
    writeFileSync(
      test.manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        project: "mc-aws",
        aws: { dlmPolicies: [], ssmParameters: [] },
        cloudflare: {
          worker: {
            name: "mc-aws-panel",
            createdByProject: true,
            observedBeforeDeploy: "existing",
            deploymentId,
            receiptVerifierSetSha256: "a".repeat(64),
          },
          routes: [],
          kvNamespaces: [],
          panelDnsRecords: [],
        },
        teardown: { completedResources: [] },
      }),
      { mode: 0o600 }
    );
    expect(test.run(["mark-complete", "--resource", "cloudflare-worker"]).status).toBe(0);
    expect(
      (test.read().cloudflare as { worker: Record<string, unknown> }).worker.receiptVerifierSetSha256
    ).toBeUndefined();
  });

  it("merges concurrent disjoint updates under one shared lock", async () => {
    const test = harness();
    expect(test.run(["mark-complete", "--resource", "cloudformation-stack"]).status).toBe(0);
    const route = [
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
    ];
    const kv = ["kv", "--binding", "PANEL_KV", "--id", "c".repeat(32), "--title", "panel-kv", "--ownership", "created"];
    const first = test.spawnRun(route, { MC_AWS_MANIFEST_TEST_HOLD_LOCK_MS: "250" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = test.spawnRun(kv);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual([0, 0]);
    expect((test.read().cloudflare as { routes: unknown[] }).routes).toHaveLength(1);
    expect((test.read().cloudflare as { kvNamespaces: unknown[] }).kvNamespaces).toHaveLength(1);
    expect(test.read().revision).toBe(3);
  });

  it("fails a conflicting stale update closed instead of overwriting the winner", async () => {
    const test = harness();
    const base = [
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
    ];
    expect(test.run(base).status).toBe(0);
    const first = test.spawnRun([...base, "--id", "c".repeat(32), "--replaces-id", "b".repeat(32)], {
      MC_AWS_MANIFEST_TEST_HOLD_LOCK_MS: "250",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = test.spawnRun([...base, "--id", "d".repeat(32), "--replaces-id", "b".repeat(32)]);
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.status === 0)).toHaveLength(1);
    expect(results.find((result) => result.status !== 0)?.stderr).toContain("Deployment manifest error");
  });

  it("reclaims a lock left by a crashed writer before the next atomic write", async () => {
    const test = harness();
    const holder = spawn("node", [script, "mark-complete", "--resource", "cloudformation-stack"], {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MC_AWS_DEPLOYMENT_MANIFEST: test.manifestPath,
        MC_AWS_MANIFEST_TEST_HOLD_LOCK_MS: "5000",
      },
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100 && !existsSync(`${test.manifestPath}.lock`); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.on("close", resolve));
    const contenders = await Promise.all([
      test.spawnRun(["mark-complete", "--resource", "cloudformation-stack"]),
      test.spawnRun(["mark-complete", "--resource", "final-data-preservation"]),
    ]);
    expect(contenders.every((result) => result.status === 0)).toBe(true);
    expect(test.read().revision).toBe(2);
  });

  it("reconciles a claim-proven stack created before aws-deployed persisted its StackId", () => {
    const test = harness();
    const initialized = test.run([
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
      "--claim-token",
      claimToken,
    ]);
    expect(initialized.status, initialized.stderr).toBe(0);
    const reconciled = test.run([
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
      "--claim-token",
      claimToken,
      "--claim-observed",
      "true",
    ]);
    expect(reconciled.status, reconciled.stderr).toBe(0);
    expect((test.read().aws as { stack: { id: string; createdByProject: boolean } }).stack).toMatchObject({
      id: stackId,
      createdByProject: true,
    });
  });

  it("pins exact executor receipt verifiers and retains only bounded rotation history", () => {
    const test = harness();
    for (let index = 0; index < 4; index += 1) {
      const { publicKey } = generateKeyPairSync("ed25519");
      const spki = publicKey.export({ format: "der", type: "spki" });
      const keyId = `executor-receipt-${createHash("sha256").update(spki).digest("hex")}`;
      expect(
        test.run([
          "executor-receipt",
          "--key-id",
          keyId,
          "--public-key-spki",
          spki.toString("base64"),
          ...(index > 0 ? ["--rotation-cutoff-at", "2099-09-04T12:30:00.000Z"] : []),
        ]).status
      ).toBe(0);
    }
    const receipt = test.read().executorReceipt as {
      currentKeyId: string;
      verifiers: Array<{ keyId: string }>;
    };
    expect(receipt.verifiers).toHaveLength(3);
    expect(receipt.currentKeyId).toBe(receipt.verifiers[0].keyId);

    const forged = test.run([
      "executor-receipt",
      "--key-id",
      `executor-receipt-${"0".repeat(64)}`,
      "--public-key-spki",
      generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      "--rotation-cutoff-at",
      "2099-09-04T12:30:00.000Z",
    ]);
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toContain("key identity");
  });

  it("records receipt authority only with complete provider version and content evidence", () => {
    const test = harness();
    const spki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const keyId = `executor-receipt-${createHash("sha256").update(spki).digest("hex")}`;
    expect(test.run(["executor-receipt", "--key-id", keyId, "--public-key-spki", spki.toString("base64")]).status).toBe(
      0
    );
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
    const receiptDigest = createHash("sha256").update(JSON.stringify(test.read().executorReceipt)).digest("hex");
    const incomplete = test.run([
      "cloudflare-deployed",
      "--deployment-id",
      deploymentId,
      "--receipt-authority-deployed",
      "true",
      "--receipt-verifier-set-sha256",
      receiptDigest,
    ]);
    expect(incomplete.status).not.toBe(0);
    const versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const artifactMerkleSha256 = "c".repeat(64);
    const scriptEtag = "provider-etag-123";
    expect(
      test.run([
        "cloudflare-deployed",
        "--deployment-id",
        deploymentId,
        "--receipt-authority-deployed",
        "true",
        "--receipt-verifier-set-sha256",
        receiptDigest,
        "--version-id",
        versionId,
        "--script-etag",
        scriptEtag,
        "--artifact-merkle-sha256",
        artifactMerkleSha256,
        "--upload-config-sha256",
        uploadConfigSha256,
        "--deployment-receipt-sha256",
        deploymentReceipt(versionId, scriptEtag, artifactMerkleSha256, receiptDigest),
      ]).status
    ).toBe(0);
    expect((test.read().cloudflare as { worker: Record<string, string> }).worker).toMatchObject({
      deploymentId,
      versionId,
      scriptEtag,
      artifactMerkleSha256,
      receiptVerifierSetSha256: receiptDigest,
      deploymentReceiptSha256: deploymentReceipt(versionId, scriptEtag, artifactMerkleSha256, receiptDigest),
      uploadConfigSha256,
    });
  });

  it("refuses verifier rotation while a Worker attestation still names the old verifier set", () => {
    const test = harness();
    const oldSpki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const oldKeyId = `executor-receipt-${createHash("sha256").update(oldSpki).digest("hex")}`;
    expect(
      test.run(["executor-receipt", "--key-id", oldKeyId, "--public-key-spki", oldSpki.toString("base64")]).status
    ).toBe(0);
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
    const oldDigest = createHash("sha256").update(JSON.stringify(test.read().executorReceipt)).digest("hex");
    const oldVersionId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const oldArtifactMerkleSha256 = "d".repeat(64);
    const oldScriptEtag = "etag";
    expect(
      test.run([
        "cloudflare-deployed",
        "--deployment-id",
        deploymentId,
        "--receipt-authority-deployed",
        "true",
        "--receipt-verifier-set-sha256",
        oldDigest,
        "--version-id",
        oldVersionId,
        "--script-etag",
        oldScriptEtag,
        "--artifact-merkle-sha256",
        oldArtifactMerkleSha256,
        "--upload-config-sha256",
        uploadConfigSha256,
        "--deployment-receipt-sha256",
        deploymentReceipt(oldVersionId, oldScriptEtag, oldArtifactMerkleSha256, oldDigest),
      ]).status
    ).toBe(0);
    const newSpki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const newKeyId = `executor-receipt-${createHash("sha256").update(newSpki).digest("hex")}`;
    const rotation = test.run([
      "executor-receipt",
      "--key-id",
      newKeyId,
      "--public-key-spki",
      newSpki.toString("base64"),
      "--rotation-cutoff-at",
      "2099-09-04T12:30:00.000Z",
    ]);
    expect(rotation.status).not.toBe(0);
    expect(rotation.stderr).toContain("does not match the current executor verifier set");
    expect((test.read().executorReceipt as { currentKeyId: string }).currentKeyId).toBe(oldKeyId);
  });

  it("treats rediscovery of the unchanged current verifier as an idempotent no-op", () => {
    const test = harness();
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const keyId = `executor-receipt-${createHash("sha256").update(spki).digest("hex")}`;
    const args = [
      "executor-receipt",
      "--key-id",
      keyId,
      "--public-key-spki",
      spki.toString("base64"),
      "--key-epoch",
      "7",
    ];
    expect(test.run(args).status).toBe(0);
    const before = readFileSync(test.manifestPath, "utf8");
    expect(test.run(args).status).toBe(0);
    expect(readFileSync(test.manifestPath, "utf8")).toBe(before);
  });

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
        "--claim-token",
        claimToken,
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
          ownership: "unproven",
          observedBeforeSetup: "absent",
        }),
        expect.objectContaining({
          name: "/minecraft/github-pat",
          ownership: "preexisting",
          observedBeforeSetup: "existing",
        }),
      ])
    );
    expect(
      test.run([
        "aws-deployed",
        "--stack-id",
        stackId,
        "--instance-id",
        `i-${"2".repeat(17)}`,
        "--runtime-user",
        "mc-aws-runtime-user",
        "--claim-token",
        claimToken,
        "--claim-observed",
        "true",
      ]).status
    ).toBe(0);
    const override = test.run([
      "ssm-stack-resource",
      "--name",
      "/minecraft/github-pat",
      "--type",
      "SecureString",
      "--logical-id",
      "LegacyPat",
      "--stack-id",
      stackId,
    ]);
    expect(override.status).toBe(0);
    const migrated = (test.read().aws as { ssmParameters: Array<Record<string, unknown>> }).ssmParameters;
    expect(migrated).toContainEqual(
      expect.objectContaining({ name: "/minecraft/github-pat", ownership: "created", source: "exact-stack-resource" })
    );
  });

  it("records only non-secret recovery-capsule verifier metadata and preserves its floor", () => {
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
        "--claim-token",
        claimToken,
      ]).status
    ).toBe(0);
    expect(
      test.run([
        "recovery-capsule",
        "--status",
        "preserved",
        "--checkpoint-generation",
        "12",
        "--floor-generation",
        "9",
        "--preserved-at",
        "2026-09-04T00:00:00Z",
      ]).status
    ).toBe(0);
    expect(test.read().teardown).toMatchObject({
      recoveryCapsule: expect.objectContaining({
        status: "preserved",
        checkpointGeneration: 12,
        floorGeneration: 9,
        keyIdSource: "authenticated-keyring",
      }),
    });
    expect(readFileSync(test.manifestPath, "utf8")).not.toContain("secretBase64");
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
        "--claim-token",
        claimToken,
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
        "--claim-token",
        claimToken,
        "--claim-observed",
        "true",
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
    ).not.toBe(0);
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

  it("rejects a provider receipt tuple missing its deployment ID", () => {
    const test = harness();
    const spki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const keyId = `executor-receipt-${createHash("sha256").update(spki).digest("hex")}`;
    expect(test.run(["executor-receipt", "--key-id", keyId, "--public-key-spki", spki.toString("base64")]).status).toBe(
      0
    );
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
    const versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const scriptEtag = "etag";
    const artifactMerkleSha256 = "c".repeat(64);
    const verifier = createHash("sha256").update(JSON.stringify(test.read().executorReceipt)).digest("hex");
    expect(
      test.run([
        "cloudflare-deployed",
        "--deployment-id",
        deploymentId,
        "--receipt-authority-deployed",
        "true",
        "--receipt-verifier-set-sha256",
        verifier,
        "--version-id",
        versionId,
        "--script-etag",
        scriptEtag,
        "--artifact-merkle-sha256",
        artifactMerkleSha256,
        "--upload-config-sha256",
        uploadConfigSha256,
        "--deployment-receipt-sha256",
        deploymentReceipt(versionId, scriptEtag, artifactMerkleSha256, verifier),
      ]).status
    ).toBe(0);
    const manifest = test.read();
    (manifest.cloudflare as { worker: Record<string, unknown> }).worker.deploymentId = undefined;
    writeFileSync(test.manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = test.run(["validate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("one complete provider observation");
  });

  it("records canonical DNS TTL as part of the manifest identity", () => {
    const test = harness();
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
        "custom",
        "--workers-dev",
        "false",
      ]).status
    ).toBe(0);
    const dnsArgs = [
      "dns",
      "--zone",
      "a".repeat(32),
      "--id",
      "b".repeat(32),
      "--name",
      "panel.example.com",
      "--type",
      "A",
      "--content",
      "192.0.2.1",
      "--ttl",
      "1",
      "--proxied",
      "true",
      "--ownership",
      "created",
      "--modified",
      "false",
    ];
    expect(test.run(dnsArgs).status).toBe(0);
    expect(
      (test.read().cloudflare as { panelDnsRecords: Array<Record<string, unknown>> }).panelDnsRecords[0]
    ).toMatchObject({
      applied: { ttl: 1, proxied: true },
      id: "b".repeat(32),
    });
    const preexisting = test.run([
      "dns",
      "--zone",
      "a".repeat(32),
      "--id",
      "c".repeat(32),
      "--name",
      "panel.example.com",
      "--type",
      "A",
      "--content",
      "192.0.2.1",
      "--ttl",
      "1",
      "--proxied",
      "true",
      "--ownership",
      "preexisting",
      "--modified",
      "true",
      "--original-proxied",
      "false",
      "--original-ttl",
      "300",
    ]);
    expect(preexisting.status).toBe(0);
    expect(
      (test.read().cloudflare as { panelDnsRecords: Array<Record<string, unknown>> }).panelDnsRecords[1]
    ).toMatchObject({
      applied: { ttl: 1, proxied: true },
      original: { ttl: 300, proxied: false },
    });
  });
});
