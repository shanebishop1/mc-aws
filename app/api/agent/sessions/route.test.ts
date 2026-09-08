import { createPolicyFromPreset } from "@/lib/agent/presets";
import { resetMockAgentState } from "@/lib/agent/state";
import { createMockNextRequest } from "@/tests/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as PROVIDERS } from "../providers/route";
import { POST as DECIDE } from "./[sessionId]/approvals/[approvalId]/decision/route";
import { POST as REVOKE } from "./[sessionId]/approvals/[approvalId]/revoke/route";
import { POST as CANCEL } from "./[sessionId]/cancel/route";
import { POST as CONTINUE } from "./[sessionId]/continue/route";
import { GET as EVENTS } from "./[sessionId]/events/route";
import { GET as DETAIL } from "./[sessionId]/route";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn().mockResolvedValue({ email: "admin@example.com", role: "admin" }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/api-auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

function createBody(extra: Record<string, unknown> = {}) {
  const policy = createPolicyFromPreset("maintainer", "ignored");
  return {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: "route-create-1",
    task: "Inspect configuration",
    providerProfileId: "local-fake",
    model: "deterministic-v1",
    policy: {
      schemaVersion: 1,
      preset: policy.preset,
      rules: policy.rules,
      backupMode: policy.backupMode,
    },
    ...extra,
  };
}

async function payload(response: Response) {
  return (await response.json()) as { success: boolean; data?: unknown; error?: string };
}

describe("agent session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockAgentState();
    process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS = undefined;
    mocks.requireAdmin.mockResolvedValue({ email: "admin@example.com", role: "admin" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, retryAfterSeconds: 0 });
  });

  it("requires admin and applies no-store to auth failures", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(Response.json({ error: "Authentication required" }, { status: 401 }));
    const response = await GET(createMockNextRequest("http://localhost/api/agent/sessions"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns the owner-only credential-free mock provider catalog", async () => {
    const response = await PROVIDERS(createMockNextRequest("http://localhost/api/agent/providers"));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("local-fake");
    expect(body).toContain("deterministic-v1");
    expect(body).not.toMatch(/credentialRef|apiKey|secret-ref/i);
  });

  it("rejects unknown fields and oversized task bodies", async () => {
    const unknown = await POST(
      createMockNextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify(createBody({ rawApiKey: "must-not-be-accepted" })),
      })
    );
    expect(unknown.status).toBe(400);
    expect((await payload(unknown)).error).toBe("Request is invalid");

    const oversized = await POST(
      createMockNextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify(createBody({ task: "x".repeat(8_001) })),
      })
    );
    expect(oversized.status).toBe(400);
  });

  it("fails closed when the agent throttle denies a mutation", async () => {
    process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS = "true";
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 7 });
    const response = await POST(
      createMockNextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify(createBody()),
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("creates, lists, reads, streams ordered replay, decides, revokes, and cancels", async () => {
    const createdResponse = await POST(
      createMockNextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify(createBody()),
      })
    );
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("Cache-Control")).toBe("private, no-store");
    const created = (await payload(createdResponse)).data as {
      sessionId: string;
      revision: number;
      approvals: Array<{
        approvalId: string;
        decision: string;
        invocationId: string;
        invocationDigest: string;
        sanitizedArguments: Record<string, unknown>;
        diffSummary: string;
        grantLifetime: string;
      }>;
    };
    expect(created.approvals[0]).toMatchObject({
      invocationId: expect.stringMatching(/^invocation-/),
      invocationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sanitizedArguments: { path: "server.properties" },
      grantLifetime: "until-session-end-or-expiry",
    });
    expect(created.approvals[0].diffSummary).toContain("server.properties");

    const listResponse = await GET(createMockNextRequest("http://localhost/api/agent/sessions"));
    expect((await payload(listResponse)).data as unknown[]).toHaveLength(1);
    const detailResponse = await DETAIL(createMockNextRequest("http://localhost/unused"), {
      params: Promise.resolve({ sessionId: created.sessionId }),
    });
    expect(detailResponse.status).toBe(200);

    const eventsResponse = await EVENTS(
      createMockNextRequest(
        `http://localhost/api/agent/sessions/${created.sessionId}/events?after=${created.sessionId}:1`
      ),
      { params: Promise.resolve({ sessionId: created.sessionId }) }
    );
    const eventText = await eventsResponse.text();
    expect(eventsResponse.headers.get("Content-Type")).toContain("text/event-stream");
    expect(eventText.match(/event: agent/g)).toHaveLength(2);
    expect(eventText).toContain(`id: ${created.sessionId}:2`);
    expect(eventText).toContain(`id: ${created.sessionId}:3`);

    const approvalId = created.approvals[0].approvalId;
    const approvedResponse = await DECIDE(
      createMockNextRequest("http://localhost/unused", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          expectedRevision: created.revision,
          idempotencyKey: "approve-1",
          decision: "approve",
        }),
      }),
      { params: Promise.resolve({ sessionId: created.sessionId, approvalId }) }
    );
    const approved = (await payload(approvedResponse)).data as {
      revision: number;
      approvals: Array<{ decision: string }>;
    };
    expect(approved.approvals[0].decision).toBe("approved");

    const revokedResponse = await REVOKE(
      createMockNextRequest("http://localhost/unused", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, expectedRevision: approved.revision, idempotencyKey: "revoke-1" }),
      }),
      { params: Promise.resolve({ sessionId: created.sessionId, approvalId }) }
    );
    const revoked = (await payload(revokedResponse)).data as { revision: number };
    const cancelResponse = await CANCEL(
      createMockNextRequest("http://localhost/unused", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, expectedRevision: revoked.revision, idempotencyKey: "cancel-1" }),
      }),
      { params: Promise.resolve({ sessionId: created.sessionId }) }
    );
    expect(((await payload(cancelResponse)).data as { status: string }).status).toBe("cancelled");
  });

  it("rejects conflicting SSE cursors without exposing identifiers in the error", async () => {
    const createdResponse = await POST(
      createMockNextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify(createBody()),
      })
    );
    const created = (await payload(createdResponse)).data as { sessionId: string };
    const response = await EVENTS(
      createMockNextRequest(`http://localhost/unused?after=${created.sessionId}:1`, {
        headers: { "Last-Event-ID": `${created.sessionId}:2` },
      }),
      { params: Promise.resolve({ sessionId: created.sessionId }) }
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(created.sessionId);
  });

  it("continues only an idle owned session and enforces revision conflicts", async () => {
    const createdResponse = await POST(
      createMockNextRequest("http://localhost/api/agent/sessions", {
        method: "POST",
        body: JSON.stringify(createBody({ idempotencyKey: "route-continuation-create" })),
      })
    );
    const created = (await payload(createdResponse)).data as {
      sessionId: string;
      revision: number;
      approvals: Array<{ approvalId: string }>;
    };
    const approvedResponse = await DECIDE(
      createMockNextRequest("http://localhost/unused", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          expectedRevision: created.revision,
          idempotencyKey: "route-continuation-approve",
          decision: "approve",
        }),
      }),
      { params: Promise.resolve({ sessionId: created.sessionId, approvalId: created.approvals[0].approvalId }) }
    );
    const idle = (await payload(approvedResponse)).data as { revision: number; status: string };
    expect(idle.status).toBe("idle");
    const request = {
      schemaVersion: 1,
      expectedRevision: idle.revision,
      idempotencyKey: "route-continue-1",
      task: "Continue this conversation",
      providerProfileId: "local-fake",
      model: "deterministic-v1",
    };
    process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS = "true";
    const continuedResponse = await CONTINUE(
      createMockNextRequest("http://localhost/unused", { method: "POST", body: JSON.stringify(request) }),
      { params: Promise.resolve({ sessionId: created.sessionId }) }
    );
    expect(continuedResponse.status).toBe(201);
    expect((await payload(continuedResponse)).data).toMatchObject({ status: "idle", taskCount: 2 });

    const conflict = await CONTINUE(
      createMockNextRequest("http://localhost/unused", {
        method: "POST",
        body: JSON.stringify({ ...request, idempotencyKey: "route-continue-stale", task: "stale" }),
      }),
      { params: Promise.resolve({ sessionId: created.sessionId }) }
    );
    expect(conflict.status).toBe(409);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/api/agent/sessions/[sessionId]/continue" })
    );
  });
});
