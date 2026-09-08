import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve(process.cwd(), "infra/src/ec2/mc-release-journal.py");
const rollout = readFileSync(path.resolve(process.cwd(), "infra/src/ec2/mc-runtime-rollout.sh"), "utf8");
const cleanup: string[] = [];

function run(root: string, args: string[]) {
  return spawnSync("python3", [helper, "--root", root, ...args], { encoding: "utf8" });
}

function begin(root: string) {
  const serviceState = path.join(path.dirname(root), `service-state-${path.basename(root)}.tsv`);
  writeFileSync(
    serviceState,
    [
      "minecraft-dns.service\tinactive\tdisabled",
      "minecraft.service\tinactive\tdisabled",
      "mc-agent-world-roots.service\tinactive\tdisabled",
      "mc-agent-executor.socket\tinactive\tdisabled",
      "mc-agent-executor.service\tinactive\tdisabled",
      "mc-agent-gateway.service\tinactive\tdisabled",
      "",
    ].join("\n")
  );
  return run(root, [
    "begin",
    "--nonce",
    "attempt-1",
    "--release-sha256",
    "a".repeat(64),
    "--profile-sha256",
    "b".repeat(64),
    "--service-state-sha256",
    spawnSync("sha256sum", [serviceState], { encoding: "utf8" }).stdout.split(" ")[0],
    "--service-state-file",
    serviceState,
    "--target-runtime",
    `releases/${"d".repeat(64)}`,
  ]);
}

function completeRollback(root: string) {
  expect(run(root, ["phase", "rolled-back"]).status).toBe(0);
  return run(root, ["finish", "rolled-back"]);
}

