import type { RuntimeStateCloudflareAdapter, RuntimeStateCloudflareBindings } from "@/lib/runtime-state/adapters";
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

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

interface KvGetOptionsLike {
  type?: "text";
}

interface KvPutOptionsLike {
  expirationTtl?: number;
}

interface SnapshotKvNamespaceLike {
  get(key: string, options?: KvGetOptionsLike): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptionsLike): Promise<void>;
  delete(key: string): Promise<void>;
}

interface SnapshotRecord {
  value: unknown;
  updatedAt: string;
  expiresAt?: string;
}

const COUNTER_UNAVAILABLE_MESSAGE = "Cloudflare Durable Object counter service is unavailable.";
const SNAPSHOT_UNAVAILABLE_MESSAGE = "Cloudflare KV snapshot service is unavailable.";

const isInvalidCounterInput = ({ key, limit, windowMs }: CounterCheckInput): boolean => {
  return key.trim().length === 0 || limit <= 0 || windowMs <= 0;
};

const getCounterUnavailableError = (message = COUNTER_UNAVAILABLE_MESSAGE) => {
  return {
    code: "counter_unavailable" as const,
    message,
    retryable: true,
  };
};

const getSnapshotUnavailableError = (message = SNAPSHOT_UNAVAILABLE_MESSAGE) => {
  return {
    code: "snapshot_unavailable" as const,
    message,
    retryable: true,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizePositiveNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }

  return value >= 0 ? value : null;
};

const normalizeCounterWindowState = (value: unknown): CounterWindowState | null => {
  if (!isRecord(value)) {
    return null;
  }

  const count = normalizePositiveNumber(value.count);
  const remaining = normalizePositiveNumber(value.remaining);
  const retryAfterSeconds = normalizePositiveNumber(value.retryAfterSeconds);
  const windowStartedAtMs = normalizePositiveNumber(value.windowStartedAtMs);

  if (
    typeof value.allowed !== "boolean" ||
    count === null ||
    remaining === null ||
    retryAfterSeconds === null ||
    windowStartedAtMs === null
  ) {
    return null;
  }

  return {
    allowed: value.allowed,
    count,
    remaining,
    retryAfterSeconds,
    windowStartedAtMs,
  };
};

const getDurableObjectNamespace = (bindings: RuntimeStateCloudflareBindings): DurableObjectNamespaceLike | null => {
  if (!isRecord(bindings)) {
    return null;
  }

  const namespace = bindings.durableObjectNamespace;
  if (!isRecord(namespace)) {
    return null;
  }

  const idFromName = namespace.idFromName;
  const get = namespace.get;

  if (typeof idFromName !== "function" || typeof get !== "function") {
    return null;
  }

  return namespace as unknown as DurableObjectNamespaceLike;
};

const getCounterStub = (bindings: RuntimeStateCloudflareBindings, key: string): DurableObjectStubLike | null => {
  const namespace = getDurableObjectNamespace(bindings);
  if (!namespace) {
    return null;
  }

  try {
    const id = namespace.idFromName(key);
    const stub = namespace.get(id);

    if (!isRecord(stub) || typeof stub.fetch !== "function") {
      return null;
    }

    return stub as DurableObjectStubLike;
  } catch {
    return null;
  }
};

const getSnapshotKvNamespace = (bindings: RuntimeStateCloudflareBindings): SnapshotKvNamespaceLike | null => {
  if (!isRecord(bindings)) {
    return null;
  }

  const namespace = bindings.snapshotKvNamespace;
  if (!isRecord(namespace)) {
    return null;
  }

  if (
    typeof namespace.get !== "function" ||
    typeof namespace.put !== "function" ||
    typeof namespace.delete !== "function"
  ) {
    return null;
  }

  return namespace as unknown as SnapshotKvNamespaceLike;
};

const normalizeSnapshotRecord = (value: unknown): SnapshotRecord | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.updatedAt !== "string" || !("value" in value)) {
    return null;
  }

  if (typeof value.expiresAt !== "undefined" && typeof value.expiresAt !== "string") {
    return null;
  }

  return {
    value: value.value,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  };
};

const extractBackendError = (payload: unknown): { code: string; message: string; retryable?: boolean } | null => {
  if (!isRecord(payload)) {
    return null;
  }

  if (isRecord(payload.error)) {
    const error = payload.error;
    if (typeof error.code === "string" && typeof error.message === "string") {
      return {
        code: error.code,
        message: error.message,
        retryable: typeof error.retryable === "boolean" ? error.retryable : undefined,
      };
    }
  }

  if (typeof payload.code === "string" && typeof payload.message === "string") {
    return {
      code: payload.code,
      message: payload.message,
      retryable: typeof payload.retryable === "boolean" ? payload.retryable : undefined,
    };
  }

  return null;
};

const isBackendInvalidInputError = (
  payload: unknown
): payload is { code: "counter_invalid_input"; message: string } => {
  const backendError = extractBackendError(payload);
  if (!backendError) {
    return false;
  }

  return backendError.code === "counter_invalid_input";
};

const normalizeCounterOperationResponse = (payload: unknown): CounterWindowState | null => {
  if (isRecord(payload) && payload.ok === true && "data" in payload) {
    return normalizeCounterWindowState(payload.data);
  }

  return normalizeCounterWindowState(payload);
};

