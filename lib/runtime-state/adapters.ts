import type {
  CounterCheckInput,
  CounterCheckResult,
  CounterIncrementInput,
  CounterIncrementResult,
  RuntimeStateStore,
  SnapshotGetInput,
  SnapshotGetResult,
  SnapshotInvalidateInput,
  SnapshotInvalidateResult,
  SnapshotSetInput,
  SnapshotSetResult,
} from "@/lib/runtime-state/contract";

export type RuntimeStateAdapterKind = "in-memory" | "cloudflare";

export interface RuntimeStateAdapter extends RuntimeStateStore {
  readonly kind: RuntimeStateAdapterKind;
}

export interface RuntimeStateCloudflareBindings {
  durableObjectNamespace?: unknown;
  snapshotKvNamespace?: unknown;
}

export interface RuntimeStateSelectorInput {
  nodeEnv?: string;
  bindings?: RuntimeStateCloudflareBindings | null;
}

export interface RuntimeStateCloudflareAdapter extends RuntimeStateAdapter {
  readonly kind: "cloudflare";
  readonly bindings: RuntimeStateCloudflareBindings;
}

export interface RuntimeStateInMemoryAdapter extends RuntimeStateAdapter {
  readonly kind: "in-memory";
}

export type RuntimeStateCounterOperations = {
  incrementCounter(input: CounterIncrementInput): Promise<CounterIncrementResult>;
  checkCounter(input: CounterCheckInput): Promise<CounterCheckResult>;
};

export type RuntimeStateSnapshotOperations = {
  getSnapshot<TSnapshot>(input: SnapshotGetInput): Promise<SnapshotGetResult<TSnapshot>>;
  setSnapshot<TSnapshot>(input: SnapshotSetInput<TSnapshot>): Promise<SnapshotSetResult>;
  invalidateSnapshot(input: SnapshotInvalidateInput): Promise<SnapshotInvalidateResult>;
};
