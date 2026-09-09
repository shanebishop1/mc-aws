#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, link, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(root, "agent-runtime");
const outputRoot = path.join(root, ".local-artifacts", "agent-runtime");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const runtimeManifest = JSON.parse(await readFile(path.join(packageRoot, "runtime-manifest.json"), "utf8"));
const inventoryContract = JSON.parse(await readFile(path.join(packageRoot, "dependency-inventory.json"), "utf8"));
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
const { build } = await import(pathToFileURL(requireFromPackage.resolve("esbuild")));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)])
    );
  }
  return value;
}

async function dependencyInventory(bundleInputs) {
  const piRoot = path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const piPackagePath = path.join(piRoot, "package.json");
  const piPackage = JSON.parse(await readFile(piPackagePath, "utf8"));
  const shrinkwrapBytes = await readFile(path.join(piRoot, "npm-shrinkwrap.json"));
  const shrinkwrap = JSON.parse(shrinkwrapBytes);
  if (piPackage.version !== runtimeManifest.pi.version || piPackage.license !== "MIT")
    throw new Error("Pi version or MIT license drifted.");
  if (sha256(shrinkwrapBytes) !== inventoryContract.piPublishedShrinkwrap.sha256)
    throw new Error("Pi published shrinkwrap drifted.");
  if (JSON.stringify(packageJson.dependencies) !== JSON.stringify(inventoryContract.productionDirectDependencies)) {
    throw new Error("Runtime production dependency inventory drifted.");
  }
  const packages = Object.entries(shrinkwrap.packages)
    .map(([locator, item]) => {
      const name =
        item.name ??
        locator
          .replace(/^node_modules\//, "")
          .split("/node_modules/")
          .at(-1);
      if (!name || !item.version || !item.license) throw new Error(`Incomplete dependency inventory entry: ${locator}`);
      return {
        locator: locator || ".",
        name,
        version: item.version,
        license: item.license,
        ...(item.integrity ? { integrity: item.integrity } : {}),
      };
    })
    .sort((left, right) => left.locator.localeCompare(right.locator));
  if (packages.length !== inventoryContract.piPublishedShrinkwrap.packageEntries)
    throw new Error("Pi dependency count drifted.");
  const licenses = [...new Set(packages.map((item) => item.license))].sort();
  if (JSON.stringify(licenses) !== JSON.stringify(inventoryContract.piPublishedShrinkwrap.licenses))
    throw new Error("Pi license inventory drifted.");
  const bundled = new Map();
  for (const input of Object.keys(bundleInputs)) {
    const marker = "/node_modules/";
    const normalized = input.replaceAll("\\", "/");
    const index = normalized.lastIndexOf(marker);
    if (index < 0) continue;
    const remainder = normalized.slice(index + marker.length);
    const parts = remainder.split("/");
    const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    const packageDirectory = path.resolve(root, normalized.slice(0, index + marker.length), name);
    const metadata = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
    if (typeof metadata.version !== "string" || typeof metadata.license !== "string") {
      throw new Error(`Bundled package metadata is incomplete: ${name}`);
    }
    bundled.set(`${metadata.name}@${metadata.version}`, {
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
    });
  }
  return {
    schemaVersion: 1,
    generatedFrom: "exact esbuild inputs plus Pi 0.84.4 published npm-shrinkwrap.json",
    bundledPackages: [...bundled.values()].sort((left, right) => left.name.localeCompare(right.name)),
    piPublishedPackages: packages,
  };
}

async function buildStage(stage) {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const buildResult = await build({
    absWorkingDir: root,
    entryPoints: {
      "gateway-cli": "agent-runtime/src/gateway-cli.ts",
      "executor-cli": "agent-runtime/src/executor-cli.ts",
      "shell-runner-cli": "agent-runtime/src/shell-runner-cli.ts",
    },
    outdir: stage,
    outExtension: { ".js": ".mjs" },
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22.19",
    treeShaking: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    banner: {
      js: 'import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);',
    },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".wasm": "file", ".png": "file" },
    metafile: true,
  });
  for (const name of ["gateway-cli.mjs", "executor-cli.mjs", "shell-runner-cli.mjs"])
    await chmod(path.join(stage, name), 0o755);
  await cp(path.join(root, "examples/agent-extensions/status-report"), path.join(stage, "extensions/status-report"), {
    recursive: true,
  });
  await writeFile(
    path.join(stage, "dependency-inventory.json"),
    `${JSON.stringify(stable(await dependencyInventory(buildResult.metafile.inputs)), null, 2)}\n`,
    { mode: 0o644 }
  );
  await cp(path.join(packageRoot, "runtime-manifest.json"), path.join(stage, "runtime-manifest.json"));
  const files = execFileSync(
    "python3",
    [
      "-c",
      "import os,sys; root=sys.argv[1]; print('\\n'.join(sorted(os.path.relpath(os.path.join(d,n),root).replace(os.sep,'/') for d,ds,fs in os.walk(root) for n in fs)))",
      stage,
    ],
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (files.length > runtimeManifest.runtime.maxFiles) throw new Error("Runtime package file count exceeded.");
  const manifestFiles = [];
  let expandedBytes = 0;
  for (const relative of files) {
    if (
      relative.startsWith(".") ||
      relative.includes("..") ||
      /(?:^|\/)(?:tests?|docs?|research|secrets?|\.agents)(?:\/|$)/i.test(relative)
    )
      throw new Error(`Forbidden runtime artifact path: ${relative}`);
    const bytes = await readFile(path.join(stage, relative));
    expandedBytes += bytes.byteLength;
    manifestFiles.push({
      path: relative,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      mode: relative.endsWith("-cli.mjs") ? "0755" : "0644",
    });
  }
  if (expandedBytes > runtimeManifest.runtime.maxExpandedBytes) throw new Error("Runtime expanded size exceeded.");
  await writeFile(
    path.join(stage, "bundle-manifest.json"),
    `${JSON.stringify(stable({ schemaVersion: 1, nodeVersion: runtimeManifest.node.version, piVersion: runtimeManifest.pi.version, files: manifestFiles }), null, 2)}\n`,
    { mode: 0o644 }
  );
}

async function archiveStage(stage, archivePath) {
  const manifestBytes = await readFile(path.join(stage, "bundle-manifest.json"));
  execFileSync("python3", [
    "-c",
    `import os,stat,sys,zipfile
root,output=sys.argv[1:]
with zipfile.ZipFile(output,"w",compression=zipfile.ZIP_STORED) as archive:
  for current,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    for name in dirs+files:
      source=os.path.join(current,name); mode=os.lstat(source).st_mode
      if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)): raise SystemExit("unsafe runtime stage entry")
    for name in files:
      source=os.path.join(current,name); relative=os.path.relpath(source,root).replace(os.sep,"/")
      info=zipfile.ZipInfo(relative,(2020,1,1,0,0,0)); info.create_system=3
      info.external_attr=((0o100755 if relative.endswith("-cli.mjs") else 0o100644)&0xffff)<<16
      with open(source,"rb") as item: archive.writestr(info,item.read())`,
    stage,
    archivePath,
  ]);
  const bytes = await readFile(archivePath);
  if (bytes.byteLength > runtimeManifest.runtime.maxArchiveBytes) throw new Error("Runtime archive size exceeded.");
  return {
    bytes,
    digest: sha256(bytes),
    manifestSha256: sha256(manifestBytes),
    manifestBytes: manifestBytes.byteLength,
  };
}

async function validatePublishedArchive(archive, expected) {
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (sha256(bytes) !== expected.digest || !bytes.equals(expected.bytes)) {
    throw new Error(`Existing runtime archive failed content validation: ${archive}`);
  }
  return true;
}

async function publishArchive(temporary, archive, expected) {
  const temporaryHandle = await open(temporary, "r");
  try {
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  while (true) {
    try {
      await link(temporary, archive);
      const outputHandle = await open(path.dirname(archive), "r");
      try {
        await outputHandle.sync();
      } finally {
        await outputHandle.close();
      }
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (await validatePublishedArchive(archive, expected)) return;
  }
}

async function packageOnce() {
  const work = await mkdtemp(path.join(outputRoot, ".staging-"));
  await chmod(work, 0o700);
  try {
    const stage = path.join(work, "stage");
    await buildStage(stage);
    const temporary = path.join(work, "runtime.zip");
    const result = await archiveStage(stage, temporary);
    const archive = path.join(outputRoot, `${result.digest}.zip`);
    await publishArchive(temporary, archive, result);
    return { ...result, archive };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (!["build", "package", "check"].includes(command) || process.argv.length !== 3)
  throw new Error("Usage: build-agent-runtime.mjs <build|package|check>");
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const first = await packageOnce();
if (command === "check") {
  const second = await packageOnce();
  if (first.digest !== second.digest || !first.bytes.equals(second.bytes))
    throw new Error("Runtime package is not reproducible.");
}
if (command === "build") {
  await rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
}
process.stdout.write(
  `${JSON.stringify({ archive: first.archive, sha256: first.digest, bytes: first.bytes.byteLength, manifestSha256: first.manifestSha256, manifestBytes: first.manifestBytes })}\n`
);
