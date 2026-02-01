import type { ApiResponse, StartServerResponse } from "@/lib/types";
import { ServerState } from "@/lib/types";
import { createMockNextRequest, parseNextResponse, setupInstanceState } from "@/tests/utils";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { invokeLambda } from "@/lib/aws";

// Mock AWS module
vi.mock("@/lib/aws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aws")>();
  return {
    ...actual,
    invokeLambda: vi.fn().mockResolvedValue(undefined),
    // We still need the real implementation of withServerActionLock?
    // Actually, utils.ts mocks @/lib/aws generally, but here we want to spy on invokeLambda.
    // However, setupInstanceState relies on mocking lib/aws too (via tests/mocks/aws).
    // Let's rely on the existing mock structure but spy on invokeLambda if possible,
    // or just mock it here if the utils allow.
    // The previous test setup used "setupInstanceState" which uses the mock provider indirectly or mocks imports.
    // Let's look at how setupInstanceState works.
  };
});

// Re-mock to ensure we capture the spy
vi.mock("@/lib/aws", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/aws")>();
    return {
        ...actual,
        invokeLambda: vi.fn(),
        getInstanceState: vi.fn(),
        findInstanceId: vi.fn().mockResolvedValue("i-1234"),
        withServerActionLock: vi.fn((name, fn) => fn()),
    };
});

describe("POST /api/start", () => {
  it("should trigger async lambda when server is stopped", async () => {
    const { getInstanceState, invokeLambda } = await import("@/lib/aws");
    
    // Setup state
    vi.mocked(getInstanceState).mockResolvedValue(ServerState.Stopped);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await parseNextResponse<ApiResponse<StartServerResponse>>(res);
    expect(body.success).toBe(true);
    expect(body.data?.message).toContain("initiated");
    expect(body.data?.publicIp).toBe("pending");
    
    expect(invokeLambda).toHaveBeenCalledWith("StartMinecraftServer", expect.objectContaining({
        invocationType: "api",
        command: "start",
        instanceId: "i-1234"
    }));
  });

  it("should return 400 when instance is already running", async () => {
    const { getInstanceState, invokeLambda } = await import("@/lib/aws");
    
    // Setup state
    vi.mocked(getInstanceState).mockResolvedValue(ServerState.Running);

    const req = createMockNextRequest("http://localhost/api/start", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await parseNextResponse<ApiResponse<unknown>>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("already running");
    
    expect(invokeLambda).not.toHaveBeenCalled();
  });
});
