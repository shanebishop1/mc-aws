import type { ServerState } from "@/lib/types";

interface ButtonVisibilityState {
  isHibernated: boolean;
  isStopped: boolean;
  isRunning: boolean;
  isTransitioning: boolean;
  showResume: boolean;
  showStart: boolean;
  showStop: boolean;
  showHibernate: boolean;
  showBackupRestore: boolean;
  actionsEnabled: boolean;
}

export function useButtonVisibility(status: ServerState, hasVolume?: boolean): ButtonVisibilityState {
  const isHibernated = status === "hibernated" || (status === "stopped" && !hasVolume);
  const isStopped = status === "stopped" && !!hasVolume;
  const isRunning = status === "running";
  const isTransitioning = status === "pending" || status === "stopping";

  const showResume = isHibernated;
  const showStart = isStopped || isTransitioning;
  const showStop = isRunning;
  const showHibernate = (isRunning || isStopped) && !isHibernated;
  const showBackupRestore = isRunning;

  const actionsEnabled = !isTransitioning;

  return {
    isHibernated,
    isStopped,
    isRunning,
    isTransitioning,
    showResume,
    showStart,
    showStop,
    showHibernate,
    showBackupRestore,
    actionsEnabled,
  };
}
