import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { assertProviderCredentialName } from "./gateway-config";

const MAX_CREDENTIAL_BYTES = 256 * 1024;
const CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const EXECUTOR_JOURNAL_CREDENTIAL_NAME = "executor-journal-hmac" as const;
export const EXECUTOR_RECEIPT_CREDENTIAL_NAME = "executor-receipt-private" as const;
export const EXECUTOR_EPOCH_CREDENTIAL_NAME = "executor-clean-start-epoch" as const;
export const EXECUTOR_CREDENTIAL_DIRECTORY = "/run/credentials/mc-agent-executor.service" as const;
export const EXECUTOR_JOURNAL_CREDENTIAL_PATH =
  `${EXECUTOR_CREDENTIAL_DIRECTORY}/${EXECUTOR_JOURNAL_CREDENTIAL_NAME}` as const;
export const EXECUTOR_RECEIPT_CREDENTIAL_PATH =
  `${EXECUTOR_CREDENTIAL_DIRECTORY}/${EXECUTOR_RECEIPT_CREDENTIAL_NAME}` as const;
export const EXECUTOR_EPOCH_CREDENTIAL_PATH =
  `${EXECUTOR_CREDENTIAL_DIRECTORY}/${EXECUTOR_EPOCH_CREDENTIAL_NAME}` as const;
const EXECUTOR_CREDENTIAL_NAMES = [
  EXECUTOR_EPOCH_CREDENTIAL_NAME,
  EXECUTOR_JOURNAL_CREDENTIAL_NAME,
  EXECUTOR_RECEIPT_CREDENTIAL_NAME,
] as const;

export interface ProtectedSystemdCredential {
  path: string;
  value: Buffer;
}

