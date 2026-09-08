import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const helper = path.join(root, "infra/src/ec2/mc-maintenance-boot.py");
const generator = path.join(root, "infra/src/ec2/mc-aws-maintenance-generator");
const recoveryUnit = readFileSync(path.join(root, "infra/src/ec2/mc-maintenance-recovery.service"), "utf8");
const units = [
  "minecraft.service",
  "minecraft-dns.service",
  "mc-agent-executor.socket",
  "mc-agent-executor.service",
  "mc-agent-gateway.service",
];
const cleanup: string[] = [];

function runHelper(marker: string, bootId: string, args: string[]) {
  return spawnSync("python3", [helper, "--marker", marker, "--boot-id-file", bootId, ...args], {
    encoding: "utf8",
  });
}

function runGenerator(base: string, marker: string, bootId: string) {
  const normal = path.join(base, "normal");
  const early = path.join(base, "early");
  const late = path.join(base, "late");
  mkdirSync(normal, { recursive: true });
  mkdirSync(early, { recursive: true });
  mkdirSync(late, { recursive: true });
  const result = spawnSync("python3", [generator, normal, early, late], {
    env: { ...process.env, MC_MAINTENANCE_BOOT_HOLD: marker, MC_BOOT_ID_FILE: bootId },
    encoding: "utf8",
  });
  return { ...result, early };
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("reboot-persistent maintenance inhibition", () => {
  const transactionPhases = {
    "host-replacement": ["quiescing", "quiesced", "stopped", "recovery"],
    restore: [
      "prepared",
      "quiescing",
      "runtime-quiesced",
      "profile-staged",
      "roots-review-recorded",
      "roots-published",
      "moving-previous",
      "previous-moved",
      "installing",
      "installed",
      "retention-planned",
      "retained",
      "commit-pending",
      "committed",
      "restoring-services",
      "rollback-started",
      "rollback-files-restored",
      "rollback-roots-restored",
      "rollback-restoring-services",
    ],
    backup: [
      "prepared",
      "quiescing",
      "quiesced",
      "uploading",
      "archive-uploaded",
      "publishing-manifest",
      "uploaded",
      "restoring-services",
    ],
    hibernate: [
      "prepared",
      "quiescing",
      "quiesced",
      "uploading",
      "archive-uploaded",
      "publishing-manifest",
      "uploaded",
      "terminal-quiesced",
      "restoring-services",
    ],
    destroy: [
      "prepared",
      "quiescing",
      "quiesced",
      "uploading",
      "archive-uploaded",
      "publishing-manifest",
      "uploaded",
      "terminal-quiesced",
      "restoring-services",
    ],
    replacement: [
      "prepared",
      "quiescing",
      "quiesced",
      "uploading",
      "archive-uploaded",
      "publishing-manifest",
      "uploaded",
      "terminal-quiesced",
      "restoring-services",
    ],
  } as const;

  it.each(
    Object.entries(transactionPhases).flatMap(([operation, phases]) => phases.map((phase) => [operation, phase]))
  )("masks activation for %s phase %s and permits only same-boot service restoration", (operation, phase) => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-maintenance-phase-"));
    cleanup.push(fixture);
    const marker = path.join(fixture, "maintenance.json");
    const bootId = path.join(fixture, "boot-id");
    writeFileSync(bootId, "boot-one\n");
    expect(
      runHelper(marker, bootId, [
        "create",
        "--owner",
        `${operation}-owner`,
        "--operation",
        operation,
        "--attempt",
        "a".repeat(32),
        "--phase",
        phase,
      ]).status
    ).toBe(0);
    const generated = runGenerator(path.join(fixture, "same-boot"), marker, bootId);
    const restoring =
      phase === "restoring-services" ||
      (operation === "restore" && phase === "rollback-restoring-services") ||
      (operation === "host-replacement" && phase === "recovery");
    for (const unit of units) expect(existsSync(path.join(generated.early, unit))).toBe(!restoring);
    writeFileSync(bootId, "boot-two\n");
    const rebooted = runGenerator(path.join(fixture, "rebooted"), marker, bootId);
    for (const unit of units) expect(existsSync(path.join(rebooted.early, unit))).toBe(true);
  });
  it("masks every activation path after a simulated reboot and reasserts the volatile fence", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-maintenance-"));
    cleanup.push(fixture);
    const marker = path.join(fixture, "maintenance.json");
    const bootId = path.join(fixture, "boot-id");
    const fence = path.join(fixture, "run", "maintenance.json");
    writeFileSync(bootId, "boot-one\n");
    expect(runHelper(marker, bootId, ["create", "--owner", "rollout-a", "--attempt", "a".repeat(64)]).status).toBe(0);

    const first = runGenerator(path.join(fixture, "generator-one"), marker, bootId);
    expect(first.status, first.stderr).toBe(0);
    for (const unit of units) expect(existsSync(path.join(first.early, unit))).toBe(true);

    expect(runHelper(marker, bootId, ["phase", "--owner", "rollout-a", "--phase", "validating"]).status).toBe(0);
    const sameBoot = runGenerator(path.join(fixture, "generator-validating"), marker, bootId);
    for (const unit of units) expect(existsSync(path.join(sameBoot.early, unit))).toBe(false);

    writeFileSync(bootId, "boot-two\n");
    const rebooted = runGenerator(path.join(fixture, "generator-rebooted"), marker, bootId);
    for (const unit of units) expect(existsSync(path.join(rebooted.early, unit))).toBe(true);

    expect(runHelper(marker, bootId, ["reassert", "--fence", fence]).status).toBe(0);
    expect(JSON.parse(readFileSync(fence, "utf8"))).toMatchObject({ owner: "rollout-a", operation: "runtime-rollout" });
  });

  it("publishes the durable marker as exact 0644 even under rollout umask 077", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-maintenance-"));
    cleanup.push(fixture);
    const marker = path.join(fixture, "maintenance.json");
    const bootId = path.join(fixture, "boot-id");
    writeFileSync(bootId, "boot-one\n");
    const created = spawnSync(
      "bash",
      [
        "-c",
        'umask 077; exec python3 "$@"',
        "bash",
        helper,
        "--marker",
        marker,
        "--boot-id-file",
        bootId,
        "create",
        "--owner",
        "rollout-mode",
      ],
      { encoding: "utf8" }
    );
    expect(created.status, created.stderr).toBe(0);
    expect(statSync(marker).mode & 0o777).toBe(0o644);
    expect(runHelper(marker, bootId, ["phase", "--owner", "rollout-mode", "--phase", "validating"]).status).toBe(0);
  });

  it("fails closed for a malformed durable marker and clears only the exact owner", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-maintenance-"));
    cleanup.push(fixture);
    const marker = path.join(fixture, "maintenance.json");
    const bootId = path.join(fixture, "boot-id");
    writeFileSync(bootId, "boot-one\n");
    writeFileSync(marker, "not-json\n", { mode: 0o644 });
    const generated = runGenerator(path.join(fixture, "generator"), marker, bootId);
    for (const unit of units) expect(existsSync(path.join(generated.early, unit))).toBe(true);
    expect(runHelper(marker, bootId, ["clear", "--owner", "wrong"]).status).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("orders the recovery unit before boot activation without starting application services", () => {
    expect(recoveryUnit).toContain("DefaultDependencies=no");
    expect(recoveryUnit).toContain("Before=network.target multi-user.target sockets.target");
    expect(recoveryUnit).toContain("ConditionPathExists=/var/lib/mc-aws/maintenance-boot-hold.json");
    expect(recoveryUnit).toContain("ExecStart=/usr/local/bin/mc-maintenance-boot.py reassert");
    expect(recoveryUnit).not.toMatch(/systemctl|minecraft\.service|mc-agent-(?:gateway|executor)/);
  });
});
