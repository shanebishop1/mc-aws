import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureInstanceRunningMock,
  getPublicIpMock,
  getSanitizedErrorMessageMock,
  sendNotificationMock,
  updateOperationStateMock,
  deleteParameterMock,
  executeSSMCommandMock,
  getParameterMock,
  putParameterMock,
  extractEmailsMock,
  getAllowlistMock,
  updateAllowlistMock,
  parseCommandMock,
  parseEmailFromEventMock,
  resolveResumeRestoreStrategyMock,
  handleBackupMock,
  handleRefreshBackupsMock,
  handleHibernateMock,
  handleRestoreMock,
  handleResumeMock,
} = vi.hoisted(() => ({
  ensureInstanceRunningMock: vi.fn(),
  getPublicIpMock: vi.fn(),
  getSanitizedErrorMessageMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  updateOperationStateMock: vi.fn(),
  deleteParameterMock: vi.fn(),
  executeSSMCommandMock: vi.fn(),
  getParameterMock: vi.fn(),
  putParameterMock: vi.fn(),
  extractEmailsMock: vi.fn(),
  getAllowlistMock: vi.fn(),
  updateAllowlistMock: vi.fn(),
  parseCommandMock: vi.fn(),
  parseEmailFromEventMock: vi.fn(),
  resolveResumeRestoreStrategyMock: vi.fn(),
  handleBackupMock: vi.fn(),
  handleRefreshBackupsMock: vi.fn(),
  handleHibernateMock: vi.fn(),
  handleRestoreMock: vi.fn(),
  handleResumeMock: vi.fn(),
}));

vi.mock("./ec2.js", () => ({
  ensureInstanceRunning: ensureInstanceRunningMock,
  getPublicIp: getPublicIpMock,
}));

vi.mock("./notifications.js", () => ({
  getSanitizedErrorMessage: getSanitizedErrorMessageMock,
  sendNotification: sendNotificationMock,
}));

vi.mock("./operation-state.js", () => ({
  updateOperationState: updateOperationStateMock,
}));

vi.mock("./ssm.js", () => ({
  deleteParameter: deleteParameterMock,
  executeSSMCommand: executeSSMCommandMock,
  getParameter: getParameterMock,
  putParameter: putParameterMock,
}));

vi.mock("./allowlist.js", () => ({
  extractEmails: extractEmailsMock,
  getAllowlist: getAllowlistMock,
  updateAllowlist: updateAllowlistMock,
}));

vi.mock("./command-parser.js", () => ({
  parseCommand: parseCommandMock,
}));

