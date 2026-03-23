export type {
  CounterCheckErrorCode,
  CounterCheckInput,
  CounterCheckResult,
  CounterIncrementErrorCode,
  CounterIncrementInput,
  CounterIncrementResult,
  CounterWindowState,
  RuntimeStateCounterKey,
  RuntimeStateCounterStore,
  RuntimeStateOperationError,
  RuntimeStateResult,
  RuntimeStateSnapshotKey,
  RuntimeStateSnapshotStore,
  RuntimeStateStore,
  SnapshotGetData,
  SnapshotGetErrorCode,
  SnapshotGetInput,
  SnapshotGetResult,
  SnapshotInvalidateData,
  SnapshotInvalidateErrorCode,
  SnapshotInvalidateInput,
  SnapshotInvalidateResult,
  SnapshotSetData,
  SnapshotSetErrorCode,
  SnapshotSetInput,
  SnapshotSetResult,
} from "@/lib/runtime-state/contract";

export type {
  RuntimeStateAdapter,
  RuntimeStateAdapterKind,
  RuntimeStateCloudflareAdapter,
  RuntimeStateCloudflareBindings,
  RuntimeStateCounterOperations,
  RuntimeStateInMemoryAdapter,
  RuntimeStateSelectorInput,
  RuntimeStateSnapshotOperations,
} from "@/lib/runtime-state/adapters";

export { createCloudflareRuntimeStateAdapter } from "@/lib/runtime-state/cloudflare-adapter";
export {
  inMemoryRuntimeStateAdapter,
  resetInMemoryRuntimeStateAdapterState,
} from "@/lib/runtime-state/in-memory-adapter";
export {
  createRuntimeStateTelemetryEvent,
  emitRuntimeStateTelemetry,
  runtimeStateTelemetryEventName,
} from "@/lib/runtime-state/telemetry";
export type {
  RuntimeStateTelemetryEvent,
  RuntimeStateTelemetryInput,
  RuntimeStateTelemetryOutcome,
} from "@/lib/runtime-state/telemetry";
export {
  getRuntimeStateAdapter,
  hasCloudflareRuntimeStateBindings,
  selectRuntimeStateAdapterKind,
} from "@/lib/runtime-state/provider-selector";
