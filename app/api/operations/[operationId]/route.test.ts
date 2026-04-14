import type { DurableOperationState } from "@/lib/durable-operation-state";
import type { ApiResponse } from "@/lib/types";
import { createMockNextRequest, parseNextResponse } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  requireAllowed: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
  getDurableOperationState: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAllowed: mocks.requireAllowed,
}));

vi.mock("@/lib/durable-operation-state", () => ({
  getDurableOperationState: mocks.getDurableOperationState,
}));

describe("GET /api/operations/[operationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAllowed.mockResolvedValue({ email: "admin@example.com", role: "admin" });
  });

  it("returns persisted operation state when found", async () => {
    const persistedOperation: DurableOperationState = {
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
    const body = await parseNextResponse<ApiResponse<DurableOperationState>>(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(persistedOperation);
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
    expect(body.error).toBe("Operation ID is required");
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
});
