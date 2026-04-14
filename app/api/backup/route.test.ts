import type { ApiResponse, BackupResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  invokeLambda: vi.fn(),
  findInstanceId: vi.fn().mockResolvedValue("i-1234"),
  getInstanceState: vi.fn().mockResolvedValue("running"),
  executeSSMCommand: vi.fn().mockResolvedValue("active"),
  acquireServerActionLock: vi.fn().mockResolvedValue({ lockId: "lock-backup-123" }),
  releaseServerActionLock: vi.fn().mockResolvedValue(true),
  isServerActionLockConflictError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/aws", () => ({
  invokeLambda: mocks.invokeLambda,
  findInstanceId: mocks.findInstanceId,
  getInstanceState: mocks.getInstanceState,
  executeSSMCommand: mocks.executeSSMCommand,
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
}));

vi.mock("@/lib/sanitization", () => ({
  sanitizeBackupName: vi.fn(),
}));

vi.mock("@/lib/server-action-lock", () => ({
  acquireServerActionLock: mocks.acquireServerActionLock,
  releaseServerActionLock: mocks.releaseServerActionLock,
  isServerActionLockConflictError: mocks.isServerActionLockConflictError,
}));

describe("POST /api/backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns accepted operation metadata for async backups", async () => {
    const req = createMockNextRequest("http://localhost/api/backup", {
      method: "POST",
      body: JSON.stringify({ name: "nightly-2026" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(202);
    const body = await parseNextResponse<ApiResponse<BackupResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.backupName).toBe("nightly-2026");
    expect(body.operation?.type).toBe("backup");
    expect(body.operation?.status).toBe("accepted");
    expect(body.operation?.id).toContain("backup-");

    expect(mocks.invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", {
      invocationType: "api",
      command: "backup",
      instanceId: "i-1234",
      userEmail: "admin@example.com",
      args: ["nightly-2026"],
      lockId: "lock-backup-123",
    });
  });

  it("returns failed operation metadata for invalid state", async () => {
    mocks.getInstanceState.mockResolvedValue("stopped");

    const req = createMockNextRequest("http://localhost/api/backup", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("must be running");
    expect(body.operation?.type).toBe("backup");
    expect(body.operation?.status).toBe("failed");

    expect(mocks.invokeLambda).not.toHaveBeenCalled();
  });
});
