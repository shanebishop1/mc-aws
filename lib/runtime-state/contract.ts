export type RuntimeStateCounterKey = string;
export type RuntimeStateSnapshotKey = string;

export interface RuntimeStateOperationError<TCode extends string> {
  code: TCode;
  message: string;
  retryable: boolean;
}

export type RuntimeStateResult<TData, TCode extends string> =
  | {
      ok: true;
      data: TData;
    }
  | {
      ok: false;
      error: RuntimeStateOperationError<TCode>;
    };

export interface CounterCheckInput {
  key: RuntimeStateCounterKey;
  limit: number;
  windowMs: number;
}

export interface CounterIncrementInput extends CounterCheckInput {
  incrementBy?: number;
}

export interface CounterWindowState {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSeconds: number;
  windowStartedAtMs: number;
}

export type CounterCheckErrorCode = "counter_invalid_input" | "counter_unavailable";
export type CounterIncrementErrorCode = CounterCheckErrorCode | "counter_conflict";

export type CounterCheckResult = RuntimeStateResult<CounterWindowState, CounterCheckErrorCode>;
export type CounterIncrementResult = RuntimeStateResult<CounterWindowState, CounterIncrementErrorCode>;

export interface SnapshotGetInput {
  key: RuntimeStateSnapshotKey;
}

export interface SnapshotSetInput<TSnapshot> {
  key: RuntimeStateSnapshotKey;
  value: TSnapshot;
  ttlSeconds?: number;
}

export interface SnapshotInvalidateInput {
  key: RuntimeStateSnapshotKey;
}

export type SnapshotGetData<TSnapshot> =
  | {
      status: "hit";
      value: TSnapshot;
      updatedAt: string;
    }
  | {
      status: "miss";
    };

export interface SnapshotSetData {
  key: RuntimeStateSnapshotKey;
  expiresAt?: string;
}

export interface SnapshotInvalidateData {
  key: RuntimeStateSnapshotKey;
  invalidated: boolean;
}

export type SnapshotGetErrorCode = "snapshot_unavailable" | "snapshot_decode_failed";
export type SnapshotSetErrorCode = "snapshot_unavailable" | "snapshot_encode_failed" | "snapshot_invalid_input";
export type SnapshotInvalidateErrorCode = "snapshot_unavailable" | "snapshot_invalid_input";

export type SnapshotGetResult<TSnapshot> = RuntimeStateResult<SnapshotGetData<TSnapshot>, SnapshotGetErrorCode>;
export type SnapshotSetResult = RuntimeStateResult<SnapshotSetData, SnapshotSetErrorCode>;
export type SnapshotInvalidateResult = RuntimeStateResult<SnapshotInvalidateData, SnapshotInvalidateErrorCode>;

export interface RuntimeStateCounterStore {
  incrementCounter(input: CounterIncrementInput): Promise<CounterIncrementResult>;
  checkCounter(input: CounterCheckInput): Promise<CounterCheckResult>;
}

export interface RuntimeStateSnapshotStore {
  getSnapshot<TSnapshot>(input: SnapshotGetInput): Promise<SnapshotGetResult<TSnapshot>>;
  setSnapshot<TSnapshot>(input: SnapshotSetInput<TSnapshot>): Promise<SnapshotSetResult>;
  invalidateSnapshot(input: SnapshotInvalidateInput): Promise<SnapshotInvalidateResult>;
}

export interface RuntimeStateStore extends RuntimeStateCounterStore, RuntimeStateSnapshotStore {}
