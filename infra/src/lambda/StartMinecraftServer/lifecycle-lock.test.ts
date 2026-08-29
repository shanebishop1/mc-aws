import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  getParameter: vi.fn(),
  putParameter: vi.fn(),
  deleteParameter: vi.fn(),
  randomUUID: vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("./ssm.js", () => ({
  getParameter: mocks.getParameter,
  putParameter: mocks.putParameter,
  deleteParameter: mocks.deleteParameter,
}));
vi.mock("./clients.js", async () => {
  const actual = await vi.importActual<typeof import("./clients.js")>("./clients.js");
  return { ...actual, dynamodb: { send: mocks.ddbSend } };
});

import {
  acquireLifecycleLock,
  assertLifecycleLockOwned,
  bridgeLegacyLifecycleLock,
  releaseLifecycleLock,
} from "./lifecycle-lock.js";

const item = (lockId: string, token: number) => ({
  lockId: { S: lockId },
  fencingToken: { N: String(token) },
  action: { S: "hibernate" },
  ownerEmail: { S: "admin@example.com" },
  createdAt: { S: "2026-04-13T12:00:00.000Z" },
  leaseExpiresAt: { N: String(Date.parse("2026-04-13T12:45:00.000Z")) },
  released: { BOOL: false },
});
const metadata = { Item: { protocolVersion: { S: "dual-v1" } } };
const legacy = JSON.stringify({
  lockId: "email-lock",
  action: "hibernate",
  ownerEmail: "admin@example.com",
  createdAt: "2026-04-13T12:00:00.000Z",
  expiresAt: "2026-04-13T12:45:00.000Z",
});

describe("Lambda DynamoDB lifecycle lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "locks-table");
    mocks.randomUUID.mockReturnValue("email-lock");
    mocks.getParameter.mockResolvedValue(legacy);
    mocks.putParameter.mockResolvedValue(undefined);
    mocks.deleteParameter.mockResolvedValue(undefined);
  });

  it("uses the same conditional acquisition fields as the Worker", async () => {
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("email-lock", 9) });
    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "email-lock",
      fencingToken: 9,
    });
    expect(mocks.ddbSend.mock.calls[1][0].input.ConditionExpression).toContain("leaseExpiresAt < :now");
    const bridgePayload = JSON.parse(
      mocks.putParameter.mock.calls.find(([name]) => name === "/minecraft/server-action")?.[1]
    );
    expect(bridgePayload.expiresAt).toBe("2026-04-13T13:30:00.000Z");
  });

  it("asserts and releases only the exact lock id and fencing token", async () => {
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: item("email-lock", 9) })
      .mockResolvedValueOnce({});
    await expect(assertLifecycleLockOwned("email-lock", 9, "hibernate")).resolves.toMatchObject({ fencingToken: 9 });
    await expect(releaseLifecycleLock("email-lock", 9, "hibernate", "admin@example.com")).resolves.toBe(true);
    expect(mocks.ddbSend.mock.calls[2][0].input.ConditionExpression).toContain("fencingToken = :token");
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("adopts an old Worker SSM lock into DynamoDB without replacing the legacy owner", async () => {
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: item("email-lock", 10) });

    await expect(bridgeLegacyLifecycleLock("email-lock", "hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "email-lock",
      fencingToken: 10,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameter).not.toHaveBeenCalled();
  });

  it("uses an old-compatible delete claim before replacing an expired SSM bridge lock", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    mocks.randomUUID.mockReturnValueOnce("new-lock").mockReturnValueOnce("claim-new");
    mocks.putParameter
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }))
      .mockResolvedValue(undefined);
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("new-lock", 11) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 11,
    });
    expect(mocks.putParameter).toHaveBeenCalledWith(
      "/minecraft/server-action-delete-claim/email-lock",
      expect.stringContaining('"claimId":"claim-new"'),
      "String",
      false
    );
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action-delete-claim/email-lock");
  });

  it("takes over an expired legacy delete-claim lease", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    mocks.randomUUID.mockReturnValueOnce("new-lock").mockReturnValueOnce("claim-new");
    mocks.getParameter
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce(
        JSON.stringify({
          claimId: "stale",
          createdAt: "2026-04-13T12:00:00.000Z",
          expiresAt: "2026-04-13T12:01:00.000Z",
        })
      )
      .mockResolvedValueOnce(legacy);
    mocks.putParameter
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }))
      .mockRejectedValueOnce(Object.assign(new Error("claim held"), { name: "ParameterAlreadyExists" }))
      .mockResolvedValue(undefined);
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("new-lock", 12) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 12,
    });
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action-delete-claim/email-lock");
  });

  it("reconciles an ambiguous DynamoDB acquisition that committed", async () => {
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Item: item("email-lock", 13) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "email-lock",
      fencingToken: 13,
    });
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("repairs ambiguous acquisition conditionally when its reconciliation read fails", async () => {
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("write timeout"), { name: "TimeoutError" }))
      .mockRejectedValueOnce(Object.assign(new Error("read timeout"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ Attributes: item("email-lock", 15) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "email-lock",
      fencingToken: 15,
    });
    expect(mocks.ddbSend.mock.calls[3][0].input.UpdateExpression).not.toContain("fencingToken");
  });

  it("fails closed after bounded ambiguity repair cannot establish ownership", async () => {
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(Object.assign(new Error("write timeout"), { name: "TimeoutError" }))
      .mockRejectedValueOnce(Object.assign(new Error("read timeout"), { name: "TimeoutError" }))
      .mockRejectedValue(Object.assign(new Error("repair timeout"), { name: "TimeoutError" }));

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).rejects.toThrow("repair timeout");
    expect(mocks.ddbSend).toHaveBeenCalledTimes(6);
    expect(mocks.deleteParameter).not.toHaveBeenCalledWith("/minecraft/server-action");
  });

  it("self-heals an active SSM bridge after its matching DynamoDB owner was released", async () => {
    mocks.randomUUID.mockReturnValueOnce("new-lock").mockReturnValueOnce("claim-new");
    mocks.putParameter
      .mockRejectedValueOnce(Object.assign(new Error("held"), { name: "ParameterAlreadyExists" }))
      .mockResolvedValue(undefined);
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: { ...item("email-lock", 9), released: { BOOL: true } } })
      .mockResolvedValueOnce({ Attributes: item("new-lock", 10) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 10,
    });
    expect(mocks.deleteParameter).toHaveBeenCalledWith("/minecraft/server-action");
  });
});
