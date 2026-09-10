import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
export const REVIEWED_SHELL_TOOLCHAIN_MANIFEST = {
  bytes: 2678,
  sha256: "42995aec9022b04e5c11809347acbaa8b7150d9bd0d4da35a95ee3be8c2d312a",
} as const;
export const REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE = {
  path: "/toolchain/bin/sh",
  bytes: 1127576,
  sha256: "a00157aada30be47277accd8f4ee8e93bbc55f3ac9722dd5e7008114d86a21c2",
} as const;
export const REVIEWED_SHELL_TOOLCHAIN_LOCK = {
  path: "/toolchain/build/shell-toolchain-lock.json",
  bytes: 294,
  sha256: "0abf0af10e87923383055304fdd167664e5a2dbab887db491e0c3e34ee5a3ffc",
} as const;

export interface ReviewedShellExecutable {
  name: "sh";
  path: string;
  bytes: number;
  sha256: string;
  mode: "0755";
}

export const REVIEWED_BUSYBOX_APPLETS = [
  "ash",
  "awk",
  "basename",
  "cat",
  "chmod",
  "chown",
  "cmp",
  "cp",
  "cut",
  "date",
  "dd",
  "df",
  "dirname",
  "echo",
  "env",
  "expr",
  "false",
  "find",
  "grep",
  "head",
  "id",
  "kill",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "printenv",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "sh",
  "sleep",
  "sort",
  "stat",
  "tail",
  "tee",
  "test",
  "touch",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "xargs",
] as const;

export interface ReviewedShellToolchainManifest {
  schemaVersion: 1;
  platform: "linux-arm64";
  source: {
    path: string;
    bytes: number;
    sha256: string;
    url: "https://busybox.net/downloads/busybox-1.38.0.tar.bz2";
    signature: {
      path: string;
      bytes: number;
      sha256: string;
      url: "https://busybox.net/downloads/busybox-1.38.0.tar.bz2.sig";
      signerFingerprint: "C9E9416F76E610DBD09D040F47B70C55ACC9965B";
    };
    publicKey: {
      path: string;
      bytes: number;
      sha256: string;
      url: "https://busybox.net/~vda/vda_pubkey.gpg";
    };
    license: "GPL-2.0-only";
  };
  build: {
    version: "1.38.0";
    compiler: "gcc 13.3.0";
    libc: "glibc 2.39";
    binutils: "binutils 2.42";
    configPath: string;
    configBytes: number;
    configSha256: string;
    configFragmentPath: string;
    configFragmentBytes: number;
    configFragmentSha256: string;
    recipePath: string;
    recipeBytes: number;
    recipeSha256: string;
    static: true;
    standaloneApplets: true;
    licenseStatus: "qualified" | "local-disposable-testing-only;-public-distribution-blocked";
    licenseNote: string;
  };
  applets: typeof REVIEWED_BUSYBOX_APPLETS;
  executables: [ReviewedShellExecutable];
}

function object(value: unknown, pathName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${pathName} is invalid.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], pathName: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw new Error(`${pathName} fields are invalid.`);
}

function positiveBytes(value: unknown, pathName: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    throw new Error(`${pathName} size is invalid.`);
  return value as number;
}

