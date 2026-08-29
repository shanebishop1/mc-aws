import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  type PutParameterCommand,
  SendCommandCommand,
} from "./clients.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  heartbeat: vi.fn(),
  recordRemote: vi.fn(),
  recordRemoteIdentity: vi.fn(),
}));

vi.mock("./operation-state.js", () => ({
  heartbeatOperationExecution: mocks.heartbeat,
  recordOperationRemoteCommand: mocks.recordRemote,
  recordOperationRemoteCommandIdentity: mocks.recordRemoteIdentity,
}));

vi.mock("./clients.js", async () => {
  const actual = await vi.importActual<typeof import("./clients.js")>("./clients.js");
  return { ...actual, ssm: { send: mocks.send } };
});

vi.mock("./runtime-budgets.js", () => ({
  SSM_MAX_ATTEMPTS: 1,
  SSM_CANCEL_MAX_ATTEMPTS: 2,
  SSM_POLL_INTERVAL_MS: 0,
  SSM_SEND_MAX_ATTEMPTS: 3,
  SSM_SEND_RETRY_INTERVAL_MS: 0,
  SSM_TIMEOUT_SECONDS: 480,
}));

import { runWithOperationExecutionContext } from "./execution-context.js";
import {
  executeSSMCommand,
  putParameter,
  reconcileRemoteCommand,
  shouldRetainLifecycleLock,
  wrapIdempotentRemoteCommands,
} from "./ssm.js";

const namedError = (name: string): Error => Object.assign(new Error(name), { name });

