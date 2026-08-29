import { ClientApiError } from "@/lib/client-api";
import { LIFECYCLE_LOCK_LEASE_MS } from "@/lib/lifecycle-runtime-budget";
import {
  DISPATCH_RECOVERY_RETRY_GRACE_MS,
  OPERATION_TIMEOUT_MS,
  pollOperationUntilTerminal,
  pollServerUntilStopped,
} from "@/lib/operation-polling";
import { type OperationStatusData, ServerState } from "@/lib/types";
import { describe, expect, it, vi } from "vitest";

function operation(
  status: OperationStatusData["status"],
  lastError?: string,
  overrides: Partial<OperationStatusData> = {}
): OperationStatusData {
  return {
    schemaVersion: 1,
    id: "start-123",
    type: "start",
    status,
    route: "/api/start",
    requestedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    lastError,
    ...overrides,
  };
}

describe("pollOperationUntilTerminal", () => {
  it("polls accepted and running operations until completion", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ data: operation("accepted") })
      .mockResolvedValueOnce({ data: operation("running") })
      .mockResolvedValueOnce({ data: operation("completed") });

    await expect(
      pollOperationUntilTerminal("start-123", { fetchStatus, intervalMs: 0, timeoutMs: 1000 })
    ).resolves.toMatchObject({ status: "completed" });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("surfaces the durable operation failure", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ data: operation("failed", "Instance failed health checks") });

    await expect(
      pollOperationUntilTerminal("start-123", { fetchStatus, intervalMs: 0, timeoutMs: 1000 })
    ).rejects.toThrow("Instance failed health checks");
  });

  it("cancels polling through AbortSignal", async () => {
    const controller = new AbortController();
    const fetchStatus = vi.fn().mockResolvedValue({ data: operation("running") });
    const result = pollOperationUntilTerminal("start-123", {
      fetchStatus,
      intervalMs: 1000,
      timeoutMs: 5000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries initial 404, 5xx, and network failures before completing", async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new ClientApiError("Not found", 404))
      .mockRejectedValueOnce(new ClientApiError("Unavailable", 503))
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockResolvedValue({ data: operation("completed") });

    await expect(
      pollOperationUntilTerminal("start-123", { fetchStatus, delay: async () => undefined })
    ).resolves.toMatchObject({ status: "completed" });
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it.each([
    [401, "session expired"],
    [403, "no longer has permission"],
  ])("surfaces authentication status %s without retrying", async (status, message) => {
    const fetchStatus = vi.fn().mockRejectedValue(new ClientApiError("Denied", status));

    const error = await pollOperationUntilTerminal("start-123", {
      fetchStatus,
      delay: async () => undefined,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ status });
    expect(error.message).toContain(message);
    expect(fetchStatus).toHaveBeenCalledOnce();
  });

  it("allows a legitimate 15-minute operation plus dispatch margin", async () => {
    let now = 0;
    const fetchStatus = vi.fn().mockImplementation(async () => ({
      data: operation(now >= 15 * 60 * 1000 ? "completed" : "running"),
    }));

    await expect(
      pollOperationUntilTerminal("start-123", {
        fetchStatus,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).resolves.toMatchObject({ status: "completed" });
    expect(now).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  it.each([
    ["ahead", 5 * 60 * 1000],
    ["behind", -5 * 60 * 1000],
  ])("uses server timing when the browser clock is %s", async (_label, browserClockSkewMs) => {
    const serverStartedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const browserStartedAt = serverStartedAt + browserClockSkewMs;
    let browserNow = browserStartedAt;
    const fetchStatus = vi.fn().mockImplementation(async () => {
      const elapsedMs = browserNow - browserStartedAt;
      const serverNow = serverStartedAt + elapsedMs;
      if (elapsedMs >= LIFECYCLE_LOCK_LEASE_MS) {
        return {
          data: operation("failed", "Dispatch expired", { phase: "terminal" }),
          timestamp: new Date(serverNow).toISOString(),
        };
      }
      return {
        data: operation("accepted", undefined, {
          phase: "dispatched",
          dispatchExpiresAt: new Date(serverStartedAt + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
        }),
        timestamp: new Date(serverNow).toISOString(),
      };
    });

    await expect(
      pollOperationUntilTerminal("start-123", {
        fetchStatus,
        intervalMs: 10_000,
        now: () => browserNow,
        delay: async (milliseconds) => {
          browserNow += milliseconds;
        },
      })
    ).rejects.toThrow("Dispatch expired");
    expect(browserNow - browserStartedAt).toBe(LIFECYCLE_LOCK_LEASE_MS);
  });

  it("retries transient failures at and after the recovery boundary until terminalization succeeds", async () => {
    const serverStartedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let now = serverStartedAt;
    let boundaryFailures = 0;
    const fetchStatus = vi.fn().mockImplementation(async () => {
      const elapsedMs = now - serverStartedAt;
      if (elapsedMs >= LIFECYCLE_LOCK_LEASE_MS && boundaryFailures++ < 2) {
        throw boundaryFailures === 1
          ? new ClientApiError("Temporarily unavailable", 503)
          : new TypeError("Network error");
      }
      if (elapsedMs >= LIFECYCLE_LOCK_LEASE_MS) {
        return {
          data: operation("failed", "Dispatch expired", { phase: "terminal" }),
          timestamp: new Date(now).toISOString(),
        };
      }
      return {
        data: operation("accepted", undefined, {
          phase: "dispatched",
          dispatchExpiresAt: new Date(serverStartedAt + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
        }),
        timestamp: new Date(now).toISOString(),
      };
    });

    await expect(
      pollOperationUntilTerminal("start-123", {
        fetchStatus,
        intervalMs: 10_000,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).rejects.toThrow("Dispatch expired");
    expect(boundaryFailures).toBe(3);
    expect(now).toBe(serverStartedAt + LIFECYCLE_LOCK_LEASE_MS + 20_000);
  });

  it("hard-stops accepted recovery polling after the bounded retry grace", async () => {
    const serverStartedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let now = serverStartedAt;
    const fetchStatus = vi.fn().mockImplementation(async () => ({
      data: operation("accepted", undefined, {
        phase: "dispatched",
        dispatchExpiresAt: new Date(serverStartedAt + LIFECYCLE_LOCK_LEASE_MS).toISOString(),
      }),
      timestamp: new Date(now).toISOString(),
    }));

    await expect(
      pollOperationUntilTerminal("start-123", {
        fetchStatus,
        intervalMs: 10_000,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).rejects.toThrow("Operation timed out");
    expect(now).toBe(serverStartedAt + LIFECYCLE_LOCK_LEASE_MS + DISPATCH_RECOVERY_RETRY_GRACE_MS);
  });

  it("does not extend polling beyond the execution budget for a running operation", async () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let now = startedAt;
    const fetchStatus = vi.fn().mockResolvedValue({
      data: operation("running", undefined, { phase: "executing" }),
    });

    await expect(
      pollOperationUntilTerminal("start-123", {
        fetchStatus,
        intervalMs: 10_000,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).rejects.toThrow("Operation timed out");
    expect(now).toBe(startedAt + OPERATION_TIMEOUT_MS);
  });

  it("polls stop status through transient failures until stopped", async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new ClientApiError("Unavailable", 503))
      .mockResolvedValueOnce({ data: { state: ServerState.Stopping } })
      .mockResolvedValueOnce({ data: { state: ServerState.Stopped } });

    await expect(pollServerUntilStopped({ fetchStatus, delay: async () => undefined })).resolves.toMatchObject({
      state: ServerState.Stopped,
    });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });
});
