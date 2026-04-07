import { randomUUID } from "node:crypto";
import { deleteParameter, getParameter, putParameter } from "@/lib/aws";

const serverActionLockParam = "/minecraft/server-action";
const serverActionLockTtlMs = 30 * 60 * 1000;

export type ServerActionType = "start" | "stop" | "resume" | "hibernate" | "backup" | "restore";

export interface ServerActionLock {
  lockId: string;
  action: ServerActionType;
  ownerEmail: string;
  createdAt: string;
  expiresAt: string;
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
    try {
      await deleteParameter(serverActionLockParam);
    } catch (error) {
      const named = error as { name?: string };
      if (named.name !== "ParameterNotFound") {
        throw error;
      }
    }

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

export async function releaseServerActionLock(lockId: string): Promise<boolean> {
  const existingLockRaw = await getParameter(serverActionLockParam);
  const existingLock = parseLock(existingLockRaw);

  if (!existingLock) {
    return false;
  }

  if (existingLock.lockId !== lockId) {
    console.warn(`[LOCK] Skip releasing lock. Ownership mismatch for lockId=${lockId}`);
    return false;
  }

  await deleteParameter(serverActionLockParam);
  return true;
}

export function isServerActionLockConflictError(error: unknown): error is ServerActionLockConflictError {
  return error instanceof ServerActionLockConflictError;
}
