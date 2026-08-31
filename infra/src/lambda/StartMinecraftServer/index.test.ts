import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureInstanceRunningMock,
  ensureInstanceStoppedMock,
  getInstanceStateMock,
  getPublicIpMock,
  getSanitizedErrorMessageMock,
  sendNotificationMock,
  getOperationStateMock,
  claimOperationExecutionMock,
  updateOperationStateMock,
  recordOperationSideEffectCompletedMock,
  acquireLifecycleLockMock,
  assertLifecycleLockOwnedMock,
  bridgeLegacyLifecycleLockMock,
  releaseLifecycleLockMock,
  deleteParameterMock,
  executeSSMCommandMock,
  getParameterMock,
  putParameterMock,
  shouldRetainLifecycleLockMock,
  reconcileRemoteCommandMock,
  resolveResumeRestoreStrategyMock,
  handleBackupMock,
  handleRefreshBackupsMock,
  handleHibernateMock,
  handleRestoreMock,
  handleResumeMock,
} = vi.hoisted(() => ({
  ensureInstanceRunningMock: vi.fn(),
  ensureInstanceStoppedMock: vi.fn(),
  getInstanceStateMock: vi.fn(),
  getPublicIpMock: vi.fn(),
  getSanitizedErrorMessageMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  getOperationStateMock: vi.fn(),
  claimOperationExecutionMock: vi.fn(),
  updateOperationStateMock: vi.fn(),
  recordOperationSideEffectCompletedMock: vi.fn(),
  acquireLifecycleLockMock: vi.fn(),
  assertLifecycleLockOwnedMock: vi.fn(),
  bridgeLegacyLifecycleLockMock: vi.fn(),
  releaseLifecycleLockMock: vi.fn(),
  deleteParameterMock: vi.fn(),
  executeSSMCommandMock: vi.fn(),
  getParameterMock: vi.fn(),
  putParameterMock: vi.fn(),
  shouldRetainLifecycleLockMock: vi.fn(),
  reconcileRemoteCommandMock: vi.fn(),
  resolveResumeRestoreStrategyMock: vi.fn(),
  handleBackupMock: vi.fn(),
  handleRefreshBackupsMock: vi.fn(),
  handleHibernateMock: vi.fn(),
  handleRestoreMock: vi.fn(),
  handleResumeMock: vi.fn(),
}));

vi.mock("./ec2.js", () => ({
  ensureInstanceRunning: ensureInstanceRunningMock,
  ensureInstanceStopped: ensureInstanceStoppedMock,
  getInstanceState: getInstanceStateMock,
  getPublicIp: getPublicIpMock,
}));

vi.mock("./notifications.js", () => ({
  getSanitizedErrorMessage: getSanitizedErrorMessageMock,
  sendNotification: sendNotificationMock,
}));

vi.mock("./operation-state.js", () => ({
  claimOperationExecution: claimOperationExecutionMock,
  getOperationState: getOperationStateMock,
  updateOperationState: updateOperationStateMock,
  recordOperationSideEffectCompleted: recordOperationSideEffectCompletedMock,
}));

vi.mock("./lifecycle-lock.js", () => ({
  LifecycleLockConflictError: class LifecycleLockConflictError extends Error {},
  acquireLifecycleLock: acquireLifecycleLockMock,
  assertLifecycleLockOwned: assertLifecycleLockOwnedMock,
  bridgeLegacyLifecycleLock: bridgeLegacyLifecycleLockMock,
  releaseLifecycleLock: releaseLifecycleLockMock,
}));

vi.mock("./ssm.js", () => ({
  deleteParameter: deleteParameterMock,
  executeSSMCommand: executeSSMCommandMock,
  getParameter: getParameterMock,
  putParameter: putParameterMock,
  shouldRetainLifecycleLock: shouldRetainLifecycleLockMock,
  reconcileRemoteCommand: reconcileRemoteCommandMock,
}));

vi.mock("./restore-contract.js", () => ({
  resolveResumeRestoreStrategy: resolveResumeRestoreStrategyMock,
}));

vi.mock("./handlers/backup.js", () => ({
  handleBackup: handleBackupMock,
}));

vi.mock("./handlers/backups.js", () => ({
  handleRefreshBackups: handleRefreshBackupsMock,
}));

