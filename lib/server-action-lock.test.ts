import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockParam = "/minecraft/server-action";
const deleteClaimPrefix = "/minecraft/server-action-delete-claim";

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
    expect(mocks.putParameter).toHaveBeenCalledWith(lockParam, JSON.stringify(lock), "String", false);
  });

  it("recovers from stale lock with delete-claim protection", async () => {
    const staleLock = {
      lockId: "stale-1",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T09:00:00.000Z",
      expiresAt: "2026-04-13T10:00:00.000Z",
    };

    mocks.randomUUID.mockReturnValueOnce("lock-123").mockReturnValueOnce("claim-123");

    mocks.putParameter
      .mockRejectedValueOnce(parameterAlreadyExistsError())
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(staleLock)).mockResolvedValueOnce(JSON.stringify(staleLock));

    mocks.deleteParameter.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    const lock = await acquireServerActionLock("restore", "admin@example.com");

    expect(lock.lockId).toBe("lock-123");
    expect(mocks.putParameter).toHaveBeenNthCalledWith(
      2,
      `${deleteClaimPrefix}/stale-1`,
      expect.stringContaining('"claimId":"claim-123"'),
      "String",
      false
    );
    expect(mocks.deleteParameter).toHaveBeenNthCalledWith(1, lockParam);
    expect(mocks.deleteParameter).toHaveBeenNthCalledWith(2, `${deleteClaimPrefix}/stale-1`);
  });

  it("does not blindly delete unknown malformed lock payload", async () => {
    mocks.putParameter.mockRejectedValueOnce(parameterAlreadyExistsError()).mockRejectedValueOnce(parameterAlreadyExistsError());
    mocks.getParameter.mockResolvedValueOnce("{not-json").mockResolvedValueOnce("{not-json");

    await expect(acquireServerActionLock("hibernate", "admin@example.com")).rejects.toEqual(
      expect.objectContaining({ name: "ServerActionLockConflictError" })
    );

    expect(mocks.deleteParameter).not.toHaveBeenCalledWith(lockParam);
  });

  it("handles stale-cleanup race without deleting newly acquired lock", async () => {
    const staleLock = {
      lockId: "stale-1",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T09:00:00.000Z",
      expiresAt: "2026-04-13T10:00:00.000Z",
    };
    const replacementLock = {
      lockId: "lock-999",
      action: "restore",
      ownerEmail: "other@example.com",
      createdAt: "2026-04-13T12:00:10.000Z",
      expiresAt: "2026-04-13T12:30:10.000Z",
    };

    mocks.randomUUID.mockReturnValueOnce("lock-123").mockReturnValueOnce("claim-123");

    mocks.putParameter
      .mockRejectedValueOnce(parameterAlreadyExistsError())
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(parameterAlreadyExistsError());

    mocks.getParameter
      .mockResolvedValueOnce(JSON.stringify(staleLock))
      .mockResolvedValueOnce(JSON.stringify(staleLock))
      .mockResolvedValueOnce(JSON.stringify(replacementLock));

    mocks.deleteParameter.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    await expect(acquireServerActionLock("restore", "admin@example.com")).rejects.toEqual(
      expect.objectContaining({
        name: "ServerActionLockConflictError",
        existingLock: expect.objectContaining({ lockId: "lock-999" }),
      })
    );

    expect(mocks.deleteParameter).toHaveBeenCalledTimes(2);
    expect(mocks.deleteParameter).toHaveBeenCalledWith(lockParam);
    expect(mocks.deleteParameter).toHaveBeenCalledWith(`${deleteClaimPrefix}/stale-1`);
  });

  it("releases lock only when id, action, and owner match", async () => {
    const activeLock = {
      lockId: "lock-123",
      action: "resume",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:20:00.000Z",
    };

    mocks.randomUUID.mockReturnValueOnce("claim-123");
    mocks.putParameter.mockResolvedValueOnce(undefined);
    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));
    mocks.deleteParameter.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    const released = await releaseServerActionLock("lock-123", {
      action: "resume",
      ownerEmail: "ADMIN@example.com",
    });

    expect(released).toBe(true);
    expect(mocks.putParameter).toHaveBeenCalledWith(
      `${deleteClaimPrefix}/lock-123`,
      expect.stringContaining('"claimId":"claim-123"'),
      "String",
      false
    );
    expect(mocks.deleteParameter).toHaveBeenNthCalledWith(1, lockParam);
    expect(mocks.deleteParameter).toHaveBeenNthCalledWith(2, `${deleteClaimPrefix}/lock-123`);
  });

  it("does not release when action metadata mismatches", async () => {
    const activeLock = {
      lockId: "lock-123",
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:20:00.000Z",
    };

    mocks.putParameter.mockResolvedValueOnce(undefined);
    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));
    mocks.deleteParameter.mockResolvedValueOnce(undefined);

    const released = await releaseServerActionLock("lock-123", {
      action: "restore",
      ownerEmail: "admin@example.com",
    });

    expect(released).toBe(false);
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith(lockParam);
    expect(mocks.deleteParameter).toHaveBeenCalledWith(`${deleteClaimPrefix}/lock-123`);
  });

  it("returns false when lock disappears during release", async () => {
    const activeLock = {
      lockId: "lock-123",
      action: "stop",
      ownerEmail: "admin@example.com",
      createdAt: "2026-04-13T11:50:00.000Z",
      expiresAt: "2026-04-13T12:20:00.000Z",
    };

    mocks.putParameter.mockResolvedValueOnce(undefined);
    mocks.getParameter.mockResolvedValueOnce(JSON.stringify(activeLock));
    mocks.deleteParameter.mockRejectedValueOnce(parameterNotFoundError()).mockResolvedValueOnce(undefined);

    const released = await releaseServerActionLock("lock-123", {
      action: "stop",
      ownerEmail: "admin@example.com",
    });

    expect(released).toBe(false);
  });

  it("prevents release race when another cleanup already holds delete claim", async () => {
    mocks.putParameter.mockRejectedValueOnce(parameterAlreadyExistsError());

    const released = await releaseServerActionLock("lock-123", {
      action: "stop",
      ownerEmail: "admin@example.com",
    });

    expect(released).toBe(false);
    expect(mocks.getParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith(lockParam);
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