describe("lambda SSM command delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.heartbeat.mockResolvedValue(undefined);
    mocks.recordRemote.mockResolvedValue(undefined);
    mocks.recordRemoteIdentity.mockResolvedValue(undefined);
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
      name: "SSMCommandUnresolvedError",
      code: "SSM_COMMAND_DELIVERY_FAILED",
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("stops after the bounded readiness retry budget", async () => {
    mocks.send.mockRejectedValue(namedError("InvalidInstanceId"));

    await expect(executeSSMCommand("i-abc123", ["true"])).rejects.toMatchObject({
      name: "SSMCommandUnresolvedError",
      code: "SSM_COMMAND_DELIVERY_FAILED",
    });
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("supports atomic create while preserving overwrite-by-default compatibility", async () => {
    mocks.send.mockResolvedValue({});

    await putParameter("/minecraft/default", "one");
    await putParameter("/minecraft/create", "two", "String", false);

    expect((mocks.send.mock.calls[0][0] as PutParameterCommand).input.Overwrite).toBe(true);
    expect((mocks.send.mock.calls[1][0] as PutParameterCommand).input.Overwrite).toBe(false);
  });

  it("durably records the remote command identity before polling", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-recorded" } })
      .mockResolvedValueOnce({ Status: "Success" });

    await runWithOperationExecutionContext(
      {
        operationId: "op-1",
        command: "backup",
        executionToken: "attempt-1",
        deadlineMs: Date.now() + 120_000,
      },
      async () => await executeSSMCommand("i-abc123", ["true"], { step: "backup", finalRemoteStep: true })
    );
    expect(mocks.recordRemote).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ commandId: "command-recorded", step: "backup", final: true })
    );
    expect(mocks.recordRemoteIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.stringMatching(/^mc-aws:[a-f0-9]{64}$/), step: "backup" })
    );
  });

  it("safely retries an ambiguous SendCommand with the same host-journaled identity", async () => {
    const identities: Array<string | undefined> = [];
    let sendAttempts = 0;
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof SendCommandCommand) {
        identities.push(command.input.Comment);
        sendAttempts += 1;
        if (sendAttempts === 1) throw namedError("TimeoutError");
        return { Command: { CommandId: "command-retry" } };
      }
      if (command instanceof GetCommandInvocationCommand) {
        return { Status: "Success", StandardOutputContent: "done" };
      }
      return {};
    });

    await expect(
      runWithOperationExecutionContext(
        {
          operationId: "op-ambiguous",
          command: "backup",
          executionToken: "attempt-1",
          deadlineMs: Date.now() + 120_000,
        },
        async () => await executeSSMCommand("i-abc123", ["true"], { step: "backup", finalRemoteStep: true })
      )
    ).resolves.toBe("done");

    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
    const sendCommands = mocks.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof SendCommandCommand);
    expect(sendCommands[0].input.Parameters?.commands?.[0]).toContain("/var/lib/mc-aws/ssm-operations");
    expect(sendCommands[0].input.Parameters?.commands?.[0]).not.toContain("op-ambiguous");
    expect(mocks.recordRemote).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "command-retry", identity: expect.stringMatching(/^mc-aws:/) })
    );
  });

  it("durably commits the outer result before acknowledging a matching backup journal on retries", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-ssm-wrapper-"));
    try {
      const stateDirectory = path.join(root, "operations");
      const backupJournal = path.join(root, "backup-journal.json");
      const uploadLog = path.join(root, "upload.log");
      const key = "c".repeat(64);
      const journal = JSON.stringify({
        version: 1,
        phase: "restart-complete",
        backupName: "contract",
        mode: "ordinary",
        operationKey: key,
      });
      const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
      const [generated] = wrapIdempotentRemoteCommands(
        [
          `printf 'upload\\n' >> ${quote(uploadLog)}`,
          `printf %s ${quote(journal)} > ${quote(backupJournal)}`,
          "printf 'completed\\n'",
        ],
        `mc-aws:${key}`
      );
      const script = generated
        .replaceAll("/var/lib/mc-aws/ssm-operations", stateDirectory)
        .replaceAll("/var/lib/mc-aws/mc-backup-journal.json", backupJournal)
        .replace("\nflock 9\n", "\ntrue\n")
        .replace("\n  flock 8\n", "\n  true\n")
        .replace("\n  flock -u 8\n", "\n  true\n");

      const first = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toBe("completed\n");
      expect(existsSync(path.join(stateDirectory, `${key}.out`))).toBe(true);
      expect(existsSync(path.join(stateDirectory, `${key}.done`))).toBe(true);
      expect(existsSync(backupJournal)).toBe(false);

      // Model an ambiguous outer return after the durable .done commit but
      // before acknowledgment. The fast path must retry only acknowledgment.
      writeFileSync(backupJournal, journal, "utf8");
      const retry = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stdout).toBe("completed\n");
      expect(readFileSync(uploadLog, "utf8")).toBe("upload\n");
      expect(existsSync(backupJournal)).toBe(false);

      const foreignJournal = journal.replace(key, "d".repeat(64));
      writeFileSync(backupJournal, foreignJournal, "utf8");
      const foreignRetry = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(foreignRetry.status, foreignRetry.stderr).toBe(0);
      expect(readFileSync(backupJournal, "utf8")).toBe(foreignJournal);
      expect(readFileSync(uploadLog, "utf8")).toBe("upload\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a crash-persisted command identity safe for idempotent host-journal retry", async () => {
    await expect(
      reconcileRemoteCommand({
        remoteCommandIdentity: "mc-aws:stable",
        remoteCommandInstanceId: "i-abc123",
      })
    ).resolves.toMatchObject({ terminal: true, success: false, status: "IdentityRetryRequired" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sets a remote execution timeout and omits stdout and stderr from terminal errors", async () => {
    const secretOutput = "SECRET_REMOTE_OUTPUT_SENTINEL";
    mocks.send.mockResolvedValueOnce({ Command: { CommandId: "command-timeout" } }).mockResolvedValueOnce({
      Status: "ExecutionTimedOut",
      StandardErrorContent: secretOutput,
      StandardOutputContent: secretOutput,
    });

    const error = await executeSSMCommand("i-abc123", ["long-running"], {
      maxAttempts: 1,
      timeoutSeconds: 450,
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      name: "SSMCommandTerminalError",
      code: "ssm_command_terminal",
      message: "SSM_COMMAND_TERMINAL:EXECUTIONTIMEDOUT",
    });
    expect(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain(secretOutput);
    const send = mocks.send.mock.calls[0][0] as SendCommandCommand;
    expect(send.input.TimeoutSeconds).toBe(450);
    expect(send.input.Parameters?.executionTimeout).toEqual(["450"]);
  });

  it("applies the aligned remote timeout by default", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-default-timeout" } })
      .mockResolvedValueOnce({ Status: "Success" });

    await executeSSMCommand("i-abc123", ["true"]);

    expect((mocks.send.mock.calls[0][0] as SendCommandCommand).input.TimeoutSeconds).toBe(480);
  });

  it("cancels an over-budget command and observes terminal cancellation before rejecting", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-cancel" } })
      .mockResolvedValueOnce({ Status: "InProgress" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: "Cancelled" });

    await expect(executeSSMCommand("i-abc123", ["long-running"], { maxAttempts: 1 })).rejects.toThrow(
      "SSM_COMMAND_POLL_BUDGET_EXCEEDED"
    );
    expect(mocks.send.mock.calls.some(([command]) => command instanceof CancelCommandCommand)).toBe(true);
  });

  it("returns success when the command wins the cancellation race", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-race" } })
      .mockResolvedValueOnce({ Status: "InProgress" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: "Success", StandardOutputContent: "completed during cancel" });

    await expect(executeSSMCommand("i-abc123", ["race"], { maxAttempts: 1 })).resolves.toBe("completed during cancel");
  });

  it("retries bounded transient polling failures", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-transient" } })
      .mockRejectedValueOnce(namedError("ThrottlingException"))
      .mockResolvedValueOnce({ Status: "Success", StandardOutputContent: "done" });

    await expect(executeSSMCommand("i-abc123", ["true"], { maxAttempts: 2 })).resolves.toBe("done");
  });

  it("caps both SSM timeout layers to the remaining overall operation budget", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-deadline" } })
      .mockResolvedValueOnce({ Status: "Success" });

    await executeSSMCommand("i-abc123", ["true"], {
      timeoutSeconds: 450,
      deadlineMs: Date.now() + 100_000,
    });
    const send = mocks.send.mock.calls[0][0] as SendCommandCommand;
    expect(send.input.TimeoutSeconds).toBeGreaterThanOrEqual(74);
    expect(send.input.TimeoutSeconds).toBeLessThanOrEqual(75);
    expect(send.input.Parameters?.executionTimeout).toEqual([String(send.input.TimeoutSeconds)]);
  });

  it("attempts cancellation after the transient polling retry budget is exhausted", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-transient-exhausted" } })
      .mockRejectedValueOnce(namedError("ThrottlingException"))
      .mockRejectedValueOnce(namedError("ThrottlingException"))
      .mockRejectedValueOnce(namedError("ThrottlingException"))
      .mockRejectedValueOnce(namedError("ThrottlingException"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Status: "Cancelled" });

    await expect(executeSSMCommand("i-abc123", ["true"], { maxAttempts: 4 })).rejects.toThrow(
      "SSM_COMMAND_STATUS_UNRESOLVED"
    );
    expect(mocks.send.mock.calls.some(([command]) => command instanceof CancelCommandCommand)).toBe(true);
  });

  it("marks the lock for retention when cancellation never becomes terminal", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-stuck" } })
      .mockResolvedValueOnce({ Status: "InProgress" })
      .mockResolvedValueOnce({})
      .mockResolvedValue({ Status: "Cancelling" });

    const error = await executeSSMCommand("i-abc123", ["stuck"], { maxAttempts: 1 }).catch((caught) => caught);

    expect(shouldRetainLifecycleLock(error)).toBe(true);
    expect(error).toMatchObject({ name: "SSMCommandUnresolvedError", commandId: "command-stuck" });
  });

  it("retains ownership when invocation status cannot be classified as terminal", async () => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: "command-unknown" } })
      .mockResolvedValueOnce({ Status: "MysteryState" });

    const error = await executeSSMCommand("i-abc123", ["unknown"], { maxAttempts: 1 }).catch((caught) => caught);

    expect(shouldRetainLifecycleLock(error)).toBe(true);
    expect(error).toMatchObject({ name: "SSMCommandUnresolvedError", commandId: "command-unknown" });
  });

  it.each([
    "Failed",
    "Cancelled",
    "TimedOut",
    "Delivery Timed Out",
    "Execution Timed Out",
    "Undeliverable",
    "Terminated",
  ])("fails consistently for terminal invocation status %s", async (status) => {
    mocks.send
      .mockResolvedValueOnce({ Command: { CommandId: `command-${status}` } })
      .mockResolvedValueOnce({ Status: status.replaceAll(" ", ""), StatusDetails: status });

    await expect(executeSSMCommand("i-abc123", ["false"], { maxAttempts: 1 })).rejects.toThrow(
      `SSM_COMMAND_TERMINAL:${status.replaceAll(" ", "_").toUpperCase()}`
    );
  });
});