vi.mock("./email-parser.js", () => ({
  parseEmailFromEvent: parseEmailFromEventMock,
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

import { handler, verifyEmailAuthenticity } from "./index.js";

describe("email sender authentication", () => {
  it("requires SPF, DKIM, and DMARC to pass", () => {
    expect(verifyEmailAuthenticity({ spf: "PASS", dkim: "PASS", dmarc: "PASS" })).toBe(true);
    expect(verifyEmailAuthenticity({ spf: "FAIL", dkim: "PASS", dmarc: "PASS" })).toBe(false);
    expect(verifyEmailAuthenticity({ spf: "PASS", dkim: "FAIL", dmarc: "PASS" })).toBe(false);
    expect(verifyEmailAuthenticity({ spf: "PASS", dkim: "PASS", dmarc: "FAIL" })).toBe(false);
  });
});

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
    getAllowlistMock.mockResolvedValue(["notify@example.com"]);
    extractEmailsMock.mockReturnValue([]);
    parseCommandMock.mockReturnValue({ command: "start", args: [] });
    getSanitizedErrorMessageMock.mockReturnValue("Command execution failed. Check CloudWatch logs for details.");
    resolveResumeRestoreStrategyMock.mockReturnValue({ mode: "fresh" });
    getParameterMock.mockResolvedValue(null);
    executeSSMCommandMock.mockResolvedValue("resume complete");
  });

  it("does not require VERIFIED_SENDER for API start invocation", async () => {
    const response = await handler({
      invocationType: "api",
      instanceId: "i-abc123",
      userEmail: "user@example.com",
      command: "start",
      operationId: "op-1",
    });

    expect(response).toEqual({ statusCode: 202, body: "Async command 'start' accepted" });
    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(putParameterMock).toHaveBeenCalledWith("/minecraft/startup-triggered-by", "user@example.com", "String");
    expect(putParameterMock).not.toHaveBeenCalledWith(
      "/minecraft/resume-pending",
      expect.anything(),
      expect.anything()
    );
  });

  it("persists resume-pending before reconstruction and clears it only after command success", async () => {
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
    });

    const pendingWrite = putParameterMock.mock.calls.find((call) => call[0] === "/minecraft/resume-pending");
    expect(pendingWrite).toBeDefined();
    expect(JSON.parse(pendingWrite?.[1])).toMatchObject({
      version: 1,
      mode: "named",
      backupArchiveName: "nightly-2026.tar.gz",
    });
    expect(pendingWrite?.[3]).toBe(false);
    expect(putParameterMock.mock.invocationCallOrder[1]).toBeLessThan(handleResumeMock.mock.invocationCallOrder[0]);
    expect(executeSSMCommandMock).toHaveBeenCalledWith("i-abc123", [expect.stringContaining("bootstrap-complete")], {
      maxAttempts: 285,
      timeoutSeconds: 560,
    });
    expect(executeSSMCommandMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteParameterMock.mock.invocationCallOrder[0]
    );
    expect(deleteParameterMock).toHaveBeenCalledWith("/minecraft/resume-pending");
  });

  it("refuses a stale resume marker without reconstructing or clearing it", async () => {
    putParameterMock.mockImplementation(async (name: string) => {
      if (name === "/minecraft/resume-pending") {
        throw Object.assign(new Error("already exists"), { name: "ParameterAlreadyExists" });
      }
    });

    await handler({
      invocationType: "api",
      instanceId: "i-abc123",
      userEmail: "user@example.com",
      command: "resume",
      restoreMode: "latest",
      operationId: "op-stale-resume",
    });

    expect(handleResumeMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
    expect(deleteParameterMock).not.toHaveBeenCalledWith("/minecraft/resume-pending");
    expect(getParameterMock).not.toHaveBeenCalledWith("/minecraft/resume-pending");
    expect(updateOperationStateMock).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("returns clear error for email invocation when inbound commands are disabled", async () => {
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "friend@example.com",
      subject: "start",
      body: "start",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });

    const response = await handler({ Records: [] });

    expect(response).toEqual({
      statusCode: 503,
      body: "Email commands are disabled. Enable and configure inbound SES commands before using this endpoint.",
    });
  });

  it("does not grant admin command authority to the notification recipient", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    process.env.NOTIFICATION_EMAIL = "notify@example.com";
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "notify@example.com",
      subject: "backup",
      body: "",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
    parseCommandMock.mockReturnValue(null);

    const response = await handler({ Records: [{}] });

    expect(response).toEqual({
      statusCode: 200,
      body: "No valid command found.",
    });
    expect(parseCommandMock).not.toHaveBeenCalled();
    expect(handleBackupMock).not.toHaveBeenCalled();
  });

  it("requires the exact start keyword from an allowed sender", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "notify@example.com",
      subject: "please start",
      body: "",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
    parseCommandMock.mockReturnValue(null);

    const response = await handler({ Records: [{}] });

    expect(response).toEqual({ statusCode: 200, body: "No valid command found." });
    expect(parseCommandMock).not.toHaveBeenCalled();
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
  });

  it("accepts an exact multi-word start keyword from an allowed sender", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    process.env.START_KEYWORD = "wake server";
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "notify@example.com",
      subject: "wake server",
      body: "",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });

    const response = await handler({ Records: [{}] });

    expect(response).toEqual({ statusCode: 200, body: "Instance started at IP: 203.0.113.10" });
    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(parseCommandMock).not.toHaveBeenCalled();
  });

  it("accepts an exact multi-word start keyword from the admin", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    process.env.START_KEYWORD = "wake server";
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "admin@example.com",
      subject: "wake server",
      body: "",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });

    const response = await handler({ Records: [{}] });

    expect(response).toEqual({ statusCode: 200, body: "Instance started at IP: 203.0.113.10" });
    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(parseCommandMock).not.toHaveBeenCalled();
  });

  it("does not update the allowlist from an admin command body", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "admin@example.com",
      subject: "backup",
      body: "friend@example.com",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
    extractEmailsMock.mockReturnValue(["friend@example.com"]);
    parseCommandMock.mockReturnValue({ command: "backup", args: [] });
    handleBackupMock.mockResolvedValue("backup complete");

    const response = await handler({ Records: [{}] });

    expect(response).toEqual({ statusCode: 200, body: "backup complete" });
    expect(updateAllowlistMock).not.toHaveBeenCalled();
  });

  it("updates the allowlist only with the explicit admin subject", async () => {
    process.env.SES_INBOUND_COMMANDS_ENABLED = "true";
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "admin@example.com",
      subject: "allowlist",
      body: "friend@example.com",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
    extractEmailsMock.mockReturnValue(["friend@example.com"]);

    const response = await handler({ Records: [{}] });

    expect(response).toEqual({ statusCode: 200, body: "Allowlist updated successfully." });
    expect(updateAllowlistMock).toHaveBeenCalledWith(["admin@example.com", "friend@example.com"]);
    expect(parseCommandMock).not.toHaveBeenCalled();
  });
});
