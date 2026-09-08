import { AgentControlPlaneService } from "@/lib/agent/control-plane/service";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import { getAgentSessionStore, resetMockAgentState } from "@/lib/agent/state";
import { createMockNextRequest } from "@/tests/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as BACKUP } from "./backups/route";
import { POST as ACTION } from "./leases/[leaseId]/[action]/route";
import { POST as WORK } from "./work/route";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, retryAfterSeconds: 0 }),
  getProvider: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/aws/provider-selector", () => ({ getProvider: mocks.getProvider }));

const TOKEN = "runtime-route-test-token-with-more-than-32-characters";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function request(path: string, body: unknown, bearer = TOKEN) {
  return createMockNextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function data(response: Response) {
  return (await response.json()) as {
    success: boolean;
    data?: Record<string, unknown> | null;
    error?: string;
  };
}

async function createPendingWork(): Promise<void> {
  const policy = createPolicyFromPreset("maintainer", "ignored");
  const service = new AgentControlPlaneService(
    await getAgentSessionStore(),
    () => new Date("2026-09-02T10:00:00.000Z"),
    false
  );
  await service.createSession("actor-runtime-route", {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: "runtime-route-create",
    task: "Do not place this portal content in SSM",
    providerProfileId: "local-fake",
    model: "deterministic-v1",
    policy: {
      schemaVersion: 1,
      preset: policy.preset,
      rules: policy.rules,
      backupMode: policy.backupMode,
    },
  });
}

describe("agent runtime routes", () => {
  beforeEach(async () => {
    resetMockAgentState();
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 100, retryAfterSeconds: 0 });
    process.env.MC_AGENT_RUNTIME_ENABLED = "true";
    process.env.MC_AGENT_RUNTIME_ID = "runtime-route";
    process.env.MC_AGENT_RUNTIME_TOKEN_SHA256 = await sha256(TOKEN);
    process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS = undefined;
  });

  afterEach(() => {
    process.env.MC_AGENT_RUNTIME_ENABLED = undefined;
    process.env.MC_AGENT_RUNTIME_ID = undefined;
    process.env.MC_AGENT_RUNTIME_TOKEN_SHA256 = undefined;
    process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS = undefined;
  });

  it("fails closed for missing configuration and invalid bearer values", async () => {
    process.env.MC_AGENT_RUNTIME_TOKEN_SHA256 = undefined;
    const unavailable = await WORK(
      request("/api/agent/runtime/work", { schemaVersion: 1, claimId: "claim-1", leaseDurationMs: 30_000, waitMs: 0 })
    );
    expect(unavailable.status).toBe(503);
    process.env.MC_AGENT_RUNTIME_TOKEN_SHA256 = await sha256(TOKEN);
    const unauthorized = await WORK(
      request(
        "/api/agent/runtime/work",
        { schemaVersion: 1, claimId: "claim-1", leaseDurationMs: 30_000, waitMs: 0 },
        "wrong-runtime-token-that-is-still-at-least-32-characters"
      )
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await unauthorized.text()).not.toContain(TOKEN);
  });

  it.each(["false", undefined])("rejects a retained old bearer when runtime enablement is %s", async (enabled) => {
    process.env.MC_AGENT_RUNTIME_ENABLED = enabled;
    const unavailable = await WORK(
      request("/api/agent/runtime/work", {
        schemaVersion: 1,
        claimId: "claim-retained-bearer",
        leaseDurationMs: 30_000,
        waitMs: 0,
      })
    );

    expect(unavailable.status).toBe(503);
    expect(await data(unavailable)).toMatchObject({
      success: false,
      error: "Agent runtime authentication is unavailable",
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("leases, acknowledges, publishes monotonic drafts, and polls decisions without leaking the bearer", async () => {
    await createPendingWork();
    const leasedResponse = await WORK(
      request("/api/agent/runtime/work", {
        schemaVersion: 1,
        claimId: "claim-route",
        leaseDurationMs: 30_000,
        waitMs: 0,
      })
    );
    expect(leasedResponse.status).toBe(200);
    const leased = (await data(leasedResponse)).data as {
      revision: number;
      session: { sessionId: string };
      task: { taskId: string };
      lease: { leaseId: string; generation: number };
    };
    expect(JSON.stringify(leased)).not.toContain(TOKEN);
    const common = {
      schemaVersion: 1 as const,
      sessionId: leased.session.sessionId,
      taskId: leased.task.taskId,
      expectedRevision: leased.revision,
      idempotencyKey: "ack-route",
    };
    const ackResponse = await ACTION(request(`/api/agent/runtime/leases/${leased.lease.leaseId}/ack`, common), {
      params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "ack" }),
    });
    const ack = (await data(ackResponse)).data as { revision: number };
    const eventsResponse = await ACTION(
      request(`/api/agent/runtime/leases/${leased.lease.leaseId}/events`, {
        ...common,
        expectedRevision: ack.revision,
        idempotencyKey: "events-route",
        drafts: [
          {
            schemaVersion: 1,
            draftId: "draft-route-1",
            ordinal: 1,
            timestamp: "2026-09-02T10:00:01.000Z",
            kind: "model",
            payload: { text: "safe output" },
          },
        ],
      }),
      { params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "events" }) }
    );
    expect(eventsResponse.status).toBe(200);
    const events = (await data(eventsResponse)).data as { revision: number; events: Array<{ sequence: number }> };
    expect(events.events[0].sequence).toBe(1);
    const preDecidedApproval = await ACTION(
      request(`/api/agent/runtime/leases/${leased.lease.leaseId}/approval`, {
        ...common,
        expectedRevision: events.revision,
        idempotencyKey: "pre-decided-approval",
        approval: {
          schemaVersion: 1,
          approvalId: "approval-pre-decided",
          actorId: "actor-runtime-route",
          sessionId: leased.session.sessionId,
          policyId: `policy-${leased.session.sessionId.slice("session-".length)}`,
          policyRevision: 1,
          invocationDigest: "d".repeat(64),
          scope: {
            schemaVersion: 1,
            kind: "single-invocation",
            capability: "workspace.write",
            targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
            risk: "risky",
          },
          expiresAt: "2026-09-02T11:00:00.000Z",
          decision: "approved",
          reason: "must be rejected",
          decidedAt: "2026-09-02T10:00:02.000Z",
        },
      }),
      { params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "approval" }) }
    );
    expect(preDecidedApproval.status).toBe(400);
    const decisionResponse = await ACTION(
      request(`/api/agent/runtime/leases/${leased.lease.leaseId}/decisions`, {
        schemaVersion: 1,
        sessionId: leased.session.sessionId,
        taskId: leased.task.taskId,
        afterRevision: events.revision,
        waitMs: 0,
      }),
      { params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "decisions" }) }
    );
    expect(decisionResponse.status).toBe(200);
    expect(JSON.stringify((await data(decisionResponse)).data)).not.toContain(TOKEN);
  });

  it("rejects unknown fields and fails closed when runtime throttling denies", async () => {
    const invalid = await WORK(
      request("/api/agent/runtime/work", {
        schemaVersion: 1,
        claimId: "claim-invalid",
        leaseDurationMs: 30_000,
        waitMs: 0,
        task: "must-not-be-accepted",
      })
    );
    expect(invalid.status).toBe(400);
    process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS = "true";
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 9 });
    const throttled = await WORK(
      request("/api/agent/runtime/work", {
        schemaVersion: 1,
        claimId: "claim-throttled",
        leaseDurationMs: 30_000,
        waitMs: 0,
      })
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("9");
  });

  it("authenticates, lease-fences, and invocation-binds deterministic runtime backups without a provider call", async () => {
    await createPendingWork();
    const leasedResponse = await WORK(
      request("/api/agent/runtime/work", {
        schemaVersion: 1,
        claimId: "claim-backup",
        leaseDurationMs: 30_000,
        waitMs: 0,
      })
    );
    const leased = (await data(leasedResponse)).data as {
      revision: number;
      session: { sessionId: string };
      task: { taskId: string };
      lease: { leaseId: string; generation: number };
    };
    const base = {
      schemaVersion: 1 as const,
      sessionId: leased.session.sessionId,
      taskId: leased.task.taskId,
      expectedRevision: leased.revision,
      idempotencyKey: "ack-backup",
    };
    const acknowledged = await ACTION(request(`/api/agent/runtime/leases/${leased.lease.leaseId}/ack`, base), {
      params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "ack" }),
    });
    const revision = ((await data(acknowledged)).data as { revision: number }).revision;
    const invocationDigest = "c".repeat(64);
    const events = await ACTION(
      request(`/api/agent/runtime/leases/${leased.lease.leaseId}/events`, {
        ...base,
        expectedRevision: revision,
        idempotencyKey: "backup-binding-events",
        drafts: [
          {
            schemaVersion: 1,
            draftId: "proposal-backup",
            ordinal: 1,
            timestamp: "2026-09-02T10:00:01.000Z",
            kind: "tool-proposal",
            payload: {
              invocationId: "invocation-backup",
              invocationDigest,
              capability: "workspace.write",
              targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
            },
          },
          {
            schemaVersion: 1,
            draftId: "request-backup",
            ordinal: 2,
            timestamp: "2026-09-02T10:00:02.000Z",
            kind: "backup",
            payload: { invocationId: "invocation-backup", invocationDigest, status: "requested" },
          },
        ],
      }),
      { params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "events" }) }
    );
    expect(events.status).toBe(200);
    const backupInput = {
      schemaVersion: 1 as const,
      action: "create" as const,
      leaseId: leased.lease.leaseId,
      leaseGeneration: leased.lease.generation,
      sessionId: leased.session.sessionId,
      taskId: leased.task.taskId,
      invocationId: "invocation-backup",
      invocationDigest,
    };
    const completed = await BACKUP(request("/api/agent/runtime/backups", backupInput));
    expect(completed.status).toBe(200);
    const completedResult = (await data(completed)).data as {
      fenceAuthorization: import("@/lib/agent/contracts").BackupFenceAuthorization;
    };
    expect(completedResult).toMatchObject({
      status: "succeeded",
      sessionId: leased.session.sessionId,
      invocationId: "invocation-backup",
      invocationDigest,
    });
    // A delayed retry may reuse the completed operation only while the exact
    // invocation is still current in the authoritative task state.
    const delayedSameInvocation = await BACKUP(request("/api/agent/runtime/backups", backupInput));
    expect(delayedSameInvocation.status).toBe(200);
    expect((await data(delayedSameInvocation)).data).toMatchObject({
      status: "succeeded",
      invocationId: "invocation-backup",
    });
    const renewed = await BACKUP(
      request("/api/agent/runtime/backups", {
        schemaVersion: 1,
        action: "renew",
        authorization: completedResult.fenceAuthorization,
      })
    );
    expect(renewed.status).toBe(200);
    const renewedResult = (await data(renewed)).data as {
      status: string;
      authorization: import("@/lib/agent/contracts").BackupFenceAuthorization;
    };
    expect(renewedResult).toMatchObject({
      status: "renewed",
      authorization: {
        lifecycleLeaseGeneration: completedResult.fenceAuthorization.lifecycleLeaseGeneration + 1,
      },
    });
    const finalized = await BACKUP(
      request("/api/agent/runtime/backups", {
        schemaVersion: 1,
        action: "finalize",
        authorization: renewedResult.authorization,
        outcome: "committed",
        terminalReceipt: {
          schemaVersion: 1,
          source: "executor-journal",
          proofKind: "terminal",
          outcome: "committed",
          executorKeyId: renewedResult.authorization.executorKeyId!,
          executorKeyEpoch: renewedResult.authorization.executorKeyEpoch!,
          executorEpoch: "epoch-route-test",
          runtimeId: renewedResult.authorization.runtimeId,
          leaseId: renewedResult.authorization.leaseId,
          leaseGeneration: renewedResult.authorization.leaseGeneration,
          sessionId: renewedResult.authorization.sessionId,
          taskId: renewedResult.authorization.taskId,
          invocationId: renewedResult.authorization.invocationId,
          invocationDigest: renewedResult.authorization.invocationDigest,
          backupId: renewedResult.authorization.backupId,
          lifecycleLockId: renewedResult.authorization.lifecycleLockId,
          lifecycleFencingToken: renewedResult.authorization.lifecycleFencingToken,
          lifecycleLeaseGeneration: renewedResult.authorization.lifecycleLeaseGeneration,
          resultDigest: "b".repeat(64),
          journalSequence: 1,
          completedAt: "2026-09-04T12:00:00.000Z",
          fenceIssuedAt: renewedResult.authorization.issuedAt,
          signature: "A".repeat(86),
        },
      })
    );
    expect(finalized.status).toBe(200);
    expect((await data(finalized)).data).toMatchObject({ status: "finalized", released: true });
    const store = await getAgentSessionStore();
    const current = (await store.getSession(leased.session.sessionId))!;
    const replacementDigest = "e".repeat(64);
    const replaced = await ACTION(
      request(`/api/agent/runtime/leases/${leased.lease.leaseId}/events`, {
        ...base,
        expectedRevision: current.revision,
        idempotencyKey: "replace-backup-invocation",
        drafts: [
          {
            schemaVersion: 1,
            draftId: "result-before-replacement",
            ordinal: 3,
            timestamp: "2026-09-04T12:00:03.000Z",
            kind: "tool-result",
            payload: {
              schemaVersion: 1,
              invocationId: "invocation-backup",
              status: "failed",
              completedAt: "2026-09-04T12:00:03.000Z",
              summary: "The old invocation was superseded.",
              output: {},
              evidence: [],
            },
          },
          {
            schemaVersion: 1,
            draftId: "proposal-replacement",
            ordinal: 4,
            timestamp: "2026-09-04T12:00:04.000Z",
            kind: "tool-proposal",
            payload: {
              invocationId: "invocation-replacement",
              invocationDigest: replacementDigest,
              capability: "workspace.write",
              targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
            },
          },
        ],
      }),
      { params: Promise.resolve({ leaseId: leased.lease.leaseId, action: "events" }) }
    );
    expect(replaced.status).toBe(200);
    const replacedDelayed = await BACKUP(request("/api/agent/runtime/backups", backupInput));
    expect(replacedDelayed.status).toBe(409);
    const afterReplacement = (await store.getSession(leased.session.sessionId))!;
    await store.cancelSession({
      sessionId: leased.session.sessionId,
      expectedRevision: afterReplacement.revision,
      idempotencyKey: "cancel-delayed-backup",
      requestedAt: "2026-09-04T12:01:00.000Z",
      requestedBy: "actor-runtime-route",
      reason: "Fence delayed backup retry after cancellation",
    });
    const cancelledDelayed = await BACKUP(request("/api/agent/runtime/backups", backupInput));
    expect(cancelledDelayed.status).toBe(409);
    const tampered = await BACKUP(
      request("/api/agent/runtime/backups", { ...backupInput, invocationId: "invocation-tampered" })
    );
    expect(tampered.status).toBe(409);
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });
});
