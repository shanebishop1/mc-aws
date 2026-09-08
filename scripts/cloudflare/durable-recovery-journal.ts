import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export type DurableJournalOperation = "write-temp" | "fsync-temp" | "rename" | "fsync-parent";
export type DurableJournalOperationHook = (operation: DurableJournalOperation) => void;

const privateMode = 0o700;
const fileMode = 0o600;

const fsyncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const assertPrivateDirectory = (directory: string): void => {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing unsafe recovery state directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Recovery state directory owner mismatch: ${directory}`);
  }
};

/** Create and durably publish an owner-only recovery directory. */
export const ensurePrivateRecoveryDirectory = (directory: string): void => {
  const resolved = path.resolve(directory);
  const existed = (() => {
    try {
      lstatSync(resolved);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  })();
  mkdirSync(resolved, { mode: privateMode, recursive: true });
  assertPrivateDirectory(resolved);
  // Re-assert the private mode before publishing any journal below it.
  const descriptor = openSync(resolved, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fchmodSync(descriptor, privateMode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (!existed) fsyncDirectory(path.dirname(resolved));
};

const failAfter = (operation: DurableJournalOperation, hook?: DurableJournalOperationHook): void => {
  hook?.(operation);
  if (process.env.MC_AWS_DURABLE_JOURNAL_FAIL_AFTER === operation) {
    throw new Error(`Injected durable journal power loss after ${operation}`);
  }
};

const writeAll = (descriptor: number, contents: Buffer): void => {
  let offset = 0;
  while (offset < contents.length) offset += writeSync(descriptor, contents, offset);
};

const cleanupOrphanedTemporaryFiles = (filePath: string): void => {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.tmp.`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const temporary = path.join(directory, entry);
    const stat = lstatSync(temporary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error(`Refusing unsafe recovery journal temporary file: ${temporary}`);
    }
    rmSync(temporary);
  }
};

/**
 * Publish one complete recovery record. The ordering is deliberately strict:
 * write, fsync the temporary inode, atomic rename, then fsync its directory.
 * A caller may inject a failure after any boundary to model power loss.
 */
export const durableReplaceFile = (
  filePath: string,
  contents: string,
  options: { mode?: number; onOperation?: DurableJournalOperationHook } = {}
): void => {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  ensurePrivateRecoveryDirectory(directory);
  cleanupOrphanedTemporaryFiles(resolved);
  const temporary = `${resolved}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    options.mode ?? fileMode
  );
  try {
    fchmodSync(descriptor, options.mode ?? fileMode);
    writeAll(descriptor, Buffer.from(contents, "utf8"));
    failAfter("write-temp", options.onOperation);
    fsyncSync(descriptor);
    failAfter("fsync-temp", options.onOperation);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, resolved);
  failAfter("rename", options.onOperation);
  fsyncDirectory(directory);
  failAfter("fsync-parent", options.onOperation);
};

/** Atomically move a completed journal to history and durably publish the move. */
export const durableRenameFile = (
  source: string,
  destination: string,
  options: { onOperation?: DurableJournalOperationHook } = {}
): void => {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  ensurePrivateRecoveryDirectory(path.dirname(resolvedDestination));
  renameSync(resolvedSource, resolvedDestination);
  failAfter("rename", options.onOperation);
  fsyncDirectory(path.dirname(resolvedDestination));
  failAfter("fsync-parent", options.onOperation);
  if (path.dirname(resolvedSource) !== path.dirname(resolvedDestination)) fsyncDirectory(path.dirname(resolvedSource));
};
