import { ServerState } from "@/lib/types";

interface ButtonVisibilityState {
  isHibernating: boolean;
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
  const isHibernating = status === ServerState.Hibernating || (status === ServerState.Stopped && !hasVolume);
  const isStopped = status === ServerState.Stopped && !!hasVolume;
  const isRunning = status === ServerState.Running;
  const isTransitioning = status === ServerState.Pending || status === ServerState.Stopping;

  const showResume = isHibernating;
  const showStart = isStopped || isTransitioning;
  const showStop = isRunning;
  const showHibernate = (isRunning || isStopped) && !isHibernating;
  const showBackupRestore = isRunning;

  const actionsEnabled = !isTransitioning;

  return {
    isHibernating,
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
