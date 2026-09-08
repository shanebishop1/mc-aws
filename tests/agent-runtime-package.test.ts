import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validateBootstrapPins } from "../lib/bootstrap-pins";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "agent-runtime/package.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(path.join(root, "agent-runtime/runtime-manifest.json"), "utf8"));
const inventory = JSON.parse(readFileSync(path.join(root, "agent-runtime/dependency-inventory.json"), "utf8"));
const pins = validateBootstrapPins(
  JSON.parse(readFileSync(path.join(root, "config/bootstrap-pins.json"), "utf8")) as unknown
);
const execFileAsync = promisify(execFile);

type BuiltRuntime = { archive: string; sha256: string; bytes: number };

async function buildRuntime(command: "package" | "check"): Promise<BuiltRuntime> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(root, "scripts/setup/build-agent-runtime.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  return JSON.parse(stdout.trim()) as BuiltRuntime;
}

describe("standalone agent runtime package", () => {
  it("ships the root-owned executor socket unit in the reviewed EC2 runtime asset inputs", () => {
    const socketUnit = readFileSync(path.join(root, "infra/src/ec2/mc-agent-executor.socket"), "utf8");
    const profileInstaller = readFileSync(path.join(root, "infra/src/ec2/mc-profile-install.sh"), "utf8");
    expect(socketUnit).toContain("ListenStream=/run/mc-agent/executor.sock");
    expect(socketUnit).toContain("SocketUser=root");
    expect(socketUnit).toContain("SocketGroup=mc-agent");
    expect(socketUnit).toContain("SocketMode=0660");
    expect(profileInstaller).toContain('"$SETUP_ROOT/runtime/mc-agent-executor.socket"');
    expect(profileInstaller).toContain('executor_config.get("journalCredentialName") != "executor-journal-hmac"');
    expect(profileInstaller).toContain(
      'executor_loaded != {"executor-journal-hmac", "executor-receipt-private", "executor-clean-start-epoch"}'
    );
  });

  it("pins exact Node 22.19.0 and Pi 0.84.4 inputs with authoritative checksum and MIT inventory", () => {
    expect(packageJson.engines.node).toBe("22.19.0");
    expect(packageJson.dependencies).toEqual(inventory.productionDirectDependencies);
    expect(packageJson.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.4");
    expect(runtimeManifest.pi).toMatchObject({ version: "0.84.4", license: "MIT" });
    expect(runtimeManifest.executorJournal).toEqual({
      schemaVersion: 3,
      authentication: "HMAC-SHA-256",
      keyBytes: 32,
      credentialName: "executor-journal-hmac",
      format: "manifest-checkpoint-transaction-v1",
      appendFraming: "one-authenticated-transaction-per-generation",
      tornAppendRepair: "truncate-to-last-authenticated-complete-boundary-and-sync",
      publicationRecovery: "newest-durable-generation-no-in-memory-rollback",
      compaction: "atomic-checkpoint-only",
      checkpointSuffixes: [".checkpoint.0", ".checkpoint.1"],
      appendSuffixes: [".append.0", ".append.1"],
      generationFloorSuffix: ".generation-floor",
      evidenceFormat: "authenticated-folded-terminal-aggregate-v1",
      evidenceFields: [
        "schemaVersion",
        "recordSequence",
        "acknowledgedCount",
        "latestTerminalSequence",
        "aggregateDigest",
        "replayFilter",
        "mac",
      ],
      replayFilterBytes: 1048576,
      replayFilterHashes: 7,
      terminalAcknowledgementFields: [
        "invocationId",
        "invocationDigest",
        "taskId",
        "leaseGeneration",
        "journalSequence",
        "resultDigest",
        "authorization",
        "acknowledgedAt",
      ],
      gatewaySequenceCheckpoint: true,
      gatewayTerminalAcknowledgement: true,
      monotonicGenerationFloor: true,
      terminalCapacityReservation: true,
      preDispatchReservation: "authenticated-reserved-before-gateway-dispatching",
      maxEntries: 100000,
      maxCancellationTombstones: 1024,
      maxBytes: 67108864,
    });
    expect(runtimeManifest.executorTerminalReceipt).toMatchObject({
      lifecycleLeaseGenerationBound: true,
      executorKeyEpochBound: true,
    });
    expect(runtimeManifest.gatewayExecutionFence).toEqual({
      schemaVersion: 1,
      scope: "runtime-wide",
      persistentAcrossRestart: true,
      executorAuthenticatedStatus: true,
      generationFencedClaims: true,
    });
    expect(runtimeManifest.node).toEqual({
      version: "22.19.0",
      platform: "linux-arm64",
      url: "https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-arm64.tar.xz",
      sha256: "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc",
      checksumSource: "https://nodejs.org/dist/v22.19.0/SHASUMS256.txt",
    });
    expect(pins.artifacts.nodeArm64).toEqual({
      version: runtimeManifest.node.version,
      url: runtimeManifest.node.url,
      sha256: runtimeManifest.node.sha256,
      checksumSource: runtimeManifest.node.checksumSource,
    });
    expect(inventory.piPublishedShrinkwrap.packageEntries).toBe(136);
    expect(inventory.piPublishedShrinkwrap.licenses).toContain("MIT");
  });

  it("is a real pnpm workspace importer with exact production dependencies", () => {
    const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
    const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    expect(workspace).toMatch(/packages:\s*\n\s+- agent-runtime/);
    expect(lock).toContain("agent-runtime:");
    for (const [name, version] of Object.entries(packageJson.dependencies)) {
      expect(String(version)).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock).toMatch(new RegExp(`["']?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?:`));
    }
  });

  it("publishes deterministic content-addressed bytes under concurrent package builders", async () => {
    const baseline = await buildRuntime("package");
    unlinkSync(baseline.archive);
    const builds = await Promise.all([buildRuntime("package"), buildRuntime("check"), buildRuntime("package")]);
    for (const candidate of builds) expect(candidate).toEqual(baseline);

    const built = builds[0];
    expect(built.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(built.bytes).toBeGreaterThan(0);
    expect(built.bytes).toBeLessThanOrEqual(runtimeManifest.runtime.maxArchiveBytes);
    const archiveBytes = readFileSync(built.archive);
    expect(archiveBytes.byteLength).toBe(built.bytes);
    expect(createHash("sha256").update(archiveBytes).digest("hex")).toBe(built.sha256);
    const listing = spawnSync(
      "python3",
      ["-c", "import sys,zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", built.archive],
      {
        encoding: "utf8",
      }
    );
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain("gateway-cli.mjs");
    expect(listing.stdout).toContain("executor-cli.mjs");
    expect(listing.stdout).toContain("bundle-manifest.json");
    expect(listing.stdout).toContain("extensions/status-report/extension.json");
    expect(listing.stdout).toContain("extensions/status-report/SKILL.md");
    expect(listing.stdout).not.toMatch(/(?:^|\/)(?:\.agents|docs?|research|tests?|secrets?)(?:\/|$)/im);
    const content = spawnSync(
      "python3",
      [
        "-c",
        "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(b'\\n'.join(z.read(n) for n in z.namelist()).decode('utf-8','ignore'))",
        built.archive,
      ],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    expect(content.status, content.stderr).toBe(0);
    expect(content.stdout).not.toContain("MC_AWS_LOCAL_SKILL_DO_NOT_PACKAGE");
    expect(content.stdout).not.toContain('"find":"/usr/bin/find"');
    const smokeRoot = mkdtempSync(path.join(path.dirname(built.archive), ".smoke-"));
    try {
      const extraction = spawnSync(
        "python3",
        ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", built.archive, smokeRoot],
        { encoding: "utf8" }
      );
      expect(extraction.status, extraction.stderr).toBe(0);
      const smoke = spawnSync(
        process.execPath,
        ["--disallow-code-generation-from-strings", path.join(smokeRoot, "gateway-cli.mjs")],
        { encoding: "utf8" }
      );
      expect(smoke.status).toBe(1);
      expect(smoke.stderr).toBe("mc-agent gateway failed closed.\n");
    } finally {
      rmSync(smokeRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