function advanceToCommitted(root: string) {
  for (const phase of [
    "quiesced",
    "snapshotted",
    "profile-installed",
    "runtime-installed",
    "services-restored",
    "readiness-passed",
    "committed",
  ]) {
    expect(run(root, ["phase", phase]).status).toBe(0);
  }
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("content-addressed release attempt journal", () => {
  it("restores exact recursive, symlink, missing, and stale-marker state and consumes only its own journal", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    const destination = path.join(fixture, "destination");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "config.json"), "old-config\n");
    writeFileSync(path.join(destination, "runtime-previous"), "stale-release\n");
    symlinkSync("config.json", path.join(destination, "current"));
    const missing = path.join(destination, "new-plugin.jar");

    expect(begin(journal).status).toBe(0);
    expect(run(journal, ["capture", "--path", destination, "--recursive", destination, "--path", missing]).status).toBe(
      0
    );

    writeFileSync(path.join(destination, "config.json"), "new-config\n");
    rmSync(path.join(destination, "current"));
    symlinkSync("new-plugin.jar", path.join(destination, "current"));
    writeFileSync(missing, "new-plugin\n");

    expect(run(journal, ["restore", "--skip-path", path.join(destination, "runtime-previous")]).status).toBe(0);
    expect(readFileSync(path.join(destination, "config.json"), "utf8")).toBe("old-config\n");
    expect(readFileSync(path.join(destination, "runtime-previous"), "utf8")).toBe("stale-release\n");
    expect(lstatSync(path.join(destination, "current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(destination, "current"))).toBe("config.json");
    expect(existsSync(missing)).toBe(false);
    expect(completeRollback(journal).status).toBe(0);
    expect(existsSync(path.join(journal, "active"))).toBe(false);
  });

  it("rejects a stale active attempt and retains evidence when rollback verification cannot succeed", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    const target = path.join(fixture, "target");
    writeFileSync(target, "before\n");
    expect(begin(journal).status).toBe(0);
    expect(begin(journal).stderr).toContain("unresolved release attempt");
    expect(run(journal, ["capture", "--path", target]).status).toBe(0);
    const active = readFileSync(path.join(journal, "active"), "utf8").trim();
    const objects = path.join(journal, "attempts", active, "objects");
    const object = readdirSync(objects)[0];
    writeFileSync(path.join(objects, object), "corrupt\n");
    writeFileSync(target, "after\n");

    const restored = run(journal, ["restore"]);
    expect(restored.status).not.toBe(0);
    expect(restored.stderr).toContain("digest mismatch");
    expect(existsSync(path.join(journal, "active"))).toBe(true);
  });

  it("rejects symlinked ancestors during capture and rollback without touching an outside sentinel", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    const server = path.join(fixture, "server");
    const outside = path.join(fixture, "outside");
    mkdirSync(server);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "plugin.jar"), "outside\n");
    symlinkSync(outside, path.join(server, "plugins"));
    expect(begin(journal).status).toBe(0);
    const capture = run(journal, ["capture", "--path", path.join(server, "plugins", "plugin.jar")]);
    expect(capture.status).not.toBe(0);
    expect(capture.stderr).toContain("symlinked ancestor");
    expect(readFileSync(path.join(outside, "plugin.jar"), "utf8")).toBe("outside\n");
    const recursive = run(journal, [
      "capture",
      "--path",
      path.join(server, "plugins"),
      "--recursive",
      path.join(server, "plugins"),
    ]);
    expect(recursive.status).not.toBe(0);
    expect(recursive.stderr).toContain("not a real directory");
  });

  it("does not snapshot its own journal and flushes the captured tree before recording it", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    const state = path.join(fixture, "state");
    mkdirSync(state);
    writeFileSync(path.join(state, "profile.json"), "before\n");

    expect(begin(journal).status).toBe(0);
    expect(run(journal, ["capture", "--path", fixture, "--recursive", fixture, "--exclude-path", journal]).status).toBe(
      0
    );
    const active = readFileSync(path.join(journal, "active"), "utf8").trim();
    const envelope = JSON.parse(readFileSync(path.join(journal, "attempts", active, "snapshot.json"), "utf8")) as {
      payload: { records: Array<{ path: string; children?: Array<{ path: string }> }> };
      payloadSha256: string;
    };
    const paths = JSON.stringify(envelope.payload.records);
    expect(envelope.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(path.join(journal, "attempts", active, "snapshot.sha256"))).toBe(false);
    expect(paths).not.toContain(journal);
    expect(paths).toContain(path.join(state, "profile.json"));
    writeFileSync(path.join(state, "profile.json"), "after\n");
    const restored = run(journal, ["restore"]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(path.join(state, "profile.json"), "utf8")).toBe("before\n");
  });

  it("removes content objects and the active marker only after a committed success", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    const target = path.join(fixture, "target");
    writeFileSync(target, "before\n");
    expect(begin(journal).status).toBe(0);
    expect(run(journal, ["capture", "--path", target]).status).toBe(0);
    expect(run(journal, ["finish", "committed"]).status).not.toBe(0);
    advanceToCommitted(journal);
    expect(run(journal, ["status"]).stdout.trim()).toBe("committed");
    expect(run(journal, ["finish", "committed"]).status).toBe(0);
    expect(existsSync(path.join(journal, "active"))).toBe(false);
    expect(readdirSync(path.join(journal, "attempts"))).toEqual([]);
  });

  it("publishes exact service state and the complete attempt before the active pointer", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    expect(begin(journal).status).toBe(0);
    const active = readFileSync(path.join(journal, "active"), "utf8").trim();
    const attempt = path.join(journal, "attempts", active);
    expect(readFileSync(path.join(attempt, "service-state.tsv"), "utf8")).toContain(
      "mc-agent-executor.socket\tinactive\tdisabled"
    );
    expect(run(journal, ["describe"]).stdout).toContain(`releases/${"d".repeat(64)}`);
    expect(run(journal, ["phase", "committed"]).stderr).toContain("illegal release journal phase transition");
  });

  it.each([
    "prepared",
    "quiesced",
    "snapshotted",
    "profile-installed",
    "runtime-installed",
    "services-restored",
    "readiness-passed",
    "rolling-back",
    "filesystem-restored",
  ])("reruns exact rollback idempotently from the %s power-loss checkpoint", (checkpoint) => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mc-release-journal-"));
    cleanup.push(fixture);
    const journal = path.join(fixture, "journal");
    const target = path.join(fixture, "target");
    writeFileSync(target, "before\n");
    expect(begin(journal).status).toBe(0);
    expect(run(journal, ["capture", "--path", target]).status).toBe(0);
    const phases = [
      "quiesced",
      "snapshotted",
      "profile-installed",
      "runtime-installed",
      "services-restored",
      "readiness-passed",
    ];
    for (const phase of phases) {
      if (checkpoint === "prepared") break;
      expect(run(journal, ["phase", phase]).status).toBe(0);
      if (phase === checkpoint) break;
    }
    writeFileSync(target, "after\n");
    if (checkpoint === "rolling-back") expect(run(journal, ["phase", "rolling-back"]).status).toBe(0);
    if (checkpoint === "filesystem-restored") {
      expect(run(journal, ["restore"]).status).toBe(0);
    }
    expect(run(journal, ["restore"]).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("before\n");
  });

  it("exposes bounded phase faults, no-transition rollback gating, readiness, and success cleanup", () => {
    for (const phase of [
      "prepared",
      "snapshotted",
      "quiesced",
      "profile-installed",
      "runtime-installed",
      "services-restored",
      "readiness-passed",
      "committed",
    ]) {
      expect(rollout).toContain(`fault_after ${phase}`);
    }
    expect(rollout).toContain("runtime_transition_changed == 1");
    expect(rollout).toContain("--skip-path /opt/mc-agent/runtime-previous");
    expect(rollout).toContain("MC_RUNTIME_ROLLOUT_FAULT_ROLLBACK");
    expect(rollout).toContain("mcstatus 127.0.0.1:25565 status");
    expect(rollout).toContain("plugin initialization failed");
    expect(rollout).toContain("finish committed");
    expect(rollout).toContain("finish rolled-back");
    expect(rollout).toContain("recover_active_attempt");
    expect(rollout).toContain("filesystem-restored");
    expect(rollout).toContain("service-state.tsv");
    expect(rollout).toContain("AGENT_TARGET_WANTS");
    expect(rollout).toContain("sockets.target.wants/mc-agent-executor.socket");
    expect(rollout).toContain("multi-user.target.wants/mc-agent-executor.service");
    expect(rollout).toContain("multi-user.target.wants/mc-agent-gateway.service");
    expect(rollout).toContain("snapshot_agent_target_wants_record");
    expect(rollout).toContain("restore_agent_target_wants_for_not_found");
    expect(rollout).toContain("unrelated agent target-wants entry changed during rollout");
    expect(rollout).toContain("minecraft_log_bytes=0");
    expect(rollout).toContain("capture_minecraft_log_baseline");
    expect(rollout).toContain("validate_profile_readiness");
    expect(rollout).toContain("staged Paper digest mismatch");
    expect(rollout).toContain("live Paper digest mismatch");
    expect(rollout).toContain("staged plugin lock contents do not match published evidence");
    expect(rollout).toContain("start_candidate_minecraft");
    expect(rollout).toContain("stop_candidate_minecraft");
    expect(rollout).not.toContain("unresolved precommit release attempt remains quiesced");
    expect(rollout).toContain("set +e\n  recover_active_attempt\n  recovery_status=$?");
    expect(rollout).not.toContain("( set -e; recover_active_attempt )");
    expect(rollout).toContain("probe_readiness || return 1");
    expect(rollout).toContain("trap 'signal_exit 143' TERM");
    expect(rollout).not.toContain("mc-agent-install.sh rollback");
  });

  it("closes rollout-start races before taking the mutable-state snapshot", () => {
    const main = rollout.indexOf("acquire_runtime_fence\n", rollout.indexOf("trap cleanup()"));
    const fence = main;
    const drain = rollout.indexOf("drain_and_quiesce_runtime() {");
    const drainSignal = rollout.indexOf("--signal=SIGUSR1", drain);
    const firstIdle = rollout.indexOf("--handoff-state auto", drain);
    const mask = rollout.indexOf('systemctl mask --runtime "${SERVICE_UNITS[@]}"', drain);
    const stop = rollout.indexOf("systemctl stop mc-agent-world-roots.service", mask);
    const drainCall = rollout.indexOf("drain_and_quiesce_runtime\n", main);
    const fsync = rollout.indexOf("fsync_mutable_state\n", drainCall);
    const capture = rollout.indexOf("snapshot_args=(", fsync);
    const profile = rollout.indexOf('"$profile_installer" "${profile_args[@]}"', capture);
    expect(fence).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(-1);
    expect(drainSignal).toBeGreaterThan(drain);
    expect(firstIdle).toBeGreaterThan(drainSignal);
    expect(mask).toBeGreaterThan(firstIdle);
    expect(stop).toBeGreaterThan(mask);
    expect(drainCall).toBeGreaterThan(fence);
    expect(fsync).toBeGreaterThan(stop);
    expect(capture).toBeGreaterThan(fsync);
    expect(profile).toBeGreaterThan(capture);
    expect(rollout.match(/--handoff-state auto/g)?.length).toBeGreaterThanOrEqual(2);
    expect(rollout).toContain('--exclude-path "$JOURNAL_ROOT"');
    expect(rollout).toContain("executor effect became active or indeterminate during quiescence");
  });

  it("keeps a socket-activation writer fenced through rollback and readiness", () => {
    const mask = rollout.indexOf('systemctl mask --runtime "${SERVICE_UNITS[@]}"');
    const stop = rollout.indexOf("systemctl stop mc-agent-world-roots.service", mask);
    const restore = rollout.indexOf('restore_services "$service_state"');
    const readiness = rollout.indexOf("run_readiness_and_restore_state", restore);
    const release = rollout.lastIndexOf("release_runtime_fence");
    expect(mask).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(mask);
    expect(restore).toBeGreaterThan(stop);
    expect(readiness).toBeGreaterThan(restore);
    expect(release).toBeGreaterThan(readiness);
  });

  it("checks an inactive Minecraft candidate before committing and restores its inactive state", () => {
    const recovery = rollout.indexOf('if [[ "$phase" == committed ]]; then');
    const recoveryReadiness = rollout.indexOf("run_readiness_and_restore_state || return 1", recovery);
    const normalReadiness = rollout.lastIndexOf("run_readiness_and_restore_state");
    const candidateStart = rollout.indexOf("start_candidate_minecraft || return 1");
    const candidateStop = rollout.indexOf("stop_candidate_minecraft || return 1", candidateStart);
    const readinessPhase = rollout.indexOf("phase readiness-passed", candidateStop);
    expect(recoveryReadiness).toBeGreaterThan(recovery);
    expect(candidateStart).toBeGreaterThan(-1);
    expect(candidateStop).toBeGreaterThan(candidateStart);
    expect(normalReadiness).toBeGreaterThan(candidateStop);
    expect(readinessPhase).toBeGreaterThan(candidateStop);
    expect(rollout).toContain("readiness_minecraft_started=0");
    expect(rollout).toContain("expected_active_state=active");
  });

  it("retains the fence and masks when an effect is indeterminate during drain", () => {
    expect(rollout).toContain("quiesce_attempted == 1 && runtime_quiesced == 0");
    expect(rollout).toContain("executor effect became active or indeterminate during quiescence");
    expect(rollout).toContain("the attempt journal, runtime masks, and maintenance fence are retained");
    const retained = rollout.indexOf("Runtime quiescence could not be proven");
    const restore = rollout.indexOf('restore_services "$service_state"', retained);
    expect(retained).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(retained);
    expect(rollout.slice(retained, restore)).toContain("return 0");
  });
});
