import type {
  CounterCheckInput,
  CounterCheckResult,
  CounterIncrementInput,
  CounterIncrementResult,
  RuntimeStateAdapter,
  SnapshotGetInput,
  SnapshotGetResult,
  SnapshotInvalidateInput,
  SnapshotInvalidateResult,
  SnapshotSetInput,
  SnapshotSetResult,
} from "@/lib/runtime-state";
import { vi } from "vitest";

interface RuntimeStateFixtureOptions {
  nowMs?: () => number;
}

type SnapshotRecord = {
  value: unknown;
  updatedAt: string;
  expiresAtMs?: number;
};

type CounterRecord = {
  count: number;
  windowStartedAtMs: number;
};

export interface RuntimeStateAdapterFixture {
  adapter: RuntimeStateAdapter;
  getSnapshotMock: ReturnType<typeof vi.fn>;
  setSnapshotMock: ReturnType<typeof vi.fn>;
  invalidateSnapshotMock: ReturnType<typeof vi.fn>;
  checkCounterMock: ReturnType<typeof vi.fn>;
  incrementCounterMock: ReturnType<typeof vi.fn>;
  seedSnapshot<TSnapshot>(key: string, value: TSnapshot, updatedAt?: string): void;
}

export function createRuntimeStateAdapterFixture(options: RuntimeStateFixtureOptions = {}): RuntimeStateAdapterFixture {
  const nowMs = options.nowMs ?? (() => Date.now());
  const snapshots = new Map<string, SnapshotRecord>();
  const counters = new Map<string, CounterRecord>();

  const getSnapshot = vi.fn(async (input: SnapshotGetInput): Promise<SnapshotGetResult<unknown>> => {
    const snapshot = snapshots.get(input.key);
    const now = nowMs();

    if (!snapshot || (snapshot.expiresAtMs !== undefined && snapshot.expiresAtMs <= now)) {
      if (snapshot?.expiresAtMs !== undefined && snapshot.expiresAtMs <= now) {
        snapshots.delete(input.key);
      }

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
        value: snapshot.value,
        updatedAt: snapshot.updatedAt,
      },
    };
  });

  const setSnapshot = vi.fn(async (input: SnapshotSetInput<unknown>): Promise<SnapshotSetResult> => {
    const now = nowMs();
    const expiresAtMs = input.ttlSeconds ? now + input.ttlSeconds * 1000 : undefined;

    snapshots.set(input.key, {
      value: input.value,
      updatedAt: new Date(now).toISOString(),
      expiresAtMs,
    });

    return {
      ok: true,
      data: {
        key: input.key,
        expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : undefined,
      },
    };
  });

  const invalidateSnapshot = vi.fn(async (input: SnapshotInvalidateInput): Promise<SnapshotInvalidateResult> => {
    const invalidated = snapshots.delete(input.key);

    return {
      ok: true,
      data: {
        key: input.key,
        invalidated,
      },
    };
  });

  const resolveCounter = (input: CounterCheckInput | CounterIncrementInput, incrementBy = 0) => {
    const now = nowMs();
    const existing = counters.get(input.key);
    const windowStart = existing?.windowStartedAtMs ?? now;
    const elapsedMs = now - windowStart;

    const inWindow = elapsedMs < input.windowMs;
    const activeWindowStart = inWindow ? windowStart : now;
    const baseCount = inWindow ? (existing?.count ?? 0) : 0;
    const nextCount = baseCount + incrementBy;

    counters.set(input.key, {
      count: nextCount,
      windowStartedAtMs: activeWindowStart,
    });

    const windowRemainingMs = Math.max(input.windowMs - (now - activeWindowStart), 0);
    const allowed = nextCount <= input.limit;

    return {
      allowed,
      count: nextCount,
      remaining: Math.max(input.limit - nextCount, 0),
      retryAfterSeconds: windowRemainingMs === 0 ? 0 : Math.ceil(windowRemainingMs / 1000),
      windowStartedAtMs: activeWindowStart,
    };
  };

  const checkCounter = vi.fn(async (input: CounterCheckInput): Promise<CounterCheckResult> => {
    return {
      ok: true,
      data: resolveCounter(input),
    };
  });

  const incrementCounter = vi.fn(async (input: CounterIncrementInput): Promise<CounterIncrementResult> => {
    return {
      ok: true,
      data: resolveCounter(input, input.incrementBy ?? 1),
    };
  });

  const adapter: RuntimeStateAdapter = {
    kind: "in-memory",
    getSnapshot: getSnapshot as RuntimeStateAdapter["getSnapshot"],
    setSnapshot: setSnapshot as RuntimeStateAdapter["setSnapshot"],
    invalidateSnapshot,
    checkCounter,
    incrementCounter,
  };

  return {
    adapter,
    getSnapshotMock: getSnapshot,
    setSnapshotMock: setSnapshot,
    invalidateSnapshotMock: invalidateSnapshot,
    checkCounterMock: checkCounter,
    incrementCounterMock: incrementCounter,
    seedSnapshot: (key, value, updatedAt) => {
      snapshots.set(key, {
        value,
        updatedAt: updatedAt ?? new Date(nowMs()).toISOString(),
      });
    },
  };
}
