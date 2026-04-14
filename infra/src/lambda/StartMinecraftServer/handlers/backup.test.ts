import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureInstanceRunningMock,
  getSanitizedErrorMessageMock,
  sendNotificationMock,
  sanitizeBackupNameMock,
  executeSSMCommandMock,
  handleRefreshBackupsMock,
} = vi.hoisted(() => ({
  ensureInstanceRunningMock: vi.fn(),
  getSanitizedErrorMessageMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  sanitizeBackupNameMock: vi.fn(),
  executeSSMCommandMock: vi.fn(),
  handleRefreshBackupsMock: vi.fn(),
}));

vi.mock("../ec2.js", () => ({
  ensureInstanceRunning: ensureInstanceRunningMock,
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
  });

  it("returns success only when backup script succeeds", async () => {
    executeSSMCommandMock.mockResolvedValue("backup ok");
    handleRefreshBackupsMock.mockResolvedValue(undefined);

    await expect(handleBackup("i-abc123", ["nightly"], "")).resolves.toContain("Backup completed successfully");

    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(executeSSMCommandMock).toHaveBeenCalledWith("i-abc123", ["/usr/local/bin/mc-backup.sh nightly"]);
    expect(handleRefreshBackupsMock).toHaveBeenCalledWith("i-abc123");
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
});
