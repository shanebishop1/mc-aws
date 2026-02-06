"use client";

import { ServerState } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

// How long to show optimistic state before giving up (2 minutes)
const PENDING_ACTION_TIMEOUT_MS = 2 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 5000;
const USER_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVITY_DEBOUNCE_MS = 1000;

// Maps pending action to expected final state
const ACTION_TARGET_STATES: Record<string, ServerState[]> = {
  start: [ServerState.Running],
  resume: [ServerState.Running],
  stop: [ServerState.Stopped],
  hibernate: [ServerState.Hibernating],
};

// Maps pending action to display state
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

const fetchPlayerCount = async (setPlayerCount: (count: number | undefined) => void) => {
  try {
    const playerRes = await fetch("/api/players");
    if (playerRes.ok) {
      const playerData = await playerRes.json();
      if (playerData.success && playerData.data) {
        setPlayerCount(playerData.data.count);
      }
    }
  } catch (error) {
    console.error("Failed to fetch player count", error);
  }
};

export function useServerStatus(): UseServerStatusReturn {
  const [actualStatus, setActualStatus] = useState<ServerState>(ServerState.Unknown);
  const [hasVolume, setHasVolume] = useState<boolean>(false);
  const [domain, setDomain] = useState<string | undefined>(undefined);
  const [playerCount, setPlayerCount] = useState<number | undefined>(undefined);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [pendingAction, setPendingActionState] = useState<PendingAction | null>(null);
  const prevStatusRef = useRef<ServerState>(ServerState.Unknown);

  // Set a pending action (called when user clicks start/stop/etc)
  const setPendingAction = useCallback((action: string | null) => {
    if (action) {
      setPendingActionState({ action, timestamp: Date.now() });
    } else {
      setPendingActionState(null);
    }
  }, []);

  // Compute display status: show pending state if action is in progress, otherwise actual
  const status = (() => {
    if (!pendingAction) return actualStatus;

    const { action, timestamp } = pendingAction;
    const elapsed = Date.now() - timestamp;

    // Timeout expired - show actual state
    if (elapsed > PENDING_ACTION_TIMEOUT_MS) return actualStatus;

    // Check if actual state has reached target - if so, clear pending and show actual
    const targetStates = ACTION_TARGET_STATES[action];
    if (targetStates?.includes(actualStatus)) return actualStatus;

    // Still pending - show optimistic state
    return ACTION_DISPLAY_STATES[action] ?? actualStatus;
  })();

  // Clear pending action when target state is reached
  useEffect(() => {
    if (!pendingAction) return;

    const targetStates = ACTION_TARGET_STATES[pendingAction.action];
    if (targetStates?.includes(actualStatus)) {
      setPendingActionState(null);
    }
  }, [actualStatus, pendingAction]);

  // Handle player count updates based on state changes
  const updatePlayerCount = useCallback((newState: ServerState) => {
    const justBecameRunning = newState === ServerState.Running && prevStatusRef.current !== ServerState.Running;
    if (justBecameRunning) {
      fetchPlayerCount(setPlayerCount);
    } else if (newState !== ServerState.Running) {
      setPlayerCount(undefined);
    }
    prevStatusRef.current = newState;
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        const newState = data.data.state;
        setActualStatus(newState);
        setHasVolume(data.data.hasVolume ?? false);
        setDomain(newState === ServerState.Running ? data.data.domain : undefined);
        updatePlayerCount(newState);
      }
    } catch (error) {
      console.error("Failed to fetch status", error);
    } finally {
      setIsInitialLoad(false);
    }
  }, [updatePlayerCount]);

  // Poll status only when user is actively engaged with this page
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let inactivityTimeoutId: NodeJS.Timeout | null = null;
    let isUserIdle = false;
    let lastActivityAt = 0;

    const startPolling = () => {
      if (intervalId === null) {
        intervalId = setInterval(() => {
          void fetchStatus();
        }, STATUS_POLL_INTERVAL_MS);
      }
    };

    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const clearInactivityTimeout = () => {
      if (inactivityTimeoutId !== null) {
        clearTimeout(inactivityTimeoutId);
        inactivityTimeoutId = null;
      }
    };

    const scheduleInactivityTimeout = () => {
      clearInactivityTimeout();
      inactivityTimeoutId = setTimeout(() => {
        isUserIdle = true;
        stopPolling();
      }, USER_INACTIVITY_TIMEOUT_MS);
    };

    const canPoll = () => {
      return document.visibilityState === "visible" && document.hasFocus() && !isUserIdle;
    };

    const handleUserActivity = () => {
      const now = Date.now();
      if (!isUserIdle && now - lastActivityAt < ACTIVITY_DEBOUNCE_MS) {
        return;
      }

      const wasIdle = isUserIdle;
      const wasPolling = intervalId !== null;

      lastActivityAt = now;
      isUserIdle = false;
      scheduleInactivityTimeout();

      if (canPoll() && (wasIdle || !wasPolling)) {
        void fetchStatus();
        startPolling();
        return;
      }

      if (!canPoll()) {
        stopPolling();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleUserActivity();
      } else {
        stopPolling();
      }
    };

    const handleWindowFocus = () => {
      handleUserActivity();
    };

    const handleWindowBlur = () => {
      stopPolling();
    };

    const activityEvents: Array<keyof DocumentEventMap> = [
      "pointerdown",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart",
    ];

    // Initial fetch when page loads
    handleUserActivity();

    // Listen for engagement and focus changes
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    for (const eventName of activityEvents) {
      document.addEventListener(eventName, handleUserActivity);
    }

    return () => {
      stopPolling();
      clearInactivityTimeout();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      for (const eventName of activityEvents) {
        document.removeEventListener(eventName, handleUserActivity);
      }
    };
  }, [fetchStatus]);

  return {
    status,
    domain,
    hasVolume,
    playerCount,
    isInitialLoad,
    fetchStatus,
    setPendingAction,
  };
}
