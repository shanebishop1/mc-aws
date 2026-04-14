import { randomUUID } from "node:crypto";
import { deleteParameter, getParameter, putParameter } from "@/lib/aws";

const serverActionLockParam = "/minecraft/server-action";
const serverActionDeleteClaimPrefix = "/minecraft/server-action-delete-claim";
const serverActionLockTtlMs = 30 * 60 * 1000;
const serverActions: ReadonlySet<ServerActionType> = new Set([
  "start",
  "stop",
  "resume",
  "hibernate",
  "backup",
  "restore",
]);

export type ServerActionType = "start" | "stop" | "resume" | "hibernate" | "backup" | "restore";

export interface ServerActionLock {
  lockId: string;
  action: ServerActionType;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string;
}

export interface ReleaseServerActionLockOptions {
  action?: ServerActionType;
  ownerEmail?: string;
}

export class ServerActionLockConflictError extends Error {
  existingLock: ServerActionLock | null;

  constructor(existingLock: ServerActionLock | null) {
    super("Another operation is already in progress. Please wait for it to complete.");
    this.name = "ServerActionLockConflictError";
    this.existingLock = existingLock;
  }
}

function parseLock(raw: string | null): ServerActionLock | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<ServerActionLock>;
    if (!parsed.lockId || !parsed.action || !parsed.createdAt || !parsed.expiresAt) {
      return null;
    }

    if (!serverActions.has(parsed.action)) {
      return null;
    }

    const createdAtMs = Date.parse(parsed.createdAt);
    const expiresAtMs = Date.parse(parsed.expiresAt);
    if (Number.isNaN(createdAtMs) || Number.isNaN(expiresAtMs)) {
      return null;
    }

    return {
      lockId: parsed.lockId,
      action: parsed.action,
      ownerEmail: parsed.ownerEmail || "unknown",
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function isStaleLock(lock: ServerActionLock | null): boolean {
  if (!lock) {
    return true;
  }
  return Date.now() > new Date(lock.expiresAt).getTime();
}

function isParameterAlreadyExistsError(error: unknown): boolean {
  const named = error as { name?: string; message?: string };
  return named.name === "ParameterAlreadyExists" || named.message?.includes("ParameterAlreadyExists") === true;
}

function isParameterNotFoundError(error: unknown): boolean {
  const named = error as { name?: string; message?: string };
  return named.name === "ParameterNotFound" || named.message?.includes("ParameterNotFound") === true;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function lockMatchesReleaseOptions(
  lock: ServerActionLock,
  lockId: string,
  options?: ReleaseServerActionLockOptions
): boolean {
  if (lock.lockId !== lockId) {
    console.warn(`[LOCK] Skip releasing lock. Ownership mismatch for lockId=${lockId}`);
    return false;
  }

  if (options?.action && lock.action !== options.action) {
    console.warn(`[LOCK] Skip releasing lock. Action mismatch for lockId=${lockId}`);
    return false;
  }

  if (options?.ownerEmail && normalizeEmail(lock.ownerEmail) !== normalizeEmail(options.ownerEmail)) {
    console.warn(`[LOCK] Skip releasing lock. Owner mismatch for lockId=${lockId}`);
    return false;
  }

  return true;
}

async function deleteLockIfExpected(expectedLockId?: string): Promise<boolean> {
  if (!expectedLockId) {
    return false;
  }

  const deleteClaimParam = `${serverActionDeleteClaimPrefix}/${expectedLockId}`;
  const claim = JSON.stringify({
    claimId: randomUUID(),
    createdAt: new Date().toISOString(),
  });

  try {
    await putParameter(deleteClaimParam, claim, "String", false);
  } catch (error) {
    if (isParameterAlreadyExistsError(error)) {
      return false;
    }
    throw error;
  }

  try {
    const currentLockRaw = await getParameter(serverActionLockParam);
    const currentLock = parseLock(currentLockRaw);

    if (!currentLock || currentLock.lockId !== expectedLockId || !isStaleLock(currentLock)) {
      return false;
    }

    try {
      await deleteParameter(serverActionLockParam);
      return true;
    } catch (error) {
      if (isParameterNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  } finally {
    try {
      await deleteParameter(deleteClaimParam);
    } catch (error) {
      if (!isParameterNotFoundError(error)) {
        console.warn(`[LOCK] Failed to clean delete claim for lockId=${expectedLockId}`);
      }
    }
  }
}

export async function acquireServerActionLock(action: ServerActionType, ownerEmail: string): Promise<ServerActionLock> {
  const now = Date.now();
  const lock: ServerActionLock = {
    lockId: randomUUID(),
    action,
    ownerEmail,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + serverActionLockTtlMs).toISOString(),
  };

  try {
    await putParameter(serverActionLockParam, JSON.stringify(lock), "String", false);
    return lock;
  } catch (error) {
    if (!isParameterAlreadyExistsError(error)) {
      throw error;
    }
  }

  const existingLockRaw = await getParameter(serverActionLockParam);
  const existingLock = parseLock(existingLockRaw);

  if (isStaleLock(existingLock)) {
    console.warn("[LOCK] Removing stale server-action lock");
    await deleteLockIfExpected(existingLock?.lockId);

    try {
      await putParameter(serverActionLockParam, JSON.stringify(lock), "String", false);
      return lock;
    } catch (error) {
      if (!isParameterAlreadyExistsError(error)) {
        throw error;
      }

      const currentLock = parseLock(await getParameter(serverActionLockParam));
      throw new ServerActionLockConflictError(currentLock);
    }
  }

  throw new ServerActionLockConflictError(existingLock);
}

export async function releaseServerActionLock(
  lockId: string,
  options?: ReleaseServerActionLockOptions
): Promise<boolean> {
  const deleteClaimParam = `${serverActionDeleteClaimPrefix}/${lockId}`;
  const claim = JSON.stringify({
    claimId: randomUUID(),
    createdAt: new Date().toISOString(),
  });

  try {
    await putParameter(deleteClaimParam, claim, "String", false);
  } catch (error) {
    if (isParameterAlreadyExistsError(error)) {
      console.warn(`[LOCK] Skip releasing lock. Another release/cleanup in progress for lockId=${lockId}`);
      return false;
    }
    throw error;
  }

  try {
    const existingLockRaw = await getParameter(serverActionLockParam);
    const existingLock = parseLock(existingLockRaw);

    if (!existingLock) {
      return false;
    }

    if (!lockMatchesReleaseOptions(existingLock, lockId, options)) {
      return false;
    }

    try {
      await deleteParameter(serverActionLockParam);
      return true;
    } catch (error) {
      if (isParameterNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  } finally {
    try {
      await deleteParameter(deleteClaimParam);
    } catch (error) {
      if (!isParameterNotFoundError(error)) {
        console.warn(`[LOCK] Failed to clean delete claim for lockId=${lockId}`);
      }
    }
  }
}

export function isServerActionLockConflictError(error: unknown): error is ServerActionLockConflictError {
  return error instanceof ServerActionLockConflictError;
}
