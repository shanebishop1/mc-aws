import type { RuntimeStateCloudflareAdapter, RuntimeStateCloudflareBindings } from "@/lib/runtime-state/adapters";
import type {
  CounterCheckInput,
  CounterCheckResult,
  CounterIncrementInput,
  CounterIncrementResult,
  SnapshotGetInput,
  SnapshotGetResult,
  SnapshotInvalidateInput,
  SnapshotInvalidateResult,
  SnapshotSetInput,
  SnapshotSetResult,
} from "@/lib/runtime-state/contract";

const incrementCounter = async (_input: CounterIncrementInput): Promise<CounterIncrementResult> => {
  return {
    ok: false,
    error: {
      code: "counter_unavailable",
      message: "Cloudflare runtime-state counter adapter is not configured yet.",
      retryable: true,
    },
  };
};

const checkCounter = async (_input: CounterCheckInput): Promise<CounterCheckResult> => {
  return {
    ok: false,
    error: {
      code: "counter_unavailable",
      message: "Cloudflare runtime-state counter adapter is not configured yet.",
      retryable: true,
    },
  };
};

const getSnapshot = async <TSnapshot>(_input: SnapshotGetInput): Promise<SnapshotGetResult<TSnapshot>> => {
  return {
    ok: false,
    error: {
      code: "snapshot_unavailable",
      message: "Cloudflare runtime-state snapshot adapter is not configured yet.",
      retryable: true,
    },
  };
};

const setSnapshot = async <TSnapshot>(_input: SnapshotSetInput<TSnapshot>): Promise<SnapshotSetResult> => {
  return {
    ok: false,
    error: {
      code: "snapshot_unavailable",
      message: "Cloudflare runtime-state snapshot adapter is not configured yet.",
      retryable: true,
    },
  };
};

const invalidateSnapshot = async (_input: SnapshotInvalidateInput): Promise<SnapshotInvalidateResult> => {
  return {
    ok: false,
    error: {
      code: "snapshot_unavailable",
      message: "Cloudflare runtime-state snapshot adapter is not configured yet.",
      retryable: true,
    },
  };
};

export const createCloudflareRuntimeStateAdapter = (
  bindings: RuntimeStateCloudflareBindings
): RuntimeStateCloudflareAdapter => {
  return {
    kind: "cloudflare",
    bindings,
    incrementCounter,
    checkCounter,
    getSnapshot,
    setSnapshot,
    invalidateSnapshot,
  };
};
