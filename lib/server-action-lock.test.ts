import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  getParameter: vi.fn(),
  putParameter: vi.fn(),
  deleteParameter: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock("@/lib/aws", () => ({
  getParameter: mocks.getParameter,
  putParameter: mocks.putParameter,
  deleteParameter: mocks.deleteParameter,
}));

import { ServerActionLockConflictError, acquireServerActionLock, releaseServerActionLock } from "./server-action-lock";

function parameterAlreadyExistsError(): Error {
  const error = new Error("ParameterAlreadyExists");
  (error as Error & { name: string }).name = "ParameterAlreadyExists";
  return error;
}

function parameterNotFoundError(): Error {
  const error = new Error("ParameterNotFound");
  (error as Error & { name: string }).name = "ParameterNotFound";
  return error;
}

describe("server-action-lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    mocks.randomUUID.mockReturnValue("lock-123");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires a new lock with ttl metadata", async () => {
    mocks.putParameter.mockResolvedValueOnce(undefined);

    const lock = await acquireServerActionLock("start", "admin@example.com");

    expect(lock.lockId).toBe("lock-123");
    expect(lock.createdAt).toBe("2026-04-13T12:00:00.000Z");
    expect(lock.expiresAt).toBe("2026-04-13T12:30:00.000Z");
    expect(mocks.putParameter).toHaveBeenCalledWith("/minecraft/server-action", JSON.stringify(lock), "String", false);
  });

  it("recovers from stale lock before acquiring", async () => {
    const staleLock = {
      lockId: "stale-1",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T09:00:00.000Z",
      expiresAt: "2026-04-13T10:00:00.000Z",
    };

    mocks.putParameter.mockRejectedValueOnce(parameterAlreadyExistsError()).mockResolvedValueOnce(undefined);
    mocks.getParameter
      .mockResolvedValueOnce(JSON.stringify(staleLock))
      .mockResolvedValueOnce(JSON.stringify(staleLock));
    mocks.deleteParameter.mockResolvedValueOnce(undefined);

    const lock = await acquireServerActionLock("restore", "admin@example.com");

    expect(lock.lockId).toBe("lock-123");
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
    expect(mocks.putParameter).toHaveBeenCalledTimes(2);
  });

  it("treats malformed lock payload as stale and recovers", async () => {
    mocks.putParameter.mockRejectedValueOnce(parameterAlreadyExistsError()).mockResolvedValueOnce(undefined);
    mocks.getParameter.mockResolvedValueOnce("{not-json").mockResolvedValueOnce("{not-json");
    mocks.deleteParameter.mockResolvedValueOnce(undefined);

    const lock = await acquireServerActionLock("hibernate", "admin@example.com");

    expect(lock.lockId).toBe("lock-123");
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("fails with conflict when stale lock changed ownership during recovery", async () => {
    const staleLock = {
      lockId: "stale-1",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T09:00:00.000Z",
      expiresAt: "2026-04-13T10:00:00.000Z",
    };
    const replacementLock = {
      lockId: "stale-2",
      action: "restore",
      ownerEmail: "other@example.com",
      createdAt: "2026-04-13T09:10:00.000Z",
      expiresAt: "2026-04-13T10:10:00.000Z",
    };

    mocks.putParameter
      .mockRejectedValueOnce(parameterAlreadyExistsError())
      .mockRejectedValueOnce(parameterAlreadyExistsError());
    mocks.getParameter
      .mockResolvedValueOnce(JSON.stringify(staleLock))
      .mockResolvedValueOnce(JSON.stringify(replacementLock))
      .mockResolvedValueOnce(JSON.stringify(replacementLock));

    await expect(acquireServerActionLock("restore", "admin@example.com")).rejects.toEqual(
      expect.objectContaining({
        name: "ServerActionLockConflictError",
        existingLock: expect.objectContaining({ lockId: "stale-2" }),
      })
    );

    expect(mocks.deleteParameter).not.toHaveBeenCalled();
  });

  it("releases lock only when id, action, and owner match", async () => {
    const activeLock = {
      lockId: "lock-123",
      action: "resume",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:20:00.000Z",
    };

    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));
    mocks.deleteParameter.mockResolvedValueOnce(undefined);

    const released = await releaseServerActionLock("lock-123", {
      action: "resume",
      ownerEmail: "ADMIN@example.com",
    });

    expect(released).toBe(true);
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("does not release when action metadata mismatches", async () => {
    const activeLock = {
      lockId: "lock-123",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:20:00.000Z",
    };

    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));

    const released = await releaseServerActionLock("lock-123", {
      action: "restore",
      ownerEmail: "admin@example.com",
    });

    expect(released).toBe(false);
    expect(mocks.deleteParameter).not.toHaveBeenCalled();
  });

  it("returns false when lock disappears during release", async () => {
    const activeLock = {
      lockId: "lock-123",
      action: "stop",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:20:00.000Z",
    };

    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));
    mocks.deleteParameter.mockRejectedValueOnce(parameterNotFoundError());

    const released = await releaseServerActionLock("lock-123", {
      action: "stop",
      ownerEmail: "admin@example.com",
    });

    expect(released).toBe(false);
  });

  it("throws conflict with existing lock metadata for active lock", async () => {
    const activeLock = {
      lockId: "lock-active",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:25:00.000Z",
    };

    mocks.putParameter.mockRejectedValueOnce(parameterAlreadyExistsError());
    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));

    await expect(acquireServerActionLock("restore", "admin@example.com")).rejects.toBeInstanceOf(
      ServerActionLockConflictError
    );
  });
});
