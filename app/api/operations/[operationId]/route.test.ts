import type { DurableOperationState } from "@/lib/durable-operation-state";
import type { ApiResponse, OperationStatusData } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  requireAllowed: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
  getDurableOperationState: vi.fn(),
  expireAcceptedDispatchIfDeadlineElapsed: vi.fn(),
  releaseServerActionLockIfOwned: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAllowed: mocks.requireAllowed,
}));

vi.mock("@/lib/durable-operation-state", () => ({
  getDurableOperationState: mocks.getDurableOperationState,
  expireAcceptedDispatchIfDeadlineElapsed: mocks.expireAcceptedDispatchIfDeadlineElapsed,
  getAcceptedDispatchExpiryAt: (operation: DurableOperationState) =>
    operation.status === "accepted" && (operation.phase === "dispatching" || operation.phase === "dispatched")
      ? new Date(Date.parse(operation.updatedAt) + 90 * 60 * 1000).toISOString()
      : null,
}));

vi.mock("@/lib/server-action-lock", () => ({
  releaseServerActionLockIfOwned: mocks.releaseServerActionLockIfOwned,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

describe("GET /api/operations/[operationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAllowed.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 59, retryAfterSeconds: 0 });
    mocks.expireAcceptedDispatchIfDeadlineElapsed.mockResolvedValue({
      operation: null,
      shouldReleaseLock: false,
    });
    mocks.releaseServerActionLockIfOwned.mockResolvedValue(true);
  });

  it("returns persisted operation state when found", async () => {
    const persistedOperation: DurableOperationState = {
      schemaVersion: 1,
      id: "resume-1",
      type: "resume",
      route: "/api/resume",
      status: "running",
      requestedAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:05.000Z",
      requestedBy: "admin@example.com",
      lockId: "lock-resume-1",
      instanceId: "i-1234",
      history: [
        { status: "accepted", at: "2026-04-14T10:00:00.000Z", source: "api" },
        { status: "running", at: "2026-04-14T10:00:05.000Z", source: "lambda" },
      ],
    };

    mocks.getDurableOperationState.mockResolvedValueOnce(persistedOperation);

    const request = createMockNextRequest("http://localhost/api/operations/resume-1");
    const response = await GET(request, {
      params: Promise.resolve({ operationId: "resume-1" }),
    });

    expect(response.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<OperationStatusData>>(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      schemaVersion: 1,
      id: "resume-1",
      type: "resume",
      route: "/api/resume",
      status: "running",
      requestedAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:05.000Z",
    });
    expect(body.data).not.toHaveProperty("requestedBy");
    expect(body.data).not.toHaveProperty("lockId");
    expect(body.data).not.toHaveProperty("instanceId");
    expect(body.data).not.toHaveProperty("history");
  });

  it("returns 404 when operation does not exist", async () => {
    mocks.getDurableOperationState.mockResolvedValueOnce(null);

    const request = createMockNextRequest("http://localhost/api/operations/missing-op");
    const response = await GET(request, {
      params: Promise.resolve({ operationId: "missing-op" }),
    });

    expect(response.status).toBe(404);
    const body = await parseNextResponse<ApiResponse<DurableOperationState>>(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Operation not found");
  });

  it("returns 400 when operation id is empty", async () => {
    const request = createMockNextRequest("http://localhost/api/operations/%20");
    const response = await GET(request, {
      params: Promise.resolve({ operationId: " " }),
    });

    expect(response.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<DurableOperationState>>(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Operation ID is invalid");
    expect(mocks.getDurableOperationState).not.toHaveBeenCalled();
  });

  it("returns auth failure when caller is unauthorized", async () => {
    mocks.requireAllowed.mockRejectedValueOnce(
      new Response(JSON.stringify({ success: false, error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const request = createMockNextRequest("http://localhost/api/operations/resume-1");
    const response = await GET(request, {
      params: Promise.resolve({ operationId: "resume-1" }),
    });

    expect(response.status).toBe(401);
    const body = await parseNextResponse<ApiResponse<DurableOperationState>>(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication required");
    expect(mocks.getDurableOperationState).not.toHaveBeenCalled();
  });

  it.each(["bad/id", `resume-${"x".repeat(128)}`, "-leading"])(
    "rejects invalid or oversized operation id %s",
    async (operationId) => {
      const request = createMockNextRequest(`http://localhost/api/operations/${encodeURIComponent(operationId)}`);
      const response = await GET(request, { params: Promise.resolve({ operationId }) });
      expect(response.status).toBe(400);
      expect(mocks.getDurableOperationState).not.toHaveBeenCalled();
    }
  );

  it("allows the operation owner but denies another allowed user", async () => {
    const operation: DurableOperationState = {
      schemaVersion: 1,
      id: "backup-1",
      type: "backup",
      route: "/api/backup",
      status: "accepted",
      phase: "dispatched",
      requestedAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:01.000Z",
      requestedBy: "owner@example.com",
      history: [],
    };
    mocks.getDurableOperationState.mockResolvedValue(operation);
    mocks.requireAllowed.mockResolvedValueOnce({ email: "owner@example.com", role: "allowed" });
    const ownerResponse = await GET(createMockNextRequest("http://localhost/api/operations/backup-1"), {
      params: Promise.resolve({ operationId: "backup-1" }),
    });
    expect(ownerResponse.status).toBe(200);
    const ownerBody = await parseNextResponse<ApiResponse<OperationStatusData>>(ownerResponse);
    expect(ownerBody.data?.dispatchExpiresAt).toBe("2026-04-14T11:30:01.000Z");

    mocks.requireAllowed.mockResolvedValueOnce({ email: "other@example.com", role: "allowed" });
    const otherResponse = await GET(createMockNextRequest("http://localhost/api/operations/backup-1"), {
      params: Promise.resolve({ operationId: "backup-1" }),
    });
    expect(otherResponse.status).toBe(403);
  });

  it("rate limits operation status reads without querying state", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 12 });
    const response = await GET(createMockNextRequest("http://localhost/api/operations/resume-1"), {
      params: Promise.resolve({ operationId: "resume-1" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(mocks.getDurableOperationState).not.toHaveBeenCalled();
  });

  it("returns the terminal public DTO and releases only the expired operation's exact lock", async () => {
    const accepted: DurableOperationState = {
      schemaVersion: 1,
      id: "backup-expired",
      type: "backup",
      route: "/api/backup",
      status: "accepted",
      phase: "dispatched",
      requestedAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:01.000Z",
      requestedBy: "admin@example.com",
      lockId: "lock-backup-expired",
      fencingToken: 11,
      history: [],
    };
    const failed: DurableOperationState = {
      ...accepted,
      status: "failed",
      phase: "terminal",
      updatedAt: "2026-04-14T11:30:01.000Z",
      lastError: "The operation was not executed before its dispatch lease expired",
      code: "dispatch_expired",
      history: [
        {
          status: "failed",
          at: "2026-04-14T11:30:01.000Z",
          source: "api",
          error: "The operation was not executed before its dispatch lease expired",
          code: "dispatch_expired",
        },
      ],
    };
    mocks.getDurableOperationState.mockResolvedValueOnce(accepted);
    mocks.expireAcceptedDispatchIfDeadlineElapsed.mockResolvedValueOnce({
      operation: failed,
      shouldReleaseLock: true,
    });

    const response = await GET(createMockNextRequest("http://localhost/api/operations/backup-expired"), {
      params: Promise.resolve({ operationId: "backup-expired" }),
    });
    const body = await parseNextResponse<ApiResponse<OperationStatusData>>(response);

    expect(body.data).toMatchObject({
      id: "backup-expired",
      status: "failed",
      phase: "terminal",
      code: "dispatch_expired",
    });
    expect(body.data).not.toHaveProperty("lockId");
    expect(body.data).not.toHaveProperty("fencingToken");
    expect(mocks.releaseServerActionLockIfOwned).toHaveBeenCalledWith({
      lockId: "lock-backup-expired",
      action: "backup",
      ownerEmail: "admin@example.com",
      fencingToken: 11,
    });
  });

  it("does not release an expired operation lock without its exact fencing token", async () => {
    const expired: DurableOperationState = {
      schemaVersion: 1,
      id: "backup-expired-without-fence",
      type: "backup",
      route: "/api/backup",
      status: "failed",
      phase: "terminal",
      requestedAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T11:30:00.000Z",
      requestedBy: "admin@example.com",
      lockId: "lock-backup-expired",
      code: "dispatch_expired",
      history: [],
    };
    mocks.getDurableOperationState.mockResolvedValueOnce(expired);
    mocks.expireAcceptedDispatchIfDeadlineElapsed.mockResolvedValueOnce({
      operation: expired,
      shouldReleaseLock: true,
    });

    const response = await GET(createMockNextRequest("http://localhost/api/operations/backup-expired-without-fence"), {
      params: Promise.resolve({ operationId: "backup-expired-without-fence" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.releaseServerActionLockIfOwned).not.toHaveBeenCalled();
  });
});
