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

const authenticatedOutput = `MC_BACKUP_MANIFEST_RESULT ${JSON.stringify({
  archiveName: "nightly.tar.gz",
  archiveSha256: "a".repeat(64),
  archiveSize: 42,
  authenticationKeyId: "key-old",
  backupId: "b".repeat(32),
  createdAt: "2026-09-04T00:00:00Z",
  generation: 7,
  instanceId: "i-abc123456",
  operationKey: null,
  serverId: "stack-identity",
})}`;
const terminalHibernateOutput = `MC_BACKUP_QUIESCENCE_RESULT ${JSON.stringify({
  schemaVersion: 2,
  mode: "terminal-hibernate",
  maintenanceFence: "held",
  maintenanceOwner: "hibernate-fixture",
  services: "stopped-and-masked",
  minecraft: "inactive",
  protocol: "closed",
  bootId: "boot-fixture",
  rootVolumeId: "vol-12345678",
  rootVolumeDevice: "/dev/xvda",
  quiescenceEpoch: "c".repeat(32),
})}
${authenticatedOutput}`;

describe("handleBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sanitizeBackupNameMock.mockImplementation((value: string) => value);
    getSanitizedErrorMessageMock.mockReturnValue("Backup command failed. Check CloudWatch logs for details.");
    getInstanceStateMock.mockResolvedValue("running");
  });

  it("returns success only when backup script succeeds", async () => {
    executeSSMCommandMock.mockResolvedValue(authenticatedOutput);
    handleRefreshBackupsMock.mockResolvedValue(undefined);

    await expect(handleBackup("i-abc123", ["nightly"], "")).resolves.toMatchObject({
      message: expect.stringContaining("Backup completed successfully"),
      manifest: expect.objectContaining({ backupId: "b".repeat(32) }),
    });

    expect(ensureInstanceRunningMock).toHaveBeenCalledWith("i-abc123");
    expect(executeSSMCommandMock).toHaveBeenCalledWith("i-abc123", ["/usr/local/bin/mc-backup.sh 'nightly'"], {
      step: "backup",
      finalRemoteStep: false,
    });
    expect(handleRefreshBackupsMock).toHaveBeenCalledWith("i-abc123", { allowOwnedLifecycleOperation: true });
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

  it("does not let notification failure replace retained host-recovery ownership", async () => {
    const recovery = Object.assign(new Error("service restoration pending"), {
      hostRecoveryRequired: true,
      retainLifecycleLock: true,
      code: "host_service_restoration_pending",
    });
    executeSSMCommandMock.mockRejectedValue(recovery);
    sendNotificationMock.mockRejectedValue(new Error("notification unavailable"));

    await expect(handleBackup("i-abc123", [], "admin@example.com")).rejects.toBe(recovery);
  });

  it("never starts EC2 when a scheduled backup requires an already-running instance", async () => {
    getInstanceStateMock.mockResolvedValue("stopped");

    await expect(handleBackup("i-abc123", [], "", { requireAlreadyRunning: true })).rejects.toMatchObject({
      name: "ScheduledBackupInstanceNotRunning",
    });

    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
  });

  it("never starts EC2 and reports unavailable for a strict agent backup after a stop race", async () => {
    getInstanceStateMock.mockResolvedValue("stopping");

    await expect(
      handleBackup("i-abc123", [], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
        strictAgentBackup: true,
      })
    ).rejects.toMatchObject({ name: "TerminalLifecycleError", code: "agent_backup_unavailable" });
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).not.toHaveBeenCalled();
  });

  it("fails unavailable when minecraft.service stops at strict backup execution time", async () => {
    executeSSMCommandMock
      .mockResolvedValueOnce("supported")
      .mockRejectedValueOnce(new Error("mc-backup --require-active rejected inactive service"));
    getInstanceStateMock.mockResolvedValueOnce("running").mockResolvedValueOnce("stopping");

    await expect(
      handleBackup("i-abc123", ["agent-op"], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
        strictAgentBackup: true,
      })
    ).rejects.toMatchObject({ name: "TerminalLifecycleError", code: "agent_backup_unavailable" });
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
    expect(executeSSMCommandMock).toHaveBeenNthCalledWith(
      2,
      "i-abc123",
      ["/usr/local/bin/mc-backup.sh --require-active 'agent-op'"],
      { step: "backup", finalRemoteStep: false }
    );
    expect(handleRefreshBackupsMock).not.toHaveBeenCalled();
  });

  it("feature-detects require-active before using the new scheduled host flag", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("supported").mockResolvedValueOnce(authenticatedOutput);
    handleRefreshBackupsMock.mockResolvedValue(undefined);

    await expect(
      handleBackup("i-abc123", ["scheduled-op"], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
      })
    ).resolves.toMatchObject({ message: expect.stringContaining("Backup completed successfully") });
    expect(executeSSMCommandMock).toHaveBeenNthCalledWith(
      2,
      "i-abc123",
      ["/usr/local/bin/mc-backup.sh --require-active 'scheduled-op'"],
      { step: "backup", finalRemoteStep: false }
    );
    expect(handleRefreshBackupsMock).toHaveBeenCalledWith("i-abc123", { allowOwnedLifecycleOperation: true });
    expect(ensureInstanceRunningMock).not.toHaveBeenCalled();
  });

  it("uses the explicit two-phase host path for an agent backup without changing ordinary backups", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("supported").mockResolvedValueOnce(authenticatedOutput);
    handleRefreshBackupsMock.mockResolvedValue(undefined);

    await expect(
      handleBackup("i-abc123", ["agent-op"], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
        strictAgentBackup: true,
        agentTwoPhase: true,
      })
    ).resolves.toMatchObject({ message: expect.stringContaining("Backup completed successfully") });

    expect(executeSSMCommandMock).toHaveBeenNthCalledWith(
      2,
      "i-abc123",
      ["/usr/local/bin/mc-backup.sh --require-active --agent-two-phase 'agent-op'"],
      { step: "backup", finalRemoteStep: false }
    );
  });

  it("skips safely instead of invoking unsupported flags on a legacy host", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("unsupported");

    await expect(
      handleBackup("i-abc123", [], "", { requireAlreadyRunning: true, requireServiceActive: true })
    ).rejects.toMatchObject({ name: "ScheduledBackupHostIncompatible" });
    expect(executeSSMCommandMock).toHaveBeenCalledOnce();
  });

  it("requires terminal quiescence evidence for hibernate backups", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("supported").mockResolvedValueOnce(terminalHibernateOutput);
    handleRefreshBackupsMock.mockResolvedValue({ matchedBackup: true });

    await expect(
      handleBackup("i-abc123", ["hibernate"], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
        strictAgentBackup: true,
        backupMode: "hibernate",
        requireFreshBackup: true,
      })
    ).resolves.toMatchObject({ manifest: { quiescence: { mode: "terminal-hibernate" } } });
    expect(executeSSMCommandMock).toHaveBeenNthCalledWith(
      2,
      "i-abc123",
      ["/usr/local/bin/mc-backup.sh --hibernate --require-active 'hibernate'"],
      { step: "hibernate-backup", finalRemoteStep: false }
    );
  });

  it("rejects a hibernate backup without held-quiescence evidence", async () => {
    executeSSMCommandMock.mockResolvedValueOnce("supported").mockResolvedValueOnce(authenticatedOutput);

    await expect(
      handleBackup("i-abc123", [], "", {
        requireAlreadyRunning: true,
        requireServiceActive: true,
        strictAgentBackup: true,
        backupMode: "hibernate",
      })
    ).rejects.toMatchObject({ code: "hibernate_quiescence_evidence_missing" });
  });
});
