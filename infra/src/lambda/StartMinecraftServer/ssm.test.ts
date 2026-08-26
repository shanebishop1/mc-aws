import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommandInvocationCommand, type PutParameterCommand, SendCommandCommand } from "./clients.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("./clients.js", async () => {
  const actual = await vi.importActual<typeof import("./clients.js")>("./clients.js");
  return { ...actual, ssm: { send: mocks.send } };
});

vi.mock("./runtime-budgets.js", () => ({
  SSM_MAX_ATTEMPTS: 1,
  SSM_POLL_INTERVAL_MS: 0,
  SSM_SEND_MAX_ATTEMPTS: 3,
  SSM_SEND_RETRY_INTERVAL_MS: 0,
}));

import { executeSSMCommand, putParameter } from "./ssm.js";

const namedError = (name: string): Error => Object.assign(new Error(name), { name });

describe("lambda SSM command delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["InvalidInstanceId", "TargetNotConnected"])("retries the transient %s readiness error", async (name) => {
    mocks.send
      .mockRejectedValueOnce(namedError(name))
      .mockResolvedValueOnce({ Command: { CommandId: "command-123" } })
      .mockResolvedValueOnce({ Status: "Success", StandardOutputContent: "done" });

    await expect(executeSSMCommand("i-abc123", ["true"])).resolves.toBe("done");

    const sendCommands = mocks.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof SendCommandCommand);
    expect(sendCommands).toHaveLength(2);
    expect(mocks.send.mock.calls.some(([command]) => command instanceof GetCommandInvocationCommand)).toBe(true);
  });

  it("does not retry a permanent send error", async () => {
    mocks.send.mockRejectedValueOnce(namedError("AccessDeniedException"));

    await expect(executeSSMCommand("i-abc123", ["true"])).rejects.toMatchObject({
      name: "AccessDeniedException",
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("stops after the bounded readiness retry budget", async () => {
    mocks.send.mockRejectedValue(namedError("InvalidInstanceId"));

    await expect(executeSSMCommand("i-abc123", ["true"])).rejects.toMatchObject({ name: "InvalidInstanceId" });
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("supports atomic create while preserving overwrite-by-default compatibility", async () => {
    mocks.send.mockResolvedValue({});

    await putParameter("/minecraft/default", "one");
    await putParameter("/minecraft/create", "two", "String", false);

    expect((mocks.send.mock.calls[0][0] as PutParameterCommand).input.Overwrite).toBe(true);
    expect((mocks.send.mock.calls[1][0] as PutParameterCommand).input.Overwrite).toBe(false);
  });

  it("sets a remote execution timeout and refuses timed-out completion", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-timeout" } })
      .mockResolvedValueOnce({ Status: "ExecutionTimedOut", StandardErrorContent: "timed out" });

    await expect(
      executeSSMCommand("i-abc123", ["long-running"], { maxAttempts: 1, timeoutSeconds: 450 })
    ).rejects.toThrow("SSM command failed: timed out");
    const send = mocks.send.mock.calls[0][0] as SendCommandCommand;
    expect(send.input.TimeoutSeconds).toBe(450);
  });
});
