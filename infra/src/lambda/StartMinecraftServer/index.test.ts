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

import { handler } from "./index.js";

describe("StartMinecraftServer environment contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INSTANCE_ID = "i-abc123";
    process.env.ADMIN_EMAIL = "admin@example.com";
    process.env.NOTIFICATION_EMAIL = "admin@example.com";
    process.env.VERIFIED_SENDER = "";

    getPublicIpMock.mockResolvedValue("203.0.113.10");
    getAllowlistMock.mockResolvedValue([]);
    extractEmailsMock.mockReturnValue([]);
    parseCommandMock.mockReturnValue({ command: "start", args: [] });
    getSanitizedErrorMessageMock.mockReturnValue("Command execution failed. Check CloudWatch logs for details.");
    resolveResumeRestoreStrategyMock.mockReturnValue({ mode: "fresh" });
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
  });

  it("returns clear error for email invocation when VERIFIED_SENDER is missing", async () => {
    parseEmailFromEventMock.mockReturnValue({
      senderEmail: "friend@example.com",
      subject: "start",
      body: "start",
      verdicts: { spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });

    const response = await handler({ Records: [] });

    expect(response).toEqual({
      statusCode: 503,
      body: "Email commands are disabled. Configure VERIFIED_SENDER to enable SES email flows.",
    });
  });
});
