import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientApiError, fetchOperationStatus, fetchStackStatus } from "./client-api";

describe("client API response validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a valid stack-status response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { exists: true }, timestamp: "2026-08-27T00:00:00Z" }), {
          status: 200,
        })
      )
    );

    await expect(fetchStackStatus()).resolves.toMatchObject({ data: { exists: true } });
  });

  it("rejects a malformed successful stack-status response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { exists: "yes" }, timestamp: "2026-08-27T00:00:00Z" }), {
          status: 200,
        })
      )
    );

    await expect(fetchStackStatus()).rejects.toThrow("Invalid response from /api/stack-status");
  });

  it("accepts only versioned, validated operation-status responses", async () => {
    const operation = {
      schemaVersion: 1,
      id: "operation-1",
      type: "backup",
      status: "running",
      route: "/api/backup",
      requestedAt: "2026-08-27T00:00:00Z",
      updatedAt: "2026-08-27T00:00:01Z",
      phase: "executing",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: operation, timestamp: "2026-08-27T00:00:01Z" }), {
          status: 200,
        })
      )
    );
    await expect(fetchOperationStatus("operation-1")).resolves.toMatchObject({ data: operation });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { ...operation, schemaVersion: 2 },
            timestamp: "2026-08-27T00:00:01Z",
          }),
          { status: 200 }
        )
      )
    );
    await expect(fetchOperationStatus("operation-1")).rejects.toThrow(
      "Invalid response from /api/operations/operation-1"
    );
  });

  it.each([401, 403, 404, 503])("preserves HTTP status %s on client errors", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: "Request denied" }), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const error = await fetchOperationStatus("operation-1").catch((caught) => caught);
    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({ message: "Request denied", status });
  });

  it("preserves validated accepted operation metadata on a 503", async () => {
    const operation = { id: "start-accepted", type: "start", status: "accepted" } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: "Dispatch unconfirmed", operation }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const error = await fetchOperationStatus("operation-1").catch((caught) => caught);
    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({ status: 503, operation });
  });
});
