import type { RuntimeStateInMemoryAdapter } from "@/lib/runtime-state/adapters";
import type {
  CounterCheckInput,
  CounterCheckResult,
  CounterIncrementInput,
  CounterIncrementResult,
  CounterWindowState,
  SnapshotGetInput,
  SnapshotGetResult,
  SnapshotInvalidateInput,
  SnapshotInvalidateResult,
  SnapshotSetInput,
  SnapshotSetResult,
} from "@/lib/runtime-state/contract";

interface CounterEntry {
  count: number;
  windowStartedAtMs: number;
}

interface SnapshotEntry {
  value: unknown;
  updatedAt: string;
  expiresAtMs?: number;
}

const counters = new Map<string, CounterEntry>();
const snapshots = new Map<string, SnapshotEntry>();

export function resetInMemoryRuntimeStateAdapterState(): void {
  counters.clear();
  snapshots.clear();
}

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
}): CounterWindowState => {
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

const isInvalidCounterInput = ({ key, limit, windowMs }: CounterCheckInput): boolean => {
  return key.trim().length === 0 || limit <= 0 || windowMs <= 0;
};

const incrementCounter = async ({
  key,
  limit,
  windowMs,
  incrementBy = 1,
}: CounterIncrementInput): Promise<CounterIncrementResult> => {
  if (isInvalidCounterInput({ key, limit, windowMs }) || incrementBy <= 0) {
    return {
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Counter key, limit, window, and increment must be valid positive values.",
        retryable: false,
      },
    };
  }

  const nowMs = Date.now();
  const current = counters.get(key);

  if (!current || nowMs - current.windowStartedAtMs >= windowMs) {
    const nextCount = incrementBy;
    counters.set(key, {
      count: nextCount,
      windowStartedAtMs: nowMs,
    });

    return {
      ok: true,
      data: buildCounterWindowState({
        count: nextCount,
        limit,
        windowStartedAtMs: nowMs,
        windowMs,
        nowMs,
      }),
    };
  }

  const nextCount = current.count + incrementBy;
  counters.set(key, {
    count: nextCount,
    windowStartedAtMs: current.windowStartedAtMs,
  });

  return {
    ok: true,
    data: buildCounterWindowState({
      count: nextCount,
      limit,
      windowStartedAtMs: current.windowStartedAtMs,
      windowMs,
      nowMs,
    }),
  };
};

const checkCounter = async ({ key, limit, windowMs }: CounterCheckInput): Promise<CounterCheckResult> => {
  if (isInvalidCounterInput({ key, limit, windowMs })) {
    return {
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Counter key, limit, and window must be valid positive values.",
        retryable: false,
      },
    };
  }

  const nowMs = Date.now();
  const current = counters.get(key);

  if (!current || nowMs - current.windowStartedAtMs >= windowMs) {
    return {
      ok: true,
      data: {
        allowed: true,
        count: 0,
        remaining: limit,
        retryAfterSeconds: 0,
        windowStartedAtMs: nowMs,
      },
    };
  }

  return {
    ok: true,
    data: buildCounterWindowState({
      count: current.count,
      limit,
      windowStartedAtMs: current.windowStartedAtMs,
      windowMs,
      nowMs,
    }),
  };
};

const getSnapshot = async <TSnapshot>({ key }: SnapshotGetInput): Promise<SnapshotGetResult<TSnapshot>> => {
  const snapshot = snapshots.get(key);

  if (!snapshot) {
    return {
      ok: true,
      data: {
        status: "miss",
      },
    };
  }

  if (typeof snapshot.expiresAtMs === "number" && Date.now() >= snapshot.expiresAtMs) {
    snapshots.delete(key);
    return {
      ok: true,
      data: {
        status: "miss",
      },
    };
  }

  return {
    ok: true,
    data: {
      status: "hit",
      value: snapshot.value as TSnapshot,
      updatedAt: snapshot.updatedAt,
    },
  };
};

const setSnapshot = async <TSnapshot>({
  key,
  value,
  ttlSeconds,
}: SnapshotSetInput<TSnapshot>): Promise<SnapshotSetResult> => {
  if (key.trim().length === 0 || (typeof ttlSeconds === "number" && ttlSeconds <= 0)) {
    return {
      ok: false,
      error: {
        code: "snapshot_invalid_input",
        message: "Snapshot key must be non-empty and ttlSeconds must be positive when provided.",
        retryable: false,
      },
    };
  }

  const updatedAt = new Date().toISOString();
  const expiresAtMs = typeof ttlSeconds === "number" ? Date.now() + ttlSeconds * 1000 : undefined;
  snapshots.set(key, {
    value,
    updatedAt,
    expiresAtMs,
  });

  return {
    ok: true,
    data: {
      key,
      expiresAt: typeof expiresAtMs === "number" ? new Date(expiresAtMs).toISOString() : undefined,
    },
  };
};

const invalidateSnapshot = async ({ key }: SnapshotInvalidateInput): Promise<SnapshotInvalidateResult> => {
  if (key.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "snapshot_invalid_input",
        message: "Snapshot key must be non-empty.",
        retryable: false,
      },
    };
  }

  const invalidated = snapshots.delete(key);
  return {
    ok: true,
    data: {
      key,
      invalidated,
    },
  };
};

export const inMemoryRuntimeStateAdapter: RuntimeStateInMemoryAdapter = {
  kind: "in-memory",
  incrementCounter,
  checkCounter,
  getSnapshot,
  setSnapshot,
  invalidateSnapshot,
};
