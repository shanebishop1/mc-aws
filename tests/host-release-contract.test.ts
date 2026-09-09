import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapPinsFingerprint, validateBootstrapPins } from "../lib/bootstrap-pins";

const root = process.cwd();
const builder = path.join(root, "scripts/setup/build-host-release.mjs");
const builderSource = readFileSync(builder, "utf8");
const installer = readFileSync(path.join(root, "infra/src/ec2/mc-profile-install.sh"), "utf8");
const pins = validateBootstrapPins(JSON.parse(readFileSync(path.join(root, "config/bootstrap-pins.json"), "utf8")));
const required = [
  "check-mc-idle.sh",
  "mc-rclone-config.sh",
  "mc-backup.sh",
  "mc-restore.sh",
  "mc-hibernate.sh",
  "mc-resume.sh",
  "mc-wait-ready.sh",
  "mc-runtime-rollout.sh",
  "mc-profile-install.sh",
  "mc-stop.sh",
  "update-dns.sh",
  "mc-agent-install.sh",
  "mc-agent-world-roots.py",
  "mc-release-journal.py",
  "mc-maintenance-boot.py",
  "mc-aws-maintenance-generator",
  "mc-backup-auth.py",
  "mc-host-operation.py",
  "mc-agent-host-broker.py",
  "mc-agent-workspace-dac.py",
  "host-operation-contract.json",
  "mc-agent-gateway.json",
  "mc-agent-executor.json",
  "mc-agent-gateway.service",
  "mc-agent-executor.service",
  "mc-agent-executor.socket",
  "mc-agent-tool-read.service",
  "mc-agent-tool-read.socket",
  "mc-agent-tool-write.service",
  "mc-agent-tool-write.socket",
  "mc-agent-host-broker.service",
  "mc-agent-host-broker.socket",
  "mc-agent-world-roots.service",
  "mc-maintenance-recovery.service",
  "mc-agent-runtime.tmpfiles",
  "minecraft.service",
  "minecraft-dns.service",
];