const callDurableObjectCounter = async (
  bindings: RuntimeStateCloudflareBindings,
  operation: "increment" | "check",
  input: CounterIncrementInput | CounterCheckInput
): Promise<CounterCheckResult | CounterIncrementResult> => {
  const stub = getCounterStub(bindings, input.key);
  if (!stub) {
    return {
      ok: false,
      error: getCounterUnavailableError(),
    };
  }

  try {
    const response = await stub.fetch(`https://runtime-state.internal/counter/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });

    const payload = (await response.json()) as unknown;

    const normalized = normalizeCounterOperationResponse(payload);
    if (normalized) {
      return {
        ok: true,
        data: normalized,
      };
    }

    if (isBackendInvalidInputError(payload)) {
      const backendError = extractBackendError(payload);
      return {
        ok: false,
        error: {
          code: "counter_invalid_input",
          message: backendError?.message ?? "Counter input is invalid.",
          retryable: false,
        },
      };
    }

    return {
      ok: false,
      error: getCounterUnavailableError(
        response.ok ? COUNTER_UNAVAILABLE_MESSAGE : `Counter backend request failed: ${response.status}.`
      ),
    };
  } catch {
    return {
      ok: false,
      error: getCounterUnavailableError(),
    };
  }
};

const incrementCounter = async (
  bindings: RuntimeStateCloudflareBindings,
  input: CounterIncrementInput
): Promise<CounterIncrementResult> => {
  if (isInvalidCounterInput(input) || (typeof input.incrementBy === "number" && input.incrementBy <= 0)) {
    return {
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Counter key, limit, window, and increment must be valid positive values.",
        retryable: false,
      },
    };
  }

  const response = await callDurableObjectCounter(bindings, "increment", input);
  return response as CounterIncrementResult;
};

const checkCounter = async (
  bindings: RuntimeStateCloudflareBindings,
  input: CounterCheckInput
): Promise<CounterCheckResult> => {
  if (isInvalidCounterInput(input)) {
    return {
      ok: false,
      error: {
        code: "counter_invalid_input",
        message: "Counter key, limit, and window must be valid positive values.",
        retryable: false,
      },
    };
  }

  const response = await callDurableObjectCounter(bindings, "check", input);
  return response as CounterCheckResult;
};

const getSnapshot = async <TSnapshot>(
  bindings: RuntimeStateCloudflareBindings,
  { key }: SnapshotGetInput
): Promise<SnapshotGetResult<TSnapshot>> => {
  const namespace = getSnapshotKvNamespace(bindings);
  if (!namespace) {
    return {
      ok: false,
      error: getSnapshotUnavailableError(),
    };
  }

  try {
    const raw = await namespace.get(key, { type: "text" });
    if (!raw) {
      return {
        ok: true,
        data: {
          status: "miss",
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {
        ok: false,
        error: {
          code: "snapshot_decode_failed",
          message: "Stored snapshot payload is malformed.",
          retryable: false,
        },
      };
    }

    const snapshot = normalizeSnapshotRecord(parsed);
    if (!snapshot) {
      return {
        ok: false,
        error: {
          code: "snapshot_decode_failed",
          message: "Stored snapshot payload is malformed.",
          retryable: false,
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
  } catch {
    return {
      ok: false,
      error: getSnapshotUnavailableError(),
    };
  }
};

const setSnapshot = async <TSnapshot>(
  bindings: RuntimeStateCloudflareBindings,
  { key, value, ttlSeconds }: SnapshotSetInput<TSnapshot>
): Promise<SnapshotSetResult> => {
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

  const namespace = getSnapshotKvNamespace(bindings);
  if (!namespace) {
    return {
      ok: false,
      error: getSnapshotUnavailableError(),
    };
  }

  const updatedAt = new Date().toISOString();
  const expiresAt = typeof ttlSeconds === "number" ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : undefined;

  let payload: string;
  try {
    payload = JSON.stringify({
      value,
      updatedAt,
      expiresAt,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "snapshot_encode_failed",
        message: "Failed to serialize snapshot value for storage.",
        retryable: false,
      },
    };
  }

  try {
    await namespace.put(key, payload, {
      expirationTtl: ttlSeconds,
    });
    return {
      ok: true,
      data: {
        key,
        expiresAt,
      },
    };
  } catch {
    return {
      ok: false,
      error: getSnapshotUnavailableError(),
    };
  }
};

const invalidateSnapshot = async (
  bindings: RuntimeStateCloudflareBindings,
  { key }: SnapshotInvalidateInput
): Promise<SnapshotInvalidateResult> => {
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

  const namespace = getSnapshotKvNamespace(bindings);
  if (!namespace) {
    return {
      ok: false,
      error: getSnapshotUnavailableError(),
    };
  }

  try {
    const existing = await namespace.get(key, { type: "text" });
    await namespace.delete(key);
    return {
      ok: true,
      data: {
        key,
        invalidated: existing !== null,
      },
    };
  } catch {
    return {
      ok: false,
      error: getSnapshotUnavailableError(),
    };
  }
};

export const createCloudflareRuntimeStateAdapter = (
  bindings: RuntimeStateCloudflareBindings
): RuntimeStateCloudflareAdapter => {
  const getSnapshotForBindings = <TSnapshot>(input: SnapshotGetInput): Promise<SnapshotGetResult<TSnapshot>> => {
    return getSnapshot<TSnapshot>(bindings, input);
  };

  const setSnapshotForBindings = <TSnapshot>(input: SnapshotSetInput<TSnapshot>): Promise<SnapshotSetResult> => {
    return setSnapshot(bindings, input);
  };

  const invalidateSnapshotForBindings = (input: SnapshotInvalidateInput): Promise<SnapshotInvalidateResult> => {
    return invalidateSnapshot(bindings, input);
  };

  return {
    kind: "cloudflare",
    bindings,
    incrementCounter: (input) => incrementCounter(bindings, input),
    checkCounter: (input) => checkCounter(bindings, input),
    getSnapshot: getSnapshotForBindings,
    setSnapshot: setSnapshotForBindings,
    invalidateSnapshot: invalidateSnapshotForBindings,
  };
};
