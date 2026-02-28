"use client";

import { usePageFocus } from "@/hooks/usePageFocus";
import { fetchPlayers, fetchStatus, queryKeys } from "@/lib/client-api";
import { ServerState } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

const PENDING_ACTION_TIMEOUT_MS = 2 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 5000;
const USER_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVITY_DEBOUNCE_MS = 1000;

const ACTION_TARGET_STATES: Record<string, ServerState[]> = {
  start: [ServerState.Running],
  resume: [ServerState.Running],
  stop: [ServerState.Stopped],
  hibernate: [ServerState.Hibernating],
};

const ACTION_DISPLAY_STATES: Record<string, ServerState> = {
  start: ServerState.Pending,
  resume: ServerState.Pending,
  stop: ServerState.Stopping,
  hibernate: ServerState.Stopping,
};

interface PendingAction {
  action: string;
  timestamp: number;
}

interface UseServerStatusReturn {
  status: ServerState;
  domain: string | undefined;
  hasVolume: boolean;
  playerCount: number | undefined;
  isInitialLoad: boolean;
  fetchStatus: () => Promise<void>;
  setPendingAction: (action: string | null) => void;
}

export function useServerStatus(): UseServerStatusReturn {
  const isPageFocused = usePageFocus();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingActionState] = useState<PendingAction | null>(null);
  const [isUserIdle, setIsUserIdle] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const prevStatusRef = useRef<ServerState>(ServerState.Unknown);

  const statusQuery = useQuery({
    queryKey: queryKeys.status,
    queryFn: fetchStatus,
    enabled: isPageFocused && !isUserIdle,
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const playerCountQuery = useQuery({
    queryKey: queryKeys.players,
    queryFn: fetchPlayers,
    enabled: false,
  });

  const refetchStatus = statusQuery.refetch;
  const refetchPlayerCount = playerCountQuery.refetch;

  const actualStatus = statusQuery.data?.data?.state ?? ServerState.Unknown;
  const hasVolume = statusQuery.data?.data?.hasVolume ?? false;
  const domain = actualStatus === ServerState.Running ? statusQuery.data?.data?.domain : undefined;

  useEffect(() => {
    if (statusQuery.data || statusQuery.error) {
      setHasLoadedOnce(true);
    }
  }, [statusQuery.data, statusQuery.error]);

  useEffect(() => {
    const justBecameRunning = actualStatus === ServerState.Running && prevStatusRef.current !== ServerState.Running;

    if (justBecameRunning) {
      void refetchPlayerCount();
    }

    if (actualStatus !== ServerState.Running) {
      void queryClient.cancelQueries({ queryKey: queryKeys.players });
    }

    prevStatusRef.current = actualStatus;
  }, [actualStatus, queryClient, refetchPlayerCount]);

  const setPendingAction = useCallback((action: string | null) => {
    if (action) {
      setPendingActionState({ action, timestamp: Date.now() });
      return;
    }

    setPendingActionState(null);
  }, []);

  useEffect(() => {
    if (!pendingAction) return;

    const targetStates = ACTION_TARGET_STATES[pendingAction.action];
    if (targetStates?.includes(actualStatus)) {
      setPendingActionState(null);
    }
  }, [actualStatus, pendingAction]);

  useEffect(() => {
    let inactivityTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastActivityAt = 0;

    const clearInactivityTimeout = () => {
      if (inactivityTimeoutId !== null) {
        clearTimeout(inactivityTimeoutId);
        inactivityTimeoutId = null;
      }
    };

    const scheduleInactivityTimeout = () => {
      clearInactivityTimeout();
      inactivityTimeoutId = setTimeout(() => {
        setIsUserIdle(true);
      }, USER_INACTIVITY_TIMEOUT_MS);
    };

    const handleUserActivity = () => {
      const now = Date.now();
      if (!isUserIdle && now - lastActivityAt < ACTIVITY_DEBOUNCE_MS) {
        return;
      }

      lastActivityAt = now;
      setIsUserIdle(false);
      scheduleInactivityTimeout();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleUserActivity();
        void refetchStatus();
      }
    };

    const handleWindowFocus = () => {
      handleUserActivity();
      void refetchStatus();
    };

    const activityEvents: Array<keyof DocumentEventMap> = [
      "pointerdown",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart",
    ];

    lastActivityAt = Date.now();
    scheduleInactivityTimeout();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    for (const eventName of activityEvents) {
      document.addEventListener(eventName, handleUserActivity);
    }

    return () => {
      clearInactivityTimeout();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      for (const eventName of activityEvents) {
        document.removeEventListener(eventName, handleUserActivity);
      }
    };
  }, [isUserIdle, refetchStatus]);

  const status = (() => {
    if (!pendingAction) return actualStatus;

    const { action, timestamp } = pendingAction;
    const elapsed = Date.now() - timestamp;

    if (elapsed > PENDING_ACTION_TIMEOUT_MS) return actualStatus;

    const targetStates = ACTION_TARGET_STATES[action];
    if (targetStates?.includes(actualStatus)) return actualStatus;

    return ACTION_DISPLAY_STATES[action] ?? actualStatus;
  })();

  const fetchStatusNow = useCallback(async () => {
    const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    if (document.visibilityState !== "visible" || !hasFocus) {
      return;
    }

    await refetchStatus();
  }, [refetchStatus]);

  return {
    status,
    domain,
    hasVolume,
    playerCount: actualStatus === ServerState.Running ? playerCountQuery.data?.data?.count : undefined,
    isInitialLoad: !hasLoadedOnce,
    fetchStatus: fetchStatusNow,
    setPendingAction,
  };
}
