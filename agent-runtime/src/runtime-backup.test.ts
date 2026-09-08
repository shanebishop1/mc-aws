import type { RuntimeBackupCreateRequest } from "@/lib/agent/runtime/contracts";
import { describe, expect, it, vi } from "vitest";
import { HttpRuntimeBackupAdapter } from "./runtime-backup";

const request: RuntimeBackupCreateRequest = {
  schemaVersion: 1,
  action: "create",
  leaseId: "lease-runtime",
  leaseGeneration: 3,
  sessionId: "session-runtime",
  taskId: "task-runtime",
  invocationId: "invocation-runtime",
  invocationDigest: "b".repeat(64),
};

const binding = {
  schemaVersion: request.schemaVersion,
  leaseId: request.leaseId,
  leaseGeneration: request.leaseGeneration,
  sessionId: request.sessionId,
  taskId: request.taskId,
  invocationId: request.invocationId,
  invocationDigest: request.invocationDigest,
};

function envelope(data: unknown): Response {
  return Response.json({ success: true, data });
}

const fenceAuthorization = {
  schemaVersion: 1 as const,
  status: "succeeded" as const,
  authorizationId: "fence-runtime",
  runtimeId: "runtime-production",
  leaseId: request.leaseId,
  leaseGeneration: request.leaseGeneration,
  sessionId: request.sessionId,
  taskId: request.taskId,
  invocationId: request.invocationId,
  invocationDigest: request.invocationDigest,
  backupId: "backup-runtime",
  lifecycleLockId: "lock-runtime",
  lifecycleFencingToken: 7,
  lifecycleLeaseGeneration: 1,
  lifecycleLeaseExpiresAt: "2099-09-02T13:00:00.000Z",
  issuedAt: "2026-09-02T12:00:00.000Z",
  expiresAt: "2099-09-02T12:05:00.000Z",
  signature: "A".repeat(86),
};

describe("HTTP runtime backup adapter", () => {
  it("polls pending work until terminal success and sends only the runtime bearer", async () => {
    const bearer = "runtime-backup-test-bearer-with-thirty-two-characters";
    const providerCanary = "provider-secret-must-not-be-sent";
    process.env.PROVIDER_SECRET = providerCanary;
    const snapshots = [
      { ...binding, status: "pending" },
      {
        ...binding,
        status: "succeeded",
        backupId: "backup-runtime",
        createdAt: "2026-09-02T12:00:00.000Z",
        fenceAuthorization,
      },
    ];
    const fetch = vi
      .fn<(input: string | URL, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("ambiguous response loss"))
      .mockImplementation(async () => envelope(snapshots.shift()));
    const adapter = new HttpRuntimeBackupAdapter({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: bearer,
      transport: { fetch },
      sleep: async () => undefined,
    });
    await expect(adapter.create(request)).resolves.toMatchObject({
      status: "succeeded",
      invocationId: request.invocationId,
      backupId: "backup-runtime",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${bearer}`);
      expect(JSON.stringify(init)).not.toContain(providerCanary);
    }
    process.env.PROVIDER_SECRET = undefined;
  });

  it("returns unavailable and rejects malformed or unbound success responses", async () => {
    const responses = [
      envelope({ schemaVersion: 1, availability: "unavailable" }),
      envelope({
        ...binding,
        invocationId: "different-invocation",
        status: "succeeded",
        backupId: "backup-runtime",
        createdAt: "2026-09-02T12:00:00.000Z",
        fenceAuthorization,
      }),
    ];
    const adapter = new HttpRuntimeBackupAdapter({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-backup-test-bearer-with-thirty-two-characters",
      transport: { fetch: vi.fn(async () => responses.shift() as Response) },
    });
    await expect(adapter.evaluateAvailability()).resolves.toBe("unavailable");
    await expect(adapter.create(request)).rejects.toThrow(/binding/i);
  });

  it("rejects success-only metadata on pending and failed responses", async () => {
    const adapter = new HttpRuntimeBackupAdapter({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-backup-test-bearer-with-thirty-two-characters",
      transport: {
        fetch: vi.fn(async () =>
          envelope({
            ...binding,
            status: "pending",
            backupId: "backup-must-not-appear",
            createdAt: "2026-09-02T12:00:00.000Z",
            fenceAuthorization,
          })
        ),
      },
    });
    await expect(adapter.create(request)).rejects.toThrow(/non-success/i);
  });

  it("retries an ambiguous indeterminate finalization without accepting lock release", async () => {
    const fetch = vi
      .fn<(input: string | URL, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("ambiguous finalization response loss"))
      .mockResolvedValueOnce(
        envelope({
          schemaVersion: 1,
          authorizationId: fenceAuthorization.authorizationId,
          status: "reconciliation-needed",
          released: false,
        })
      );
    const adapter = new HttpRuntimeBackupAdapter({
      baseUrl: "https://panel.example.invalid",
      runtimeBearer: "runtime-backup-test-bearer-with-thirty-two-characters",
      transport: { fetch },
      sleep: async () => undefined,
    });
    await expect(
      adapter.finalize({
        schemaVersion: 1,
        action: "finalize",
        authorization: fenceAuthorization,
        outcome: "indeterminate",
      })
    ).resolves.toMatchObject({ status: "reconciliation-needed", released: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toMatchObject({
      action: "finalize",
      outcome: "indeterminate",
      authorization: { invocationDigest: request.invocationDigest },
    });
  });
});
