import { RuntimeStateDurableObject } from "@/lib/runtime-state/runtime-state-durable-object";
import { afterEach, describe, expect, it, vi } from "vitest";

interface StoredCounterState {
  count: number;
  windowStartedAtMs: number;
}

const createDurableObject = () => {
  const storage = new Map<string, unknown>();
  const state = {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T): Promise<void> => {
        storage.set(key, value);
      },
    },
  };

  return {
    durableObject: new RuntimeStateDurableObject(state),
    storage,
    state,
  };
};

const request = (path: string, payload: unknown, method = "POST") => {
  return new Request(`https://runtime-state.internal${path}`, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime-state durable object", () => {
  it("handles increment/check through the expected counter routes", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { durableObject, storage } = createDurableObject();

    const incrementResponse = await durableObject.fetch(
      request("/counter/increment", {
        key: "counter:status",
        limit: 1,
        windowMs: 10_000,
      })
    );
    const incrementPayload = (await incrementResponse.json()) as {
      ok: true;
      data: { count: number; allowed: boolean; remaining: number; retryAfterSeconds: number };
    };

    expect(incrementResponse.status).toBe(200);
    expect(incrementPayload.ok).toBe(true);
    expect(incrementPayload.data).toMatchObject({
      count: 1,
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    });

    const checkResponse = await durableObject.fetch(
      request("/counter/check", {
        key: "counter:status",
        limit: 1,
        windowMs: 10_000,
      })
    );
    const checkPayload = (await checkResponse.json()) as {
      ok: true;
      data: { count: number; allowed: boolean; remaining: number; retryAfterSeconds: number };
    };

    expect(checkResponse.status).toBe(200);
    expect(checkPayload.ok).toBe(true);
    expect(checkPayload.data).toMatchObject({
      count: 1,
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 0,
    });

    const stored = storage.get("counter-state") as StoredCounterState | undefined;
    expect(stored?.count).toBe(1);
  });

  it("returns counter_invalid_input for malformed payloads", async () => {
    const { durableObject } = createDurableObject();

    const response = await durableObject.fetch(
      request("/counter/increment", {
        key: "",
        limit: 1,
        windowMs: 1_000,
      })
    );
    const payload = (await response.json()) as {
      ok: false;
      error: { code: string; retryable: boolean };
    };

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "counter_invalid_input",
        retryable: false,
      },
    });
  });

  it("returns 404 for unknown counter routes", async () => {
    const { durableObject } = createDurableObject();

    const response = await durableObject.fetch(
      request("/counter/unknown", {
        key: "counter:status",
        limit: 1,
        windowMs: 1_000,
      })
    );

    expect(response.status).toBe(404);
  });
});