function digest(value: unknown, pathName: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${pathName} digest is invalid.`);
  return value;
}

function absoluteNonSymlinkPath(value: unknown, pathName: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value
  )
    throw new Error(`${pathName} path is invalid.`);
  return value;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This parser deliberately rejects every unreviewed field and provenance transition.
export function parseReviewedShellToolchainManifest(value: unknown): ReviewedShellToolchainManifest {
  const manifest = object(value, "shell toolchain manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "platform", "source", "build", "applets", "executables"],
    "shell toolchain manifest"
  );
  if (manifest.schemaVersion !== 1 || manifest.platform !== "linux-arm64")
    throw new Error("Shell toolchain platform is invalid.");
  const source = object(manifest.source, "shell toolchain source");
  exactKeys(source, ["path", "bytes", "sha256", "url", "signature", "publicKey", "license"], "shell toolchain source");
  const sourcePath = absoluteNonSymlinkPath(source.path, "shell toolchain source");
  if (sourcePath !== "/toolchain/src/busybox-1.38.0.tar.bz2")
    throw new Error("Shell toolchain source path is invalid.");
  const sourceBytes = positiveBytes(source.bytes, "shell toolchain source", MAX_SOURCE_BYTES);
  const sourceSha256 = digest(source.sha256, "shell toolchain source");
  if (source.url !== "https://busybox.net/downloads/busybox-1.38.0.tar.bz2" || source.license !== "GPL-2.0-only")
    throw new Error("Shell toolchain source provenance is invalid.");
  const signature = object(source.signature, "shell toolchain signature");
  exactKeys(signature, ["path", "bytes", "sha256", "url", "signerFingerprint"], "shell toolchain signature");
  const signaturePath = absoluteNonSymlinkPath(signature.path, "shell toolchain signature");
  if (signaturePath !== "/toolchain/src/busybox-1.38.0.tar.bz2.sig")
    throw new Error("Shell toolchain signature path is invalid.");
  const signatureBytes = positiveBytes(signature.bytes, "shell toolchain signature", MAX_SOURCE_BYTES);
  const signatureSha256 = digest(signature.sha256, "shell toolchain signature");
  if (
    signature.url !== "https://busybox.net/downloads/busybox-1.38.0.tar.bz2.sig" ||
    signature.signerFingerprint !== "C9E9416F76E610DBD09D040F47B70C55ACC9965B"
  )
    throw new Error("Shell toolchain signature provenance is invalid.");
  const publicKey = object(source.publicKey, "shell toolchain public key");
  exactKeys(publicKey, ["path", "bytes", "sha256", "url"], "shell toolchain public key");
  const publicKeyPath = absoluteNonSymlinkPath(publicKey.path, "shell toolchain public key");
  if (publicKeyPath !== "/toolchain/src/vda_pubkey.gpg") throw new Error("Shell toolchain public key path is invalid.");
  const publicKeyBytes = positiveBytes(publicKey.bytes, "shell toolchain public key", MAX_SOURCE_BYTES);
  const publicKeySha256 = digest(publicKey.sha256, "shell toolchain public key");
  if (publicKey.url !== "https://busybox.net/~vda/vda_pubkey.gpg")
    throw new Error("Shell toolchain public key provenance is invalid.");
  const build = object(manifest.build, "shell toolchain build");
  exactKeys(
    build,
    [
      "version",
      "compiler",
      "libc",
      "binutils",
      "configPath",
      "configBytes",
      "configSha256",
      "configFragmentPath",
      "configFragmentBytes",
      "configFragmentSha256",
      "recipePath",
      "recipeBytes",
      "recipeSha256",
      "static",
      "standaloneApplets",
      "licenseStatus",
      "licenseNote",
    ],
    "shell toolchain build"
  );
  const configPath = absoluteNonSymlinkPath(build.configPath, "shell toolchain build config");
  const configFragmentPath = absoluteNonSymlinkPath(build.configFragmentPath, "shell toolchain config fragment");
  const recipePath = absoluteNonSymlinkPath(build.recipePath, "shell toolchain recipe");
  const licenseStatus = build.licenseStatus;
  const licenseNote = build.licenseNote;
  if (
    build.version !== "1.38.0" ||
    build.compiler !== "gcc 13.3.0" ||
    build.libc !== "glibc 2.39" ||
    build.binutils !== "binutils 2.42" ||
    configPath !== "/toolchain/build/busybox-1.38.0.config" ||
    configFragmentPath !== "/toolchain/build/busybox-1.38.0.config.fragment" ||
    recipePath !== "/toolchain/build/build-shell-toolchain.sh" ||
    build.static !== true ||
    build.standaloneApplets !== true ||
    !["qualified", "local-disposable-testing-only;-public-distribution-blocked"].includes(String(licenseStatus)) ||
    typeof licenseNote !== "string" ||
    licenseNote.length < 1 ||
    (licenseStatus === "local-disposable-testing-only;-public-distribution-blocked" &&
      licenseNote !== "BusyBox source is retained; static glibc corresponding-source obligations are not staged.")
  )
    throw new Error("Shell toolchain build provenance is invalid.");
  const configBytes = positiveBytes(build.configBytes, "shell toolchain build config", MAX_CONFIG_BYTES);
  const configSha256 = digest(build.configSha256, "shell toolchain build config");
  const configFragmentBytes = positiveBytes(
    build.configFragmentBytes,
    "shell toolchain config fragment",
    MAX_CONFIG_BYTES
  );
  const configFragmentSha256 = digest(build.configFragmentSha256, "shell toolchain config fragment");
  const recipeBytes = positiveBytes(build.recipeBytes, "shell toolchain recipe", MAX_CONFIG_BYTES);
  const recipeSha256 = digest(build.recipeSha256, "shell toolchain recipe");
  if (!Array.isArray(manifest.applets) || JSON.stringify(manifest.applets) !== JSON.stringify(REVIEWED_BUSYBOX_APPLETS))
    throw new Error("Shell toolchain applet inventory is invalid.");
  if (!Array.isArray(manifest.executables) || manifest.executables.length !== 1)
    throw new Error("Shell toolchain executable inventory is invalid.");
  const executable = object(manifest.executables[0], "shell toolchain executable");
  exactKeys(executable, ["name", "path", "bytes", "sha256", "mode"], "shell toolchain executable");
  if (executable.name !== "sh" || executable.mode !== "0755") throw new Error("Shell toolchain executable is invalid.");
  const executablePath = absoluteNonSymlinkPath(executable.path, "shell toolchain executable");
  if (executablePath !== "/toolchain/bin/sh")
    throw new Error("Shell toolchain executable is outside its reviewed root.");
  const executableBytes = positiveBytes(executable.bytes, "shell toolchain executable", MAX_SOURCE_BYTES);
  if (typeof executable.sha256 !== "string" || !SHA256.test(executable.sha256))
    throw new Error("Shell toolchain executable digest is invalid.");
  return {
    schemaVersion: 1,
    platform: "linux-arm64",
    source: {
      path: sourcePath,
      bytes: sourceBytes,
      sha256: sourceSha256,
      url: source.url,
      signature: {
        path: signaturePath,
        bytes: signatureBytes,
        sha256: signatureSha256,
        url: signature.url,
        signerFingerprint: signature.signerFingerprint,
      },
      publicKey: { path: publicKeyPath, bytes: publicKeyBytes, sha256: publicKeySha256, url: publicKey.url },
      license: source.license,
    },
    build: {
      version: build.version,
      compiler: build.compiler,
      libc: build.libc,
      binutils: build.binutils,
      configPath,
      configBytes,
      configSha256,
      configFragmentPath,
      configFragmentBytes,
      configFragmentSha256,
      recipePath,
      recipeBytes,
      recipeSha256,
      static: true,
      standaloneApplets: true,
      licenseStatus: licenseStatus as "qualified" | "local-disposable-testing-only;-public-distribution-blocked",
      licenseNote,
    },
    applets: REVIEWED_BUSYBOX_APPLETS,
    executables: [
      { name: "sh", path: executablePath, bytes: executableBytes, sha256: executable.sha256, mode: "0755" },
    ],
  };
}

async function verifiedBytes(
  filePath: string,
  expectedBytes: number,
  expectedSha256: string,
  expectedMode?: number
): Promise<void> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      (expectedMode !== undefined && (metadata.mode & 0o777) !== expectedMode) ||
      metadata.size !== expectedBytes
    )
      throw new Error("Reviewed shell toolchain input failed ownership, mode, type, or size validation.");
    const digest = createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
    if (digest !== expectedSha256) throw new Error("Reviewed shell toolchain input digest mismatch.");
  } finally {
    await handle.close();
  }
}

/** Loads only a root-owned, exact-byte reviewed toolchain. Missing input is intentionally unavailable. */
export async function loadReviewedShellToolchain(
  manifestPath = "/config/shell-toolchain.json"
): Promise<ReviewedShellToolchainManifest> {
  const manifestHandle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: ReviewedShellToolchainManifest;
  try {
    const metadata = await manifestHandle.stat();
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || metadata.size > MAX_MANIFEST_BYTES)
      throw new Error("Reviewed shell toolchain manifest failed ownership, mode, type, or size validation.");
    const manifestBytes = await manifestHandle.readFile();
    if (
      manifestBytes.byteLength !== REVIEWED_SHELL_TOOLCHAIN_MANIFEST.bytes ||
      createHash("sha256").update(manifestBytes).digest("hex") !== REVIEWED_SHELL_TOOLCHAIN_MANIFEST.sha256
    )
      throw new Error("Reviewed shell toolchain manifest is not the repository-pinned artifact.");
    manifest = parseReviewedShellToolchainManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  } finally {
    await manifestHandle.close();
  }
  await verifiedBytes(manifest.source.path, manifest.source.bytes, manifest.source.sha256);
  await verifiedBytes(
    manifest.source.signature.path,
    manifest.source.signature.bytes,
    manifest.source.signature.sha256
  );
  await verifiedBytes(
    manifest.source.publicKey.path,
    manifest.source.publicKey.bytes,
    manifest.source.publicKey.sha256
  );
  await verifiedBytes(manifest.build.configPath, manifest.build.configBytes, manifest.build.configSha256);
  await verifiedBytes(
    manifest.build.configFragmentPath,
    manifest.build.configFragmentBytes,
    manifest.build.configFragmentSha256
  );
  await verifiedBytes(manifest.build.recipePath, manifest.build.recipeBytes, manifest.build.recipeSha256, 0o755);
  await verifiedBytes(
    REVIEWED_SHELL_TOOLCHAIN_LOCK.path,
    REVIEWED_SHELL_TOOLCHAIN_LOCK.bytes,
    REVIEWED_SHELL_TOOLCHAIN_LOCK.sha256
  );
  const executable = manifest.executables[0];
  if (
    executable.path !== REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE.path ||
    executable.bytes !== REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE.bytes ||
    executable.sha256 !== REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE.sha256
  )
    throw new Error("Reviewed shell toolchain executable is not the repository-pinned artifact.");
  await verifiedBytes(executable.path, executable.bytes, executable.sha256, 0o755);
  return manifest;
}
