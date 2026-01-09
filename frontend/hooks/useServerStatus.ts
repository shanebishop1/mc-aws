"use client";

import { useCallback, useEffect, useState } from "react";
import type { ServerState } from "@/lib/types";

interface UseServerStatusReturn {
  status: ServerState;
  ip: string | undefined;
  hasVolume: boolean;
  playerCount: number | undefined;
  isInitialLoad: boolean;
  fetchStatus: () => Promise<void>;
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
  const [status, setStatus] = useState<ServerState>("unknown");
  const [hasVolume, setHasVolume] = useState<boolean>(false);
  const [ip, setIp] = useState<string | undefined>(undefined);
  const [playerCount, setPlayerCount] = useState<number | undefined>(undefined);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data.data.state);
        setHasVolume(data.data.hasVolume ?? false);
        // Only update IP if running
        setIp(data.data.state === "running" ? data.data.publicIp : undefined);

        // Fetch player count if server is running
        if (data.data.state === "running") {
          await fetchPlayerCount(setPlayerCount);
        } else {
          setPlayerCount(undefined);
        }
      }
    } catch (error) {
      console.error("Failed to fetch status", error);
    } finally {
      setIsInitialLoad(false);
    }
  }, []);

  // Poll status every 5 seconds
  useEffect(() => {
    const handleFetchStatus = async () => {
      await fetchStatus();
    };
    handleFetchStatus();
    const interval = setInterval(handleFetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return {
    status,
    ip,
    hasVolume,
    playerCount,
    isInitialLoad,
    fetchStatus,
  };
}