export async function readProtectedFile(filePath: string, maxBytes = MAX_CREDENTIAL_BYTES): Promise<string> {
  if (!path.isAbsolute(filePath) || maxBytes < 1 || maxBytes > MAX_CREDENTIAL_BYTES) {
    throw new TypeError("Protected input path or size is invalid.");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxBytes || (metadata.mode & 0o077) !== 0) {
      throw new Error("Protected input failed ownership, mode, type, or size validation.");
    }
    if (metadata.uid !== 0 && metadata.uid !== process.getuid?.()) {
      throw new Error("Protected input has an unexpected owner.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readProtectedBytes(filePath: string, expectedBytes: number): Promise<Buffer> {
  if (!path.isAbsolute(filePath) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 4096) {
    throw new TypeError("Protected binary input path or size is invalid.");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== expectedBytes ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.uid !== 0 && metadata.uid !== process.getuid?.())
    ) {
      throw new Error("Protected binary input failed ownership, mode, type, or size validation.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function systemdCredentialPath(name: string): string {
  if (!CREDENTIAL_NAME.test(name)) throw new TypeError("Systemd credential name is invalid.");
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error("Systemd credentials are unavailable.");
  return path.join(directory, name);
}

async function openExactCredentialDirectory(directory: string, name: string) {
  if (!path.isAbsolute(directory) || !CREDENTIAL_NAME.test(name)) {
    throw new TypeError("Systemd credential directory or name is invalid.");
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      entries.length !== 1 ||
      entries[0]?.name !== name ||
      !entries[0].isFile()
    ) {
      throw new Error("Systemd credential namespace contains an unexpected credential.");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openExecutorCredentialDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    const names = entries.map(({ name }) => name).sort();
    if (
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      names.join("\0") !== [...EXECUTOR_CREDENTIAL_NAMES].sort().join("\0") ||
      entries.some((entry) => !entry.isFile())
    ) {
      throw new Error("Executor systemd credential namespace is invalid.");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read one systemd credential only after proving its directory contains no other credential. */
export async function readExactSystemdCredential(
  name: string,
  expectedBytes: number,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<ProtectedSystemdCredential> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 4096) {
    throw new TypeError("Protected binary input path or size is invalid.");
  }
  const directory = environment.CREDENTIALS_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error("Systemd credentials are unavailable.");
  const directoryHandle = await openExactCredentialDirectory(directory, name);
  try {
    const credentialPath = path.join(directory, name);
    const handle = await open(`/proc/self/fd/${directoryHandle.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size !== expectedBytes ||
        (metadata.mode & 0o077) !== 0 ||
        (metadata.uid !== 0 && metadata.uid !== process.getuid?.())
      ) {
        throw new Error("Protected binary input failed ownership, mode, type, or size validation.");
      }
      return { path: credentialPath, value: await handle.readFile() };
    } finally {
      await handle.close();
    }
  } finally {
    await directoryHandle.close();
  }
}

/** The executor may consume only its one unit-scoped journal credential. */
export async function readExecutorJournalAuthenticationKey(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<ProtectedSystemdCredential> {
  if (environment.CREDENTIALS_DIRECTORY !== EXECUTOR_CREDENTIAL_DIRECTORY) {
    throw new Error("Executor systemd credentials are unavailable.");
  }
  const credential = await readExactSystemdCredential(EXECUTOR_JOURNAL_CREDENTIAL_NAME, 32, environment);
  if (credential.path !== EXECUTOR_JOURNAL_CREDENTIAL_PATH) {
    credential.value.fill(0);
    throw new Error("Executor journal credential path is invalid.");
  }
  return credential;
}

export interface ExecutorProtectedCredentials {
  journal: ProtectedSystemdCredential;
  receiptPrivateKey: ProtectedSystemdCredential;
  cleanStartEpoch: ProtectedSystemdCredential;
}

/** Reads the exact executor-only credential set after rejecting every unexpected credential. */
export async function readExecutorProtectedCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<ExecutorProtectedCredentials> {
  if (environment.CREDENTIALS_DIRECTORY !== EXECUTOR_CREDENTIAL_DIRECTORY) {
    throw new Error("Executor systemd credentials are unavailable.");
  }
  const directory = await openExecutorCredentialDirectory(EXECUTOR_CREDENTIAL_DIRECTORY);
  try {
    const read = async (name: string, minimum: number, maximum: number): Promise<ProtectedSystemdCredential> => {
      const credentialPath = path.join(EXECUTOR_CREDENTIAL_DIRECTORY, name);
      const handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.size < minimum ||
          metadata.size > maximum ||
          (metadata.mode & 0o077) !== 0 ||
          (metadata.uid !== 0 && metadata.uid !== process.getuid?.())
        ) {
          throw new Error("Executor credential failed ownership, mode, type, or size validation.");
        }
        return { path: credentialPath, value: await handle.readFile() };
      } finally {
        await handle.close();
      }
    };
    return {
      journal: await read(EXECUTOR_JOURNAL_CREDENTIAL_NAME, 32, 32),
      receiptPrivateKey: await read(EXECUTOR_RECEIPT_CREDENTIAL_NAME, 64, 1024),
      cleanStartEpoch: await read(EXECUTOR_EPOCH_CREDENTIAL_NAME, 32, 32),
    };
  } finally {
    await directory.close();
  }
}

export async function assertExecutorJournalCredentialNamespace(): Promise<void> {
  if (process.env.CREDENTIALS_DIRECTORY !== EXECUTOR_CREDENTIAL_DIRECTORY) {
    throw new Error("Executor systemd credentials are unavailable.");
  }
  const executorCredentials = await openExecutorCredentialDirectory(EXECUTOR_CREDENTIAL_DIRECTORY);
  await executorCredentials.close();
  const credentialsRoot = await open(
    "/run/credentials",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const entries = await readdir(`/proc/self/fd/${credentialsRoot.fd}`, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      entries[0]?.name !== path.basename(EXECUTOR_CREDENTIAL_DIRECTORY) ||
      !entries[0].isDirectory()
    ) {
      throw new Error("Systemd credential namespace contains an unexpected credential directory.");
    }
  } finally {
    await credentialsRoot.close();
  }
}

export function providerSystemdCredentialPath(name: string, configuredNames: readonly string[]): string {
  assertProviderCredentialName(name);
  if (!configuredNames.includes(name)) throw new Error("Provider credential is not configured.");
  return systemdCredentialPath(name);
}

export async function assertProtectedConfig(filePath: string): Promise<void> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error("Runtime configuration must be a root-owned, non-writable regular file.");
    }
  } finally {
    await handle.close();
  }
}
