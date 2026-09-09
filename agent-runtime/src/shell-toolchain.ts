import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export interface ReviewedShellExecutable {
  name: "sh";
  path: string;
  bytes: number;
  sha256: string;
  mode: "0755";
}

export interface ReviewedShellToolchainManifest {
  schemaVersion: 1;
  platform: "linux-arm64";
  source: { path: string; bytes: number; sha256: string };
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

export function parseReviewedShellToolchainManifest(value: unknown): ReviewedShellToolchainManifest {
  const manifest = object(value, "shell toolchain manifest");
  exactKeys(manifest, ["schemaVersion", "platform", "source", "executables"], "shell toolchain manifest");
  if (manifest.schemaVersion !== 1 || manifest.platform !== "linux-arm64")
    throw new Error("Shell toolchain platform is invalid.");
  const source = object(manifest.source, "shell toolchain source");
  exactKeys(source, ["path", "bytes", "sha256"], "shell toolchain source");
  const sourcePath = absoluteNonSymlinkPath(source.path, "shell toolchain source");
  if (!sourcePath.startsWith("/toolchain/")) throw new Error("Shell toolchain source is outside its reviewed root.");
  const sourceBytes = positiveBytes(source.bytes, "shell toolchain source", MAX_SOURCE_BYTES);
  if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256))
    throw new Error("Shell toolchain source digest is invalid.");
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
    source: { path: sourcePath, bytes: sourceBytes, sha256: source.sha256 },
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
    manifest = parseReviewedShellToolchainManifest(
      JSON.parse((await manifestHandle.readFile()).toString("utf8")) as unknown
    );
  } finally {
    await manifestHandle.close();
  }
  await verifiedBytes(manifest.source.path, manifest.source.bytes, manifest.source.sha256);
  const executable = manifest.executables[0];
  await verifiedBytes(executable.path, executable.bytes, executable.sha256, 0o755);
  return manifest;
}
