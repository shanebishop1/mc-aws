"use client";

import { ServerState } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseServerStatusReturn {
  status: ServerState;
  ip: string | undefined;
  hasVolume: boolean;
  playerCount: number | undefined;
  isInitialLoad: boolean;
  fetchStatus: () => Promise<void>;
  setStatus: (status: ServerState) => void;
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
  const [status, setStatus] = useState<ServerState>(ServerState.Unknown);
  const [hasVolume, setHasVolume] = useState<boolean>(false);
  const [ip, setIp] = useState<string | undefined>(undefined);
  const [playerCount, setPlayerCount] = useState<number | undefined>(undefined);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const prevStatusRef = useRef<ServerState>(ServerState.Unknown);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        const newState = data.data.state;
        setStatus(newState);
        setHasVolume(data.data.hasVolume ?? false);
        // Only update IP if running
        setIp(newState === ServerState.Running ? data.data.publicIp : undefined);

        // Only fetch player count when state changes to running (or on initial load)
        const justBecameRunning = newState === ServerState.Running && prevStatusRef.current !== ServerState.Running;
        if (justBecameRunning) {
          fetchPlayerCount(setPlayerCount);
        } else if (newState !== ServerState.Running) {
          setPlayerCount(undefined);
        }
        prevStatusRef.current = newState;
      }
    } catch (error) {
      console.error("Failed to fetch status", error);
    } finally {
      setIsInitialLoad(false);
    }
  }, []);

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
    setStatus,
  };
}