describe("single host release contract", () => {
  it("publishes every cooperating asset in one deterministic, member-hashed release", () => {
    const output = JSON.parse(execFileSync(process.execPath, [builder, "package"], { cwd: root, encoding: "utf8" }));
    const listing = execFileSync(
      "python3",
      ["-c", "import sys,zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", output.archive],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n");
    const releaseManifest = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read('release-manifest.json').decode())",
          output.archive,
        ],
        { encoding: "utf8" }
      )
    );
    expect(releaseManifest.bootstrapPins.sha256).toBe(bootstrapPinsFingerprint(pins));
    expect(releaseManifest.bootstrapPins.manifest).toEqual(pins);
    expect(listing).toContain("release-manifest.json");
    expect(listing).toContain("agent-runtime.zip");
    for (const name of required) expect(listing).toContain(`host/${name}`);
    expect(output.releaseManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.releaseManifestBytes).toBeGreaterThan(0);
    expect(releaseManifest.files).toHaveLength(required.length);
    expect(
      spawnSync("python3", [
        "-c",
        `import hashlib,json,sys,zipfile
z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read('release-manifest.json'))
for item in m['files']:
  b=z.read(item['path'])
  assert len(b)==item['bytes'] and hashlib.sha256(b).hexdigest()==item['sha256']
a=z.read(m['agentRuntime']['path']); assert len(a)==m['agentRuntime']['bytes'] and hashlib.sha256(a).hexdigest()==m['agentRuntime']['sha256']`,
        output.archive,
      ]).status
    ).toBe(0);
  }, 240_000);

  it("keeps the fresh bootstrap inventory at the complete 37-member contract", () => {
    const output = JSON.parse(execFileSync(process.execPath, [builder, "package"], { cwd: root, encoding: "utf8" }));
    const manifest = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read('release-manifest.json').decode())",
          output.archive,
        ],
        { encoding: "utf8" }
      )
    );
    expect(manifest.files).toHaveLength(37);
    expect(manifest.bootstrapPins.manifest.artifacts.paper.minecraftVersion).toBe(
      pins.artifacts.paper.minecraftVersion
    );
    expect(new Set(manifest.files.map((item: { destination: string }) => item.destination)).size).toBe(37);
  }, 240_000);

  it("fails closed for omitted, stale, or digest-mismatched members and partial activation", () => {
    expect(installer).toContain("host release contains an omitted or unmanifested script");
    expect(installer).toContain("host release member digest or size mismatch");
    expect(installer).toContain("release manifest digest or size mismatch");
    expect(installer).toContain("Host release activation failed; every cooperating member was rolled back");
    expect(installer).toContain('release_members="$release_rollback/release-members"');
    expect(installer).toContain(".runtime-rollback");
    expect(installer).toContain(
      "systemctl mask --runtime mc-agent-world-roots.service mc-agent-gateway.service mc-agent-tool-read.socket mc-agent-tool-read.service mc-agent-tool-write.socket mc-agent-tool-write.service mc-agent-executor.socket mc-agent-executor.service mc-agent-host-broker.socket mc-agent-host-broker.service minecraft.service minecraft-dns.service"
    );
    expect(installer).toContain("live plugin tree contains a link or special file");
    expect(installer).toContain('entry.name.lower().endswith(".jar")');
    expect(installer).toContain("restore_server_properties_transaction");
    expect(installer).toContain("restore_world_root_transaction");
  });

  it("publishes only an already-synced archive and syncs the output directory", () => {
    expect(builderSource).toContain("await fsyncPath(archivePath)");
    expect(builderSource).toContain("await link(archivePath, result.archive)");
    expect(builderSource).toContain("await fsyncPath(outputRoot)");
    expect(builderSource).not.toContain("writeFile(result.archive, archiveBytes");
  });

  it("keeps activation quiesced on rollback and records exact digest/size evidence on success", () => {
    expect(installer).toContain("release-manifest %s %s");
    expect(installer).toContain("agent-runtime %s %s");
    expect(installer).toContain("trap rollback_release EXIT");
    expect(installer).toContain("trap 'signal_exit 143' TERM");
    expect(installer).toContain("systemctl unmask --runtime");
    expect(installer).toContain("systemctl daemon-reload");
    expect(spawnSync("bash", ["-n", path.join(root, "infra/src/ec2/mc-profile-install.sh")]).status).toBe(0);
  });

  it("requires exact reviewed plugin contents at rollout readiness", () => {
    const rollout = readFileSync(path.join(root, "infra/src/ec2/mc-runtime-rollout.sh"), "utf8");
    expect(rollout).toContain("live plugin tree contains an unreviewed JAR");
    expect(rollout).toContain("relative.parts != (name,)");
    expect(rollout).toContain("name not in expected_destinations");
    expect(spawnSync("bash", ["-n", path.join(root, "infra/src/ec2/mc-runtime-rollout.sh")]).status).toBe(0);
  });

  it("delegates the host transaction to the hash-verified canonical rollout helper", () => {
    const source = readFileSync(path.join(root, "scripts/aws/upgrade-existing-host.ts"), "utf8");
    expect(source).toContain("rolloutHostCommands");
    expect(source).toContain("mc-runtime-rollout.sh");
    expect(source).toContain("--release-root");
    expect(source).toContain("--manifest-file");
    expect(source).not.toContain("rollback_host_release");
    expect(source).not.toContain("mc-agent-install.sh rollback");
    expect(source).toContain('"trap - EXIT HUP INT TERM"');
  });

  it("wraps routine runtime rollout publication and receipt pinning in the canonical lifecycle fence", () => {
    const source = readFileSync(path.join(root, "scripts/aws/upgrade-existing-host.ts"), "utf8");
    const rollout = source.indexOf("function rolloutRuntime");
    const nextWorkflow = source.indexOf("function plan", rollout);
    const routine = source.slice(rollout, nextWorkflow);
    expect(routine).toContain('verifierState === "unchanged"');
    expect(routine).toContain("acquireLifecycleFence");
    expect(routine).toContain("assertLifecycleFenceOwned");
    expect(routine).toContain("releaseLifecycleFence");
    expect(routine).not.toContain("acquireQuiescence");
    expect(routine).not.toContain("/minecraft/server-action");
  });

  it("executes the generated transfer cleanup under set -u", () => {
    const source = readFileSync(path.join(root, "scripts/aws/upgrade-existing-host.ts"), "utf8");
    const cleanup = source.match(/'rm -rf -- "\$release_work"'/)?.[0].slice(1, -1);
    expect(cleanup).toBe('rm -rf -- "$release_work"');
    const result = spawnSync("bash", [
      "-uc",
      `set -euo pipefail; release_work="$(mktemp -d)"; ${cleanup}; test ! -e "$release_work"`,
    ]);
    expect(result.status).toBe(0);
  });

  it("keeps early transfer failure separate from host rollback", () => {
    const source = readFileSync(path.join(root, "scripts/aws/upgrade-existing-host.ts"), "utf8");
    expect(source).toContain("cleanup_transfer()");
    expect(source.indexOf("trap cleanup_transfer EXIT")).toBeLessThan(source.indexOf("mc-runtime-rollout.sh"));
    expect(source).not.toContain("inner_rollout_committed");
  });
});
