"use client";

import { ServerState } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

// How long to show optimistic state before giving up (2 minutes)
const PENDING_ACTION_TIMEOUT_MS = 2 * 60 * 1000;

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
  ip: string | undefined;
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
  const [ip, setIp] = useState<string | undefined>(undefined);
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
        setIp(newState === ServerState.Running ? data.data.publicIp : undefined);
        updatePlayerCount(newState);
      }
    } catch (error) {
      console.error("Failed to fetch status", error);
    } finally {
      setIsInitialLoad(false);
    }
  }, [updatePlayerCount]);

  // Poll status every 5 seconds, only when tab is visible
  useEffect(() => {
    const handleFetchStatus = async () => {
      await fetchStatus();
    };

    handleFetchStatus();

    let intervalId: NodeJS.Timeout | null = null;

    const startPolling = () => {
      if (intervalId === null) {
        intervalId = setInterval(handleFetchStatus, 5000);
      }
    };

    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleFetchStatus(); // Refresh immediately when tab becomes visible
        startPolling();
      } else {
        stopPolling();
      }
    };

    // Start polling initially
    startPolling();

    // Listen for visibility changes
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchStatus]);

  return {
    status,
    ip,
    hasVolume,
    playerCount,
    isInitialLoad,
    fetchStatus,
    setPendingAction,
  };
}
