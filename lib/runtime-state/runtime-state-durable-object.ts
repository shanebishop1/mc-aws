interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

interface CounterInput {
  key: string;
  limit: number;
  windowMs: number;
  incrementBy?: number;
}

interface CounterEntry {
  count: number;
  windowStartedAtMs: number;
}

const COUNTER_STATE_KEY = "counter-state";

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const buildCounterWindowState = ({
  count,
  limit,
  windowStartedAtMs,
  windowMs,
  nowMs,
}: {
  count: number;
  limit: number;
  windowStartedAtMs: number;
  windowMs: number;
  nowMs: number;
}) => {
  const allowed = count <= limit;
  const remaining = allowed ? Math.max(0, limit - count) : 0;
  const windowElapsedMs = nowMs - windowStartedAtMs;
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((windowMs - windowElapsedMs) / 1000));

  return {
    allowed,
    count,
    remaining,
    retryAfterSeconds,
    windowStartedAtMs,
  };
};

const parseCounterInput = (value: unknown, requireIncrementBy: boolean): CounterInput | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.key !== "string" || typeof value.limit !== "number" || typeof value.windowMs !== "number") {
    return null;
  }

  if (value.key.trim().length === 0 || value.limit <= 0 || value.windowMs <= 0) {
    return null;
  }

  if (typeof value.incrementBy !== "undefined") {
    if (typeof value.incrementBy !== "number" || value.incrementBy <= 0) {
      return null;
    }
  } else if (requireIncrementBy) {
    return null;
  }

  return {
    key: value.key,
    limit: value.limit,
    windowMs: value.windowMs,
    incrementBy: value.incrementBy,
  };
};

const invalidInputResponse = (message: string) => {
  return jsonResponse(
    {
      ok: false,
      error: {
        code: "counter_invalid_input",
        message,
        retryable: false,
      },
    },
    400
  );
};

export class RuntimeStateDurableObject {
  constructor(private readonly state: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: { code: "counter_invalid_input", message: "Method not allowed." } }, 405);
    }

    if (url.pathname === "/counter/increment") {
      return this.handleIncrement(request);
    }

    if (url.pathname === "/counter/check") {
      return this.handleCheck(request);
    }

    return jsonResponse(
      { ok: false, error: { code: "counter_not_found", message: "Unknown counter operation." } },
      404
    );
  }

  private async handleIncrement(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = (await request.json()) as unknown;
    } catch {
      return invalidInputResponse("Counter payload must be valid JSON.");
    }

    const input = parseCounterInput(payload, false);
    if (!input) {
      return invalidInputResponse("Counter key, limit, window, and increment must be valid positive values.");
    }

    const nowMs = Date.now();
    const incrementBy = input.incrementBy ?? 1;
    const current = await this.state.storage.get<CounterEntry>(COUNTER_STATE_KEY);

    if (!current || nowMs - current.windowStartedAtMs >= input.windowMs) {
      const nextCount = incrementBy;
      await this.state.storage.put(COUNTER_STATE_KEY, {
        count: nextCount,
        windowStartedAtMs: nowMs,
      });

      return jsonResponse({
        ok: true,
        data: buildCounterWindowState({
          count: nextCount,
          limit: input.limit,
          windowStartedAtMs: nowMs,
          windowMs: input.windowMs,
          nowMs,
        }),
      });
    }

    const nextCount = current.count + incrementBy;
    await this.state.storage.put(COUNTER_STATE_KEY, {
      count: nextCount,
      windowStartedAtMs: current.windowStartedAtMs,
    });

    return jsonResponse({
      ok: true,
      data: buildCounterWindowState({
        count: nextCount,
        limit: input.limit,
        windowStartedAtMs: current.windowStartedAtMs,
        windowMs: input.windowMs,
        nowMs,
      }),
    });
  }

  private async handleCheck(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = (await request.json()) as unknown;
    } catch {
      return invalidInputResponse("Counter payload must be valid JSON.");
    }

    const input = parseCounterInput(payload, false);
    if (!input) {
      return invalidInputResponse("Counter key, limit, and window must be valid positive values.");
    }

    const nowMs = Date.now();
    const current = await this.state.storage.get<CounterEntry>(COUNTER_STATE_KEY);

    if (!current || nowMs - current.windowStartedAtMs >= input.windowMs) {
      return jsonResponse({
        ok: true,
        data: {
          allowed: true,
          count: 0,
          remaining: input.limit,
          retryAfterSeconds: 0,
          windowStartedAtMs: nowMs,
        },
      });
    }

    return jsonResponse({
      ok: true,
      data: buildCounterWindowState({
        count: current.count,
        limit: input.limit,
        windowStartedAtMs: current.windowStartedAtMs,
        windowMs: input.windowMs,
        nowMs,
      }),
    });
  }
}
