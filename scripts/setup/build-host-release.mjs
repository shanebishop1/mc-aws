#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, link, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(root, "infra/src/ec2");
const outputRoot = path.join(root, ".local-artifacts", "host-release");
const runtimeBuilder = path.join(root, "scripts/setup/build-agent-runtime.mjs");
const bootstrapPinsPath = path.join(root, "config/bootstrap-pins.json");

// These are the complete host-side contract.  Keep this list explicit: adding a
// file to infra/src/ec2 must never silently add an unreviewed executable to a
// release installed on an existing host.
const hostFiles = [
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
  "host-operation-contract.json",
  "mc-agent-gateway.json",
  "mc-agent-executor.json",
  "mc-agent-runtime.tmpfiles",
  "mc-agent-gateway.service",
  "mc-agent-executor.service",
  "mc-agent-executor.socket",
  "mc-agent-world-roots.service",
  "mc-maintenance-recovery.service",
  "minecraft.service",
  "minecraft-dns.service",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bootstrapPinsSource = JSON.parse(await readFile(bootstrapPinsPath, "utf8"));
const bootstrapArtifactNames = ["paper", "rclone", "nodeArm64", "mcstatus", "asyncioDgram", "dnspython"];
if (
  bootstrapPinsSource.schemaVersion !== 1 ||
  typeof bootstrapPinsSource.reviewedAt !== "string" ||
  !bootstrapPinsSource.artifacts ||
  Object.keys(bootstrapPinsSource.artifacts).sort().join(",") !== bootstrapArtifactNames.slice().sort().join(",")
) {
  throw new Error("Canonical bootstrap pin manifest is incomplete");
}
for (const name of bootstrapArtifactNames) {
  const artifact = bootstrapPinsSource.artifacts[name];
  if (
    !artifact ||
    typeof artifact !== "object" ||
    typeof artifact.version !== "string" ||
    typeof artifact.url !== "string" ||
    typeof artifact.sha256 !== "string" ||
    typeof artifact.checksumSource !== "string"
  ) {
    throw new Error(`Canonical bootstrap pin manifest has an invalid ${name} artifact`);
  }
}
const bootstrapPins = {
  schemaVersion: bootstrapPinsSource.schemaVersion,
  reviewedAt: bootstrapPinsSource.reviewedAt,
  artifacts: Object.fromEntries(
    bootstrapArtifactNames.map((name) => {
      const artifact = bootstrapPinsSource.artifacts[name];
      return [
        name,
        name === "paper"
          ? {
              version: artifact.version,
              url: artifact.url,
              sha256: artifact.sha256,
              checksumSource: artifact.checksumSource,
              minecraftVersion: artifact.minecraftVersion,
              build: artifact.build,
            }
          : {
              version: artifact.version,
              url: artifact.url,
              sha256: artifact.sha256,
              checksumSource: artifact.checksumSource,
            },
      ];
    })
  ),
};
const exactVersionPattern = /^\d+\.\d+(?:\.\d+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
for (const [name, artifact] of Object.entries(bootstrapPins.artifacts)) {
  const expectedKeys =
    name === "paper"
      ? ["build", "checksumSource", "minecraftVersion", "sha256", "url", "version"]
      : ["checksumSource", "sha256", "url", "version"];
  if (
    Object.keys(artifact).sort().join(",") !== expectedKeys.join(",") ||
    !exactVersionPattern.test(artifact.version) ||
    !sha256Pattern.test(artifact.sha256) ||
    !artifact.url.startsWith("https://") ||
    !artifact.checksumSource.startsWith("https://")
  ) {
    throw new Error(`Canonical bootstrap pin manifest has invalid ${name} pin values`);
  }
}
const paper = bootstrapPins.artifacts.paper;
if (
  paper.version !== paper.minecraftVersion ||
  !exactVersionPattern.test(paper.minecraftVersion) ||
  !Number.isSafeInteger(paper.build) ||
  paper.build <= 0 ||
  !paper.url.includes(`/objects/${paper.sha256}/paper-${paper.minecraftVersion}-${paper.build}.jar`)
) {
  throw new Error("Canonical bootstrap pin manifest has an invalid Paper pin");
}
const expectedBootstrapUrlFragments = {
  rclone: `/v${bootstrapPins.artifacts.rclone.version}/rclone-v${bootstrapPins.artifacts.rclone.version}-linux-arm64.zip`,
  nodeArm64: `/v${bootstrapPins.artifacts.nodeArm64.version}/node-v${bootstrapPins.artifacts.nodeArm64.version}-linux-arm64.tar.xz`,
  mcstatus: `/mcstatus-${bootstrapPins.artifacts.mcstatus.version}-py3-none-any.whl`,
  asyncioDgram: `/asyncio_dgram-${bootstrapPins.artifacts.asyncioDgram.version}-py3-none-any.whl`,
  dnspython: `/dnspython-${bootstrapPins.artifacts.dnspython.version}-py3-none-any.whl`,
};
for (const [name, fragment] of Object.entries(expectedBootstrapUrlFragments)) {
  if (!bootstrapPins.artifacts[name].url.endsWith(fragment))
    throw new Error(`Canonical bootstrap ${name} URL pin is invalid`);
}
const bootstrapPinsSha256 = sha256(Buffer.from(JSON.stringify(bootstrapPins)));
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)])
    );
  return value;
};

