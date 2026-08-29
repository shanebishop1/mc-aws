import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureInstanceRunningMock,
  getInstanceStateMock,
  getSanitizedErrorMessageMock,
  sendNotificationMock,
  sanitizeBackupNameMock,
  executeSSMCommandMock,
  handleRefreshBackupsMock,
} = vi.hoisted(() => ({
  ensureInstanceRunningMock: vi.fn(),
  getInstanceStateMock: vi.fn(),
  getSanitizedErrorMessageMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  sanitizeBackupNameMock: vi.fn(),
  executeSSMCommandMock: vi.fn(),
  handleRefreshBackupsMock: vi.fn(),
}));

vi.mock("../ec2.js", () => ({
  ensureInstanceRunning: ensureInstanceRunningMock,
  getInstanceState: getInstanceStateMock,
}));

vi.mock("../notifications.js", () => ({
  getSanitizedErrorMessage: getSanitizedErrorMessageMock,
  sendNotification: sendNotificationMock,
}));

vi.mock("../sanitization.js", () => ({
  sanitizeBackupName: sanitizeBackupNameMock,
}));

vi.mock("../ssm.js", () => ({
  executeSSMCommand: executeSSMCommandMock,
}));

vi.mock("./backups.js", () => ({
  handleRefreshBackups: handleRefreshBackupsMock,
}));

import { handleBackup } from "./backup.js";

describe("handleBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sanitizeBackupNameMock.mockImplementation((value: string) => value);
    getSanitizedErrorMessageMock.mockReturnValue("Backup command failed. Check CloudWatch logs for details.");
    getInstanceStateMock.mockResolvedValue("running");
  });

  it("returns success only when backup script succeeds", async () => {
    executeSSMCommandMock.mockResolvedValue("backup ok");
    handleRefreshBackupsMock.mockResolvedValue(undefined);

    await expect(handleBackup("i-abc123", ["nightly"], "")).resolves.toContain("Backup completed successfully");

    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(executeSSMCommandMock).toHaveBeenCalledWith("i-abc123", ["/usr/local/bin/mc-backup.sh 'nightly'"], {
      step: "backup",
      finalRemoteStep: false,
    });
    expect(handleRefreshBackupsMock).toHaveBeenCalledWith("i-abc123", { requireAlreadyRunning: false });
  });

  it("propagates backup script failure and sends failure notification", async () => {
    executeSSMCommandMock.mockRejectedValue(new Error("SSM command failed: restart failed"));

    await expect(handleBackup("i-abc123", [], "admin@example.com")).rejects.toThrow("restart failed");

    expect(sendNotificationMock).toHaveBeenCalledWith(
      "admin@example.com",
      "Minecraft Backup Failed",
      "Backup command failed. Check CloudWatch logs for details."
    );
  });

  it("never starts EC2 when a scheduled backup requires an already-running instance", async () => {
    getInstanceStateMock.mockResolvedValue("stopped");

    await expect(handleBackup("i-abc123", [], "", { requireAlreadyRunning: true })).rejects.toMatchObject({
      name: "ScheduledBackupInstanceNotRunning",
    });

    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
  });

  it("feature-detects require-active before using the new scheduled host flag", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("supported").mockResolvedValueOnce("backup ok");
    handleRefreshBackupsMock.mockResolvedValue(undefined);

    await expect(
      handleBackup("i-abc123", ["scheduled-op"], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
      })
    ).resolves.toContain("Backup completed successfully");
    expect(executeSSMCommandMock).toHaveBeenNthCalledWith(
      2,
      "i-abc123",
      ["/usr/local/bin/mc-backup.sh --require-active 'scheduled-op'"],
      { step: "backup", finalRemoteStep: false }
    );
    expect(handleRefreshBackupsMock).toHaveBeenCalledWith("i-abc123", { requireAlreadyRunning: true });
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
  });

  it("skips safely instead of invoking unsupported flags on a legacy host", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("unsupported");

    await expect(
      handleBackup("i-abc123", [], "", { requireAlreadyRunning: true, requireServiceActive: true })
    ).rejects.toMatchObject({ name: "ScheduledBackupHostIncompatible" });
    expect(executeSSMCommandMock).toHaveBeenCalledOnce();
  });
});
