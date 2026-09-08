import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  getParameter: vi.fn(),
  putParameter: vi.fn(),
  deleteParameter: vi.fn(),
  getParameterRecord: vi.fn(),
  putParameterIfCurrent: vi.fn(),
  deleteParameterIfCurrent: vi.fn(),
  randomUUID: vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));
vi.mock("./ssm.js", () => ({
  getParameter: mocks.getParameter,
  putParameter: mocks.putParameter,
  deleteParameter: mocks.deleteParameter,
  getParameterRecord: mocks.getParameterRecord,
  putParameterIfCurrent: mocks.putParameterIfCurrent,
  deleteParameterIfCurrent: mocks.deleteParameterIfCurrent,
}));
vi.mock("./clients.js", async () => {
  const actual = await vi.importActual<typeof import("./clients.js")>("./clients.js");
  return { ...actual, dynamodb: { send: mocks.ddbSend } };
});

import {
  acquireLifecycleLock,
  assertLifecycleLockOwned,
  bridgeLegacyLifecycleLock,
  getCurrentLifecycleLock,
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
  claimToken: "email-lock",
});
const parameterValues = new Map<string, string>();

describe("Lambda DynamoDB lifecycle lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ddbSend.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "locks-table");
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operations-table");
    mocks.randomUUID.mockReturnValue("email-lock");
    parameterValues.clear();
    mocks.getParameter.mockImplementation(async (name: string) => parameterValues.get(name) ?? null);
    mocks.putParameter.mockImplementation(async (name: string, value: string, _type: string, overwrite = true) => {
      if (!overwrite && parameterValues.has(name)) {
        throw Object.assign(new Error("held"), { name: "ParameterAlreadyExists" });
      }
      parameterValues.set(name, value);
      return 1;
    });
    mocks.deleteParameter.mockImplementation(async (name: string) => {
      parameterValues.delete(name);
    });
    mocks.getParameterRecord.mockImplementation(async (name: string) => {
      const value = parameterValues.get(name);
      return value === undefined ? null : { name, value, type: "String", version: 1 };
    });
    mocks.putParameterIfCurrent.mockImplementation(async (name: string, value: string) => {
      parameterValues.set(name, value);
      return true;
    });
    mocks.deleteParameterIfCurrent.mockImplementation(async (name: string) => {
      parameterValues.delete(name);
      return true;
    });
  });

  it("uses the same conditional acquisition fields as the Worker", async () => {
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("email-lock", 9) });
    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "email-lock",
      fencingToken: 9,
    });
    expect(mocks.ddbSend.mock.calls[1][0].input.ConditionExpression).toContain("leaseExpiresAt < :now");
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("asserts and releases only the exact lock id and fencing token", async () => {
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ Item: item("email-lock", 9) })
      .mockResolvedValueOnce({ Item: item("email-lock", 9) })
      .mockResolvedValueOnce({ Item: item("email-lock", 9) })
      .mockResolvedValueOnce({});
    await expect(assertLifecycleLockOwned("email-lock", 9, "hibernate")).resolves.toMatchObject({ fencingToken: 9 });
    await expect(releaseLifecycleLock("email-lock", 9, "hibernate", "admin@example.com")).resolves.toBe(true);
    expect(mocks.ddbSend.mock.calls[2][0].input.ConditionExpression).toContain("fencingToken = :token");
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
  });

  it("requires the current agent-fence generation and operation owner for cleanup", async () => {
    mocks.ddbSend.mockResolvedValueOnce({});

    await expect(
      releaseLifecycleLock("agent-lock", 17, "backup", "agent@example.com", {
        expectedLeaseGeneration: 4,
        requireAgentFenceActive: true,
        operationId: "agent-operation",
        operationOwnerId: "agent-owner",
      })
    ).resolves.toBe(true);

    const input = mocks.ddbSend.mock.calls[0][0].input;
    expect(input.ConditionExpression).toContain("leaseGeneration = :generation");
    expect(input.ConditionExpression).toContain("agentFenceActive = :agentFenceActive");
    expect(input.ConditionExpression).toContain("operationId = :operationId");
    expect(input.ConditionExpression).toContain("operationOwnerId = :operationOwnerId");
    expect(input.ExpressionAttributeValues[":generation"]).toEqual({ N: "4" });
    expect(input.ExpressionAttributeValues[":agentFenceActive"]).toEqual({ BOOL: true });
  });

  it("parses the operator destroy fence as an active lifecycle owner", async () => {
    mocks.ddbSend.mockResolvedValueOnce({
      Item: {
        ...item("destroy-lock", 10),
        action: { S: "destroy" },
        agentFenceActive: { BOOL: true },
        operationId: { S: "destroy-12345678-1234-4234-8234-123456789012" },
        operationOwnerId: { S: "destroy-12345678-1234-4234-8234-123456789012" },
      },
    });

    await expect(getCurrentLifecycleLock()).resolves.toMatchObject({
      action: "destroy",
      lockId: "destroy-lock",
      fencingToken: 10,
      agentFenceActive: true,
    });
  });

  it("does not let a Lambda mint an operator destroy fence", async () => {
    await expect(acquireLifecycleLock("destroy", "admin@example.com")).rejects.toThrow(
      "Unsupported lifecycle lock action: destroy"
    );
    expect(mocks.ddbSend).not.toHaveBeenCalled();
    expect(mocks.putParameter).not.toHaveBeenCalled();
  });

  it("refuses to adopt an old Worker SSM lock without an authoritative DynamoDB owner", async () => {
    parameterValues.set("/minecraft/server-action", legacy);
    mocks.ddbSend
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Attributes: item("email-lock", 10) });

    await expect(bridgeLegacyLifecycleLock("email-lock", "hibernate", "admin@example.com")).rejects.toThrow(
      "Another lifecycle operation is already in progress"
    );
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameter).not.toHaveBeenCalled();
  });

  it("does not replace an expired SSM bridge lock or create a delete claim", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    parameterValues.set("/minecraft/server-action", legacy);
    mocks.randomUUID.mockReturnValueOnce("new-lock");
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("new-lock", 11) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 11,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameterValues.get("/minecraft/server-action")).toBe(legacy);
  });

  it("preserves a malformed legacy bridge without proof", async () => {
    const malformed = '{"lockId":"legacy","action":"hibernate"}';
    parameterValues.set("/minecraft/server-action", malformed);
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("new-lock", 12) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 12,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameter).not.toHaveBeenCalled();
    expect(mocks.putParameterIfCurrent).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameterValues.get("/minecraft/server-action")).toBe(malformed);
  });

  it("preserves an expired legacy delete-claim lease", async () => {
    vi.setSystemTime(new Date("2026-04-13T13:00:00.000Z"));
    parameterValues.set("/minecraft/server-action", legacy);
    mocks.randomUUID.mockReturnValueOnce("new-lock");
    parameterValues.set(
      "/minecraft/server-action-delete-claim/email-lock",
      JSON.stringify({
        claimToken: "stale",
        createdAt: "2026-04-13T12:00:00.000Z",
        resourceVersion: 1,
        expiresAt: "2026-04-13T12:01:00.000Z",
      })
    );
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("new-lock", 12) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 12,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameterValues.get("/minecraft/server-action-delete-claim/email-lock")).toContain('"claimToken":"stale"');
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

  it("does not self-heal or rewrite an active SSM bridge", async () => {
    parameterValues.set("/minecraft/server-action", legacy);
    mocks.randomUUID.mockReturnValueOnce("new-lock");
    mocks.ddbSend.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ Attributes: item("new-lock", 10) });

    await expect(acquireLifecycleLock("hibernate", "admin@example.com")).resolves.toMatchObject({
      lockId: "new-lock",
      fencingToken: 10,
    });
    expect(mocks.putParameter).not.toHaveBeenCalled();
    expect(mocks.deleteParameterIfCurrent).not.toHaveBeenCalled();
    expect(parameterValues.get("/minecraft/server-action")).toBe(legacy);
  });
});