vi.mock("./handlers/hibernate.js", () => ({
  handleHibernate: handleHibernateMock,
}));

vi.mock("./handlers/restore.js", () => ({
  handleRestore: handleRestoreMock,
}));

vi.mock("./handlers/resume.js", () => ({
  handleResume: handleResumeMock,
}));

import { handler } from "./index.js";

describe("StartMinecraftServer environment contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INSTANCE_ID = "i-abc123";
    process.env.ADMIN_EMAIL = "admin@example.com";
    process.env.NOTIFICATION_EMAIL = "admin@example.com";
    process.env.VERIFIED_SENDER = "";
    process.env.SES_INBOUND_COMMANDS_ENABLED = "false";
    process.env.START_KEYWORD = "start";

    getPublicIpMock.mockResolvedValue("203.0.113.10");
    sendNotificationMock.mockResolvedValue(undefined);
    getInstanceStateMock.mockResolvedValue("running");
    getSanitizedErrorMessageMock.mockReturnValue("Command execution failed. Check CloudWatch logs for details.");
    resolveResumeRestoreStrategyMock.mockReturnValue({ mode: "fresh" });
    getParameterMock.mockResolvedValue(null);
    getOperationStateMock.mockResolvedValue(null);
    updateOperationStateMock.mockResolvedValue(undefined);
    recordOperationSideEffectCompletedMock.mockResolvedValue(undefined);
    acquireLifecycleLockMock.mockResolvedValue({
      lockId: "email-lock-1",
      fencingToken: 1,
      action: "start",
      ownerEmail: "admin@example.com",
    });
    assertLifecycleLockOwnedMock.mockResolvedValue(undefined);
    bridgeLegacyLifecycleLockMock.mockResolvedValue({ fencingToken: 1 });
    claimOperationExecutionMock.mockResolvedValue({ claimed: true, reason: "claimed", state: { status: "running" } });
    releaseLifecycleLockMock.mockResolvedValue(true);
    shouldRetainLifecycleLockMock.mockImplementation((error) => error?.retainLifecycleLock === true);
    reconcileRemoteCommandMock.mockResolvedValue({ terminal: true, success: false, status: "Failed" });
    executeSSMCommandMock.mockResolvedValue("active");
  });

  it("does not require VERIFIED_SENDER for API start invocation", async () => {
    const response = await handler({
      invocationType: "api",
      instanceId: "i-abc123",
      userEmail: "user@example.com",
      command: "start",
      operationId: "op-1",
      lockId: "lock-start-1",
      fencingToken: 1,
    });

    expect(response).toEqual({ statusCode: 202, body: "Async command 'start' accepted" });
    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(assertLifecycleLockOwnedMock).toHaveBeenCalledWith("lock-start-1", 1, "start");
    expect(putParameterMock).toHaveBeenCalledWith("/minecraft/startup-triggered-by", "user@example.com", "String");
    expect(putParameterMock).not.toHaveBeenCalledWith(
      "/minecraft/resume-pending",
      expect.anything(),
      expect.anything()
    );
    expect(executeSSMCommandMock).toHaveBeenCalledWith(
      "i-abc123",
      [expect.stringContaining("compatibilityFallback")],
      expect.objectContaining({ step: "readiness", finalRemoteStep: true })
    );
  });

  it("executes stop through the durable Lambda lifecycle owner", async () => {
    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "admin@example.com",
        command: "stop",
        operationId: "op-stop",
        lockId: "lock-stop",
        fencingToken: 1,
      })
    ).resolves.toEqual({ statusCode: 202, body: "Async command 'stop' accepted" });

    expect(ensureInstanceStoppedMock).toHaveBeenCalledWith("i-abc123");
    expect(updateOperationStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-stop", status: "completed", phase: "terminal" })
    );
    expect(releaseLifecycleLockMock).toHaveBeenCalledWith("lock-stop", 1, "stop", "admin@example.com");
  });

  it("rejects unknown invocation types without falling through to email parsing", async () => {
    await expect(handler({ invocationType: "unknown" })).resolves.toEqual({
      statusCode: 400,
      body: "Unsupported invocation payload.",
    });
    expect(updateOperationStateMock).not.toHaveBeenCalled();
  });

  it.each([
    { command: "backup", lockId: "lock-1", fencingToken: 1 },
    { command: "backup", operationId: "op-1", lockId: "lock-1", fencingToken: "not-an-integer" },
    { command: "backup", operationId: "op-1", lockId: "lock-1", fencingToken: 1, args: [42] },
  ])("rejects malformed API lifecycle payloads before side effects", async (payload) => {
    await expect(
      handler({ invocationType: "api", instanceId: "i-abc123", userEmail: "user@example.com", ...payload })
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(handleBackupMock).not.toHaveBeenCalled();
    expect(claimOperationExecutionMock).not.toHaveBeenCalled();
  });

  it("bridges an old Worker payload and seeds its missing DynamoDB operation before execution", async () => {
    bridgeLegacyLifecycleLockMock.mockResolvedValueOnce({ fencingToken: 11 });
    getOperationStateMock.mockResolvedValueOnce(null);

    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "user@example.com",
        command: "start",
        operationId: "legacy-op-1",
        lockId: "legacy-lock-1",
      })
    ).resolves.toMatchObject({ statusCode: 202 });
    expect(bridgeLegacyLifecycleLockMock).toHaveBeenCalledWith("legacy-lock-1", "start", "user@example.com");
    expect(updateOperationStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "legacy-op-1", status: "accepted", fencingToken: 11 })
    );
    expect(claimOperationExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "legacy-op-1", fencingToken: 11 })
    );
  });

  it("retains the global lock when a remote command cannot be confirmed terminal", async () => {
    const unresolved = Object.assign(new Error("command still cancelling"), { retainLifecycleLock: true });
    handleBackupMock.mockRejectedValueOnce(unresolved);

    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "user@example.com",
        command: "backup",
        operationId: "op-backup-unresolved",
        lockId: "lock-backup-unresolved",
        fencingToken: 1,
      })
    ).rejects.toThrow("command still cancelling");

    expect(releaseLifecycleLockMock).not.toHaveBeenCalledWith(
      "lock-backup-unresolved",
      1,
      "backup",
      "user@example.com"
    );
    expect(updateOperationStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("does not release the lock when terminal persistence fails", async () => {
    updateOperationStateMock.mockRejectedValue(new Error("DynamoDB unavailable"));

    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "user@example.com",
        command: "backup",
        operationId: "op-terminal-write-failure",
        lockId: "lock-terminal-write-failure",
        fencingToken: 3,
      })
    ).rejects.toThrow("Terminal operation state persistence failed");

    expect(releaseLifecycleLockMock).not.toHaveBeenCalledWith(
      "lock-terminal-write-failure",
      3,
      "backup",
      "user@example.com"
    );
  });

  it("safely skips a scheduled backup when Drive is not connected", async () => {
    getParameterMock.mockResolvedValue(null);

    const response = await handler({
      invocationType: "scheduledBackup",
      eventId: "scheduled-event-1",
      scheduledAt: "2026-08-23T05:00:00.000Z",
    });

    expect(response).toEqual({
      statusCode: 200,
      body: "Scheduled backup skipped because Drive is not connected.",
    });
    expect(acquireLifecycleLockMock).not.toHaveBeenCalled();
    expect(handleBackupMock).not.toHaveBeenCalled();
    expect(updateOperationStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "backup", route: "/scheduled/backup", status: "completed" })
    );
  });

  it("does not start a stopped instance for a scheduled backup", async () => {
    getParameterMock.mockResolvedValue("encrypted-credential-exists");
    getInstanceStateMock.mockResolvedValue("stopped");

    const response = await handler({
      invocationType: "scheduledBackup",
      eventId: "scheduled-event-2",
      scheduledAt: "2026-08-23T05:00:00.000Z",
    });

    expect(response.body).toContain("instance is not running");
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
    expect(acquireLifecycleLockMock).not.toHaveBeenCalled();
    expect(handleBackupMock).not.toHaveBeenCalled();
  });

  it("skips a running instance whose Minecraft service is inactive", async () => {
    getParameterMock.mockResolvedValue("encrypted-credential-exists");
    executeSSMCommandMock.mockResolvedValueOnce("inactive");

    const response = await handler({
      invocationType: "scheduledBackup",
      eventId: "scheduled-inactive-service",
      scheduledAt: "2026-08-23T05:00:00.000Z",
    });

    expect(response.body).toContain("Minecraft is inactive");
    expect(handleBackupMock).not.toHaveBeenCalled();
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
  });

  it("runs a scheduled backup through the shared lock and durable operation state", async () => {
    getParameterMock.mockResolvedValue("encrypted-credential-exists");
    handleBackupMock.mockResolvedValue("backup complete");

    const response = await handler({
      invocationType: "scheduledBackup",
      eventId: "scheduled-event-3",
      scheduledAt: "2026-08-23T05:00:00.000Z",
    });

    expect(response).toEqual({ statusCode: 200, body: "Scheduled backup completed." });
    expect(acquireLifecycleLockMock).toHaveBeenCalledWith("backup", "scheduled-backup@mc-aws.internal");
    expect(claimOperationExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "backup", lockId: "email-lock-1", fencingToken: 1 })
    );
    expect(handleBackupMock).toHaveBeenCalledWith("i-abc123", [expect.stringMatching(/^scheduled-backup-/)], "", {
      requireAlreadyRunning: true,
      requireServiceActive: true,
    });
    expect(putParameterMock).toHaveBeenCalledWith(
      "/minecraft/last-scheduled-backup-success",
      expect.any(String),
      "String"
    );
    expect(updateOperationStateMock).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(releaseLifecycleLockMock).toHaveBeenCalledWith(
      "email-lock-1",
      1,
      "backup",
      "scheduled-backup@mc-aws.internal"
    );
  });

  it("persists resume-pending before reconstruction and clears it only after command success", async () => {
    let resumeMarker: string | null = null;
    putParameterMock.mockImplementation(async (name: string, value: string) => {
      if (name === "/minecraft/resume-pending") resumeMarker = value;
    });
    getParameterMock.mockImplementation(async (name: string) =>
      name === "/minecraft/resume-pending" ? resumeMarker : null
    );
    resolveResumeRestoreStrategyMock.mockReturnValue({
      mode: "named",
      backupArchiveName: "nightly-2026.tar.gz",
    });

    await handler({
      invocationType: "api",
      instanceId: "i-abc123",
      userEmail: "user@example.com",
      command: "resume",
      restoreMode: "named",
      args: ["nightly-2026.tar.gz"],
      operationId: "op-resume",
      lockId: "lock-resume-1",
      fencingToken: 1,
    });

    const pendingWrite = putParameterMock.mock.calls.find((call) => call[0] === "/minecraft/resume-pending");
    expect(pendingWrite).toBeDefined();
    expect(JSON.parse(pendingWrite?.[1])).toMatchObject({
      version: 1,
      operationId: "op-resume",
      mode: "named",
      backupArchiveName: "nightly-2026.tar.gz",
    });
    expect(pendingWrite?.[3]).toBe(false);
    expect(putParameterMock.mock.invocationCallOrder[1]).toBeLessThan(handleResumeMock.mock.invocationCallOrder[0]);
    expect(executeSSMCommandMock).toHaveBeenCalledWith("i-abc123", [expect.stringContaining("bootstrap-complete")], {
      maxAttempts: 165,
      timeoutSeconds: 300,
      step: "resume-restore",
      finalRemoteStep: false,
    });
    expect(executeSSMCommandMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteParameterMock.mock.invocationCallOrder[0]
    );
    expect(deleteParameterMock).toHaveBeenCalledWith("/minecraft/resume-pending");
    const terminalWrite = updateOperationStateMock.mock.calls.findIndex(
      ([input]) => input.command === "resume" && input.status === "completed"
    );
    const markerDelete = deleteParameterMock.mock.calls.findIndex(([name]) => name === "/minecraft/resume-pending");
    expect(updateOperationStateMock.mock.invocationCallOrder[terminalWrite]).toBeLessThan(
      deleteParameterMock.mock.invocationCallOrder[markerDelete]
    );
  });

  it("adopts its own resume marker after a crash and retries idempotently", async () => {
    resolveResumeRestoreStrategyMock.mockReturnValue({ mode: "latest" });
    const marker = JSON.stringify({
      version: 1,
      operationId: "op-resume-retry",
      mode: "latest",
      backupArchiveName: null,
      createdAt: "2026-04-13T12:00:00.000Z",
    });
    putParameterMock.mockImplementation(async (name: string) => {
      if (name === "/minecraft/resume-pending") {
        throw Object.assign(new Error("already exists"), { name: "ParameterAlreadyExists" });
      }
    });
    getParameterMock.mockImplementation(async (name: string) => (name === "/minecraft/resume-pending" ? marker : null));

    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "user@example.com",
        command: "resume",
        restoreMode: "latest",
        operationId: "op-resume-retry",
        lockId: "lock-resume-retry",
        fencingToken: 1,
      })
    ).resolves.toMatchObject({ statusCode: 202 });

    expect(handleResumeMock).toHaveBeenCalledWith("i-abc123");
    expect(deleteParameterMock).toHaveBeenCalledWith("/minecraft/resume-pending");
  });

  it("retains ownership when a resume marker belongs to another unresolved operation", async () => {
    putParameterMock.mockImplementation(async (name: string) => {
      if (name === "/minecraft/resume-pending") {
        throw Object.assign(new Error("already exists"), { name: "ParameterAlreadyExists" });
      }
    });
    getParameterMock.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        operationId: "op-other-resume",
        mode: "latest",
        backupArchiveName: null,
        createdAt: "2026-04-13T12:00:00.000Z",
      })
    );
    getOperationStateMock.mockResolvedValueOnce({ status: "running", phase: "executing" });

    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "user@example.com",
        command: "resume",
        restoreMode: "latest",
        operationId: "op-stale-resume",
        lockId: "lock-resume-stale",
        fencingToken: 1,
      })
    ).rejects.toThrow("owned by another unresolved operation");

    expect(handleResumeMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
    expect(deleteParameterMock).not.toHaveBeenCalledWith("/minecraft/resume-pending");
    expect(getParameterMock).toHaveBeenCalledWith("/minecraft/resume-pending");
    expect(updateOperationStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(releaseLifecycleLockMock).not.toHaveBeenCalled();
  });

  const sanitizedEmailCommand = {
    invocationType: "emailCommand",
    operationId: `email-${"a".repeat(40)}`,
    command: "backup",
    args: [],
    requestedAt: "2026-04-13T12:00:00.000Z",
  };

  it("rejects raw SNS email and confidential fields at the lifecycle boundary", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    await expect(handler({ Records: [{}] })).resolves.toMatchObject({ statusCode: 400 });
    await expect(handler({ ...sanitizedEmailCommand, senderEmail: "admin@example.com" })).resolves.toMatchObject({
      statusCode: 400,
    });
    expect(acquireLifecycleLockMock).not.toHaveBeenCalled();
  });

  it("returns a clear error for sanitized email commands when inbound commands are disabled", async () => {
    await expect(handler(sanitizedEmailCommand)).resolves.toEqual({
      statusCode: 503,
      body: "Email commands are disabled. Enable and configure inbound SES commands before using this endpoint.",
    });
  });

  it("executes only sanitized command metadata under an opaque owner", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    handleBackupMock.mockResolvedValue("backup complete");

    await expect(handler(sanitizedEmailCommand)).resolves.toEqual({ statusCode: 200, body: "backup complete" });
    expect(acquireLifecycleLockMock).toHaveBeenCalledWith("backup", "email-command@mc-aws.internal");
    expect(updateOperationStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: sanitizedEmailCommand.operationId,
        userEmail: "email-command@mc-aws.internal",
      })
    );
  });

  it("skips duplicate sanitized email delivery using its opaque operation ID", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    getOperationStateMock.mockResolvedValue({ status: "completed" });

    await expect(handler(sanitizedEmailCommand)).resolves.toEqual({
      statusCode: 200,
      body: "Command already recorded as completed.",
    });
    expect(acquireLifecycleLockMock).not.toHaveBeenCalled();
  });

  it("rethrows retryable sanitized email failures without terminalizing them", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    handleBackupMock.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));

    await expect(handler(sanitizedEmailCommand)).rejects.toThrow("throttled");
    expect(updateOperationStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(releaseLifecycleLockMock).not.toHaveBeenCalled();
  });

  it("terminalizes confirmed sanitized email execution failures", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    handleBackupMock.mockRejectedValueOnce(Object.assign(new Error("fixed-code"), { ssmTerminal: true }));

    await expect(handler(sanitizedEmailCommand)).resolves.toMatchObject({ statusCode: 500 });
    expect(updateOperationStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", phase: "terminal" })
    );
    expect(releaseLifecycleLockMock).toHaveBeenCalled();
  });

  it("reclaims a stale attempt only after remote terminal reconciliation", async () => {
    getOperationStateMock.mockResolvedValue({
      status: "running",
      phase: "executing",
      lockId: "lock-stale",
      fencingToken: 7,
      executionToken: "attempt-old",
    });
    assertLifecycleLockOwnedMock.mockResolvedValue({
      lockId: "lock-stale",
      fencingToken: 7,
      action: "backup",
      ownerEmail: "scheduled-backup@mc-aws.internal",
    });
    claimOperationExecutionMock
      .mockResolvedValueOnce({
        claimed: false,
        reason: "stale",
        state: {
          executionToken: "attempt-old",
          remoteCommandId: "command-old",
          remoteCommandInstanceId: "i-abc123",
          remoteCommandFinal: false,
        },
      })
      .mockResolvedValueOnce({ claimed: true, reason: "reclaimed", state: { executionAttempt: 2 } });
    reconcileRemoteCommandMock.mockResolvedValueOnce({ terminal: true, success: false, status: "Failed" });
    getParameterMock.mockResolvedValue("drive-token");
    executeSSMCommandMock.mockResolvedValue("active");
    handleBackupMock.mockResolvedValue("backup complete");

    await expect(
      handler(
        { invocationType: "scheduledBackup", eventId: "stale-event", scheduledAt: "2026-08-23T05:00:00.000Z" },
        { awsRequestId: "attempt-new", getRemainingTimeInMillis: () => 900_000 }
      )
    ).resolves.toMatchObject({ statusCode: 200, body: "Scheduled backup completed." });
    expect(reconcileRemoteCommandMock).toHaveBeenCalled();
    expect(claimOperationExecutionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        staleExecutionToken: "attempt-old",
        executionToken: expect.stringContaining("attempt-new"),
      })
    );
  });

  it("takes over hibernate after a successful final SSM step when root deletion is incomplete", async () => {
    claimOperationExecutionMock
      .mockResolvedValueOnce({
        claimed: false,
        reason: "stale",
        state: {
          executionToken: "attempt-old",
          remoteCommandId: "command-refresh",
          remoteCommandInstanceId: "i-abc123",
          remoteCommandFinal: true,
          remoteCommandStep: "refresh-backups",
          hibernatePhase: "cache-refreshed",
        },
      })
      .mockResolvedValueOnce({ claimed: true, reason: "reclaimed", state: { executionAttempt: 2 } });
    reconcileRemoteCommandMock.mockResolvedValueOnce({ terminal: true, success: true, status: "Success" });
    handleHibernateMock.mockResolvedValue("hibernated");

    await expect(
      handler(
        {
          invocationType: "api",
          instanceId: "i-abc123",
          userEmail: "admin@example.com",
          command: "hibernate",
          operationId: "op-hibernate-post-ssm",
          lockId: "lock-hibernate",
          fencingToken: 1,
        },
        { awsRequestId: "attempt-new", getRemainingTimeInMillis: () => 900_000 }
      )
    ).resolves.toMatchObject({ statusCode: 202 });

    expect(claimOperationExecutionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ staleExecutionToken: "attempt-old" })
    );
    expect(handleHibernateMock).toHaveBeenCalled();
  });

  it("reconciles stop from observed EC2 stopped state after terminal persistence was lost", async () => {
    getInstanceStateMock.mockResolvedValueOnce("stopped");
    claimOperationExecutionMock.mockResolvedValueOnce({
      claimed: false,
      reason: "stale",
      state: { executionToken: "attempt-old", executionLeaseExpiresAt: "2020-01-01T00:00:00.000Z" },
    });

    await expect(
      handler({
        invocationType: "api",
        instanceId: "i-abc123",
        userEmail: "admin@example.com",
        command: "stop",
        operationId: "op-stop-reconcile",
        lockId: "lock-stop-reconcile",
        fencingToken: 1,
      })
    ).resolves.toMatchObject({ statusCode: 202 });

    expect(ensureInstanceStoppedMock).not.toHaveBeenCalled();
    expect(updateOperationStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-stop-reconcile", status: "completed", phase: "terminal" })
    );
    expect(releaseLifecycleLockMock).toHaveBeenCalled();
  });
});