async function fsyncPath(value) {
  const handle = await open(value, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function destination(name) {
  if (name === "host-operation-contract.json") return "/etc/mc-agent/host-operation-contract.json";
  if (name === "mc-agent-gateway.json") return "/etc/mc-agent/world-roots-current/gateway.json";
  if (name === "mc-agent-executor.json") return "/etc/mc-agent/world-roots-current/executor.json";
  if (name === "mc-agent-runtime.tmpfiles") return "/usr/lib/tmpfiles.d/mc-agent.conf";
  if (name === "mc-aws-maintenance-generator") return "/usr/lib/systemd/system-generators/mc-aws-maintenance-generator";
  if (name.endsWith(".service") || name.endsWith(".socket")) return `/etc/systemd/system/${name}`;
  return `/usr/local/bin/${name}`;
}

let runtimeBuild = JSON.parse(
  execFileSync(process.execPath, [runtimeBuilder, "package"], { cwd: root, encoding: "utf8" })
);
// A concurrent local package check may remove and republish the same
// content-addressed archive between the child process and this staging copy.
// Re-obtain the immutable result rather than copying a partially observed path.
try {
  await stat(runtimeBuild.archive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  runtimeBuild = JSON.parse(
    execFileSync(process.execPath, [runtimeBuilder, "package"], { cwd: root, encoding: "utf8" })
  );
}
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const work = await mkdtemp(path.join(outputRoot, ".staging-"));
try {
  const stage = path.join(work, "release");
  await mkdir(path.join(stage, "host"), { recursive: true, mode: 0o700 });
  await cp(runtimeBuild.archive, path.join(stage, "agent-runtime.zip"));
  const files = [];
  for (const name of hostFiles) {
    const source = path.join(sourceRoot, name);
    const bytes = await readFile(source);
    const mode = (await stat(source)).mode & 0o111 ? "0755" : "0644";
    const relative = `host/${name}`;
    await cp(source, path.join(stage, relative));
    files.push({
      path: relative,
      destination: destination(name),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      mode,
    });
  }
  const agentRuntimeBytes = await readFile(path.join(stage, "agent-runtime.zip"));
  const manifest = stable({
    schemaVersion: 1,
    release: "mc-aws-host-runtime",
    releaseVersion: 1,
    bootstrapPins: {
      manifest: bootstrapPins,
      sha256: bootstrapPinsSha256,
    },
    files,
    agentRuntime: {
      path: "agent-runtime.zip",
      bytes: agentRuntimeBytes.byteLength,
      sha256: sha256(agentRuntimeBytes),
      bundleManifestSha256: runtimeBuild.manifestSha256,
      bundleManifestBytes: runtimeBuild.manifestBytes,
    },
  });
  await writeFile(path.join(stage, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const archivePath = path.join(work, "host-release.zip");
  execFileSync("python3", [
    "-c",
    `import os,stat,sys,zipfile
root,out=sys.argv[1:]
with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_STORED) as z:
  for current,dirs,names in os.walk(root):
    dirs.sort(); names.sort()
    for name in names:
      source=os.path.join(current,name); rel=os.path.relpath(source,root).replace(os.sep,"/")
      info=zipfile.ZipInfo(rel,(2020,1,1,0,0,0)); info.create_system=3
      info.external_attr=((0o100755 if stat.S_IXUSR & os.stat(source).st_mode else 0o100644)&0xffff)<<16
      with open(source,"rb") as item: z.writestr(info,item.read())`,
    stage,
    archivePath,
  ]);
  const archiveBytes = await readFile(archivePath);
  const result = {
    archive: path.join(outputRoot, `${sha256(archiveBytes)}.zip`),
    sha256: sha256(archiveBytes),
    bytes: archiveBytes.byteLength,
    releaseManifestSha256: sha256(await readFile(path.join(stage, "release-manifest.json"))),
    releaseManifestBytes: (await readFile(path.join(stage, "release-manifest.json"))).byteLength,
    agentRuntimeSha256: runtimeBuild.sha256,
    agentRuntimeBytes: runtimeBuild.bytes,
    agentRuntimeManifestSha256: runtimeBuild.manifestSha256,
    agentRuntimeManifestBytes: runtimeBuild.manifestBytes,
  };
  await chmod(archivePath, 0o600);
  await fsyncPath(archivePath);
  try {
    // A hard-link publication exposes either no digest path or the complete,
    // already-synced archive; readers can never observe an in-progress write.
    await link(archivePath, result.archive);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(result.archive);
    if (!existing.equals(archiveBytes)) throw new Error("Existing host release failed content validation");
  }
  await fsyncPath(outputRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
