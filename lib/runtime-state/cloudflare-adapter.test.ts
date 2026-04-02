import { createCloudflareRuntimeStateAdapter } from "@/lib/runtime-state/cloudflare-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

const createJsonResponse = (payload: unknown, status = 200): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe("cloudflare runtime-state adapter counter operations", () => {
  it("returns counter_invalid_input for local invalid increment/check input", async () => {
    const fetchMock = vi.fn();
    const adapter = createCloudflareRuntimeStateAdapter({
      durableObjectNamespace: {
        idFromName: vi.fn(() => "id"),
        get: vi.fn(() => ({ fetch: fetchMock })),
      },
    });

    const incrementResult = await adapter.incrementCounter({
      key: "   ",
      limit: 1,
      windowMs: 1_000,
      incrementBy: 1,
    });
    const checkResult = await adapter.checkCounter({
      key: "counter:key",
      limit: 0,
      windowMs: 1_000,
    });

    expect(incrementResult).toEqual({
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Counter key, limit, window, and increment must be valid positive values.",
        retryable: false,
      },
    });
    expect(checkResult).toEqual({
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Counter key, limit, and window must be valid positive values.",
        retryable: false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns counter_unavailable when durable object binding is missing", async () => {
    const adapter = createCloudflareRuntimeStateAdapter({});

    const incrementResult = await adapter.incrementCounter({
      key: "counter:key",
      limit: 2,
      windowMs: 10_000,
    });
    const checkResult = await adapter.checkCounter({
      key: "counter:key",
      limit: 2,
      windowMs: 10_000,
    });

    expect(incrementResult).toMatchObject({
      ok: false,
      error: {
        code: "counter_unavailable",
        retryable: true,
      },
    });
    expect(checkResult).toMatchObject({
      ok: false,
      error: {
        code: "counter_unavailable",
        retryable: true,
      },
    });
  });

  it("calls durable object stub for increment/check and normalizes successful responses", async () => {
    const idFromName = vi.fn(() => "counter-id");
    const get = vi.fn();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/increment")) {
        return createJsonResponse({
          ok: true,
          data: {
            allowed: true,
            count: 2,
            remaining: 1,
            retryAfterSeconds: 0,
            windowStartedAtMs: 1_700_000_000_000,
          },
        });
      }

      return createJsonResponse({
        allowed: true,
        count: 2,
        remaining: 1,
        retryAfterSeconds: 0,
        windowStartedAtMs: 1_700_000_000_000,
      });
    });

    get.mockReturnValue({ fetch: fetchMock });

    const adapter = createCloudflareRuntimeStateAdapter({
      durableObjectNamespace: {
        idFromName,
        get,
      },
    });

    const incrementResult = await adapter.incrementCounter({
      key: "counter:key",
      limit: 3,
      windowMs: 60_000,
      incrementBy: 2,
    });
    const checkResult = await adapter.checkCounter({
      key: "counter:key",
      limit: 3,
      windowMs: 60_000,
    });

    expect(idFromName).toHaveBeenCalledWith("counter:key");
    expect(get).toHaveBeenCalledWith("counter-id");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(incrementResult).toEqual({
      ok: true,
      data: {
        allowed: true,
        count: 2,
        remaining: 1,
        retryAfterSeconds: 0,
        windowStartedAtMs: 1_700_000_000_000,
      },
    });
    expect(checkResult).toEqual({
      ok: true,
      data: {
        allowed: true,
        count: 2,
        remaining: 1,
        retryAfterSeconds: 0,
        windowStartedAtMs: 1_700_000_000_000,
      },
    });
  });

  it("maps backend counter_invalid_input errors to non-retryable invalid input", async () => {
    const adapter = createCloudflareRuntimeStateAdapter({
      durableObjectNamespace: {
        idFromName: vi.fn(() => "counter-id"),
        get: vi.fn(() => ({
          fetch: vi.fn(async () => {
            return createJsonResponse(
              {
                ok: false,
                error: {
                  code: "counter_invalid_input",
                  message: "Backend rejected counter input.",
                  retryable: false,
                },
              },
              400
            );
          }),
        })),
      },
    });

    const result = await adapter.incrementCounter({
      key: "counter:key",
      limit: 1,
      windowMs: 1_000,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Backend rejected counter input.",
        retryable: false,
      },
    });
  });

  it("maps backend exceptions to retryable counter_unavailable", async () => {
    const adapter = createCloudflareRuntimeStateAdapter({
      durableObjectNamespace: {
        idFromName: vi.fn(() => "counter-id"),
        get: vi.fn(() => ({
          fetch: vi.fn(async () => {
            throw new Error("boom");
          }),
        })),
      },
    });

    const result = await adapter.checkCounter({
      key: "counter:key",
      limit: 2,
      windowMs: 2_000,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "counter_unavailable",
        retryable: true,
      },
    });
  });

  it("preserves strict counter boundary semantics from durable object backend", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));

    const state = new Map<string, { count: number; windowStartedAtMs: number }>();

    const adapter = createCloudflareRuntimeStateAdapter({
      durableObjectNamespace: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: string) => ({
          fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(init?.body as string) as {
              key: string;
              limit: number;
              windowMs: number;
              incrementBy?: number;
            };
            const nowMs = Date.now();
            const current = state.get(id);
            const inWindow = current && nowMs - current.windowStartedAtMs < body.windowMs;
            const windowStartedAtMs = inWindow ? current.windowStartedAtMs : nowMs;
            const currentCount = inWindow ? current.count : 0;
            const nextCount = currentCount + (body.incrementBy ?? 1);
            state.set(id, {
              count: nextCount,
              windowStartedAtMs,
            });

            const allowed = nextCount <= body.limit;
            const retryAfterSeconds = allowed
              ? 0
              : Math.max(1, Math.ceil((body.windowMs - (nowMs - windowStartedAtMs)) / 1000));

            return createJsonResponse({
              ok: true,
              data: {
                allowed,
                count: nextCount,
                remaining: allowed ? Math.max(0, body.limit - nextCount) : 0,
                retryAfterSeconds,
                windowStartedAtMs,
              },
            });
          }),
        })),
      },
    });

    const first = await adapter.incrementCounter({ key: "counter:key", limit: 3, windowMs: 60_000 });
    const boundary = await adapter.incrementCounter({ key: "counter:key", limit: 3, windowMs: 60_000, incrementBy: 2 });
    const overflow = await adapter.incrementCounter({ key: "counter:key", limit: 3, windowMs: 60_000 });

    expect(first).toMatchObject({ ok: true, data: { allowed: true, count: 1, remaining: 2, retryAfterSeconds: 0 } });
    expect(boundary).toMatchObject({ ok: true, data: { allowed: true, count: 3, remaining: 0, retryAfterSeconds: 0 } });
    expect(overflow).toMatchObject({
      ok: true,
      data: { allowed: false, count: 4, remaining: 0, retryAfterSeconds: 60 },
    });
  });
});

