"use client";

import type { ApiResponse, GDriveStatusResponse } from "@/lib/types";
import { useCallback, useEffect, useState } from "react";

interface UseGDriveStatusReturn {
  isConfigured: boolean;
  isLoading: boolean;
  error: string | undefined;
  refetch: () => Promise<void>;
}

export function useGDriveStatus(): UseGDriveStatusReturn {
  const [isConfigured, setIsConfigured] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);

    try {
      const res = await fetch("/api/gdrive/status");
      if (!res.ok) {
        throw new Error(`Failed to fetch GDrive status: ${res.statusText}`);
      }

      const data: ApiResponse<GDriveStatusResponse> = await res.json();

      if (data.success && data.data) {
        setIsConfigured(data.data.configured);
      } else {
        setError(data.error ?? "Failed to get GDrive status");
      }
    } catch (error) {
      console.error("[GDRIVE_STATUS] Failed to fetch GDrive status:", error);
      setError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    isConfigured,
    isLoading,
    error,
    refetch,
  };
}
