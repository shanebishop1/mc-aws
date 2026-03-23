import { getRuntimeStateAdapter } from "@/lib/runtime-state";
import { snapshotCacheKeys } from "@/lib/runtime-state/snapshot-cache";

const mockControlSnapshotKeys = [
  snapshotCacheKeys.status,
  snapshotCacheKeys.serviceStatus,
  snapshotCacheKeys.stackStatus,
  snapshotCacheKeys.costs,
  snapshotCacheKeys.emails,
];

export const invalidateMockControlSnapshots = async (): Promise<void> => {
  const runtimeStateAdapter = getRuntimeStateAdapter();

  await Promise.all(
    mockControlSnapshotKeys.map(async (key) => {
      await runtimeStateAdapter.invalidateSnapshot({ key });
    })
  );
};