describe("cloudflare runtime-state adapter snapshot operations", () => {
  it("returns snapshot_unavailable when kv binding is missing", async () => {
    const adapter = createCloudflareRuntimeStateAdapter({});

    const getResult = await adapter.getSnapshot<{ status: string }>({
      key: "snapshot:key",
    });

    expect(getResult).toMatchObject({
      ok: false,
      error: {
        code: "snapshot_unavailable",
        retryable: true,
      },
    });
  });

  it("stores, reads, and invalidates snapshots through kv", async () => {
    const kvState = new Map<string, string>();
    const get = vi.fn(async (key: string) => kvState.get(key) ?? null);
    const put = vi.fn(async (key: string, value: string) => {
      kvState.set(key, value);
    });
    const remove = vi.fn(async (key: string) => {
      kvState.delete(key);
    });

    const adapter = createCloudflareRuntimeStateAdapter({
      snapshotKvNamespace: {
        get,
        put,
        delete: remove,
      },
    });

    const setResult = await adapter.setSnapshot({
      key: "snapshot:key",
      value: { status: "CREATE_COMPLETE" },
      ttlSeconds: 30,
    });
    const hitResult = await adapter.getSnapshot<{ status: string }>({
      key: "snapshot:key",
    });
    const invalidateResult = await adapter.invalidateSnapshot({
      key: "snapshot:key",
    });
    const missResult = await adapter.getSnapshot<{ status: string }>({
      key: "snapshot:key",
    });

    expect(put).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("snapshot:key");
    expect(setResult).toMatchObject({
      ok: true,
      data: {
        key: "snapshot:key",
      },
    });
    expect(hitResult).toEqual({
      ok: true,
      data: {
        status: "hit",
        value: { status: "CREATE_COMPLETE" },
        updatedAt: expect.any(String),
      },
    });
    expect(invalidateResult).toEqual({
      ok: true,
      data: {
        key: "snapshot:key",
        invalidated: true,
      },
    });
    expect(missResult).toEqual({
      ok: true,
      data: {
        status: "miss",
      },
    });
  });

  it("returns snapshot_decode_failed for malformed stored payload", async () => {
    const adapter = createCloudflareRuntimeStateAdapter({
      snapshotKvNamespace: {
        get: vi.fn(async () => "not-json"),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
    });

    const result = await adapter.getSnapshot<{ ok: boolean }>({
      key: "snapshot:key",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "snapshot_decode_failed",
        message: "Stored snapshot payload is malformed.",
        retryable: false,
      },
    });
  });

  it("returns snapshot_invalid_input for invalid set/invalidate inputs", async () => {
    const adapter = createCloudflareRuntimeStateAdapter({
      snapshotKvNamespace: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
    });

    const setResult = await adapter.setSnapshot({
      key: " ",
      value: { ok: true },
      ttlSeconds: 1,
    });
    const invalidateResult = await adapter.invalidateSnapshot({
      key: " ",
    });

    expect(setResult).toEqual({
      ok: false,
      error: {
        code: "snapshot_invalid_input",
        message: "Snapshot key must be non-empty and ttlSeconds must be positive when provided.",
        retryable: false,
      },
    });
    expect(invalidateResult).toEqual({
      ok: false,
      error: {
        code: "snapshot_invalid_input",
        message: "Snapshot key must be non-empty.",
        retryable: false,
      },
    });
  });

  it("enforces bounded staleness using kv ttl-backed expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));

    const kvState = new Map<string, { value: string; expiresAtMs?: number }>();
    const adapter = createCloudflareRuntimeStateAdapter({
      snapshotKvNamespace: {
        get: vi.fn(async (key: string) => {
          const record = kvState.get(key);
          if (!record) {
            return null;
          }

          if (typeof record.expiresAtMs === "number" && Date.now() >= record.expiresAtMs) {
            kvState.delete(key);
            return null;
          }

          return record.value;
        }),
        put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
          kvState.set(key, {
            value,
            expiresAtMs:
              typeof options?.expirationTtl === "number" ? Date.now() + options.expirationTtl * 1000 : undefined,
          });
        }),
        delete: vi.fn(async (key: string) => {
          kvState.delete(key);
        }),
      },
    });

    const key = "snapshot:key";
    const value = { status: "CREATE_COMPLETE" };
    await adapter.setSnapshot({ key, value, ttlSeconds: 5 });

    vi.advanceTimersByTime(4_999);
    const staleButAllowed = await adapter.getSnapshot<typeof value>({ key });

    vi.advanceTimersByTime(1);
    const expired = await adapter.getSnapshot<typeof value>({ key });

    expect(staleButAllowed).toMatchObject({
      ok: true,
      data: {
        status: "hit",
        value,
      },
    });
    expect(expired).toEqual({
      ok: true,
      data: {
        status: "miss",
      },
    });
  });
});
