"use client";

import type { ApiResponse, StackStatusResponse } from "@/lib/types";
import { useCallback, useEffect, useState } from "react";

interface UseStackStatusReturn {
  stackExists: boolean;
  stackStatus: string | undefined;
  stackId: string | undefined;
  isLoading: boolean;
  error: string | undefined;
  refetch: () => Promise<void>;
}

export function useStackStatus(): UseStackStatusReturn {
  const [stackExists, setStackExists] = useState<boolean>(false);
  const [stackStatus, setStackStatus] = useState<string | undefined>(undefined);
  const [stackId, setStackId] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);

    try {
      const res = await fetch("/api/stack-status");
      if (!res.ok) {
        throw new Error(`Failed to fetch stack status: ${res.statusText}`);
      }

      const data: ApiResponse<StackStatusResponse> = await res.json();

      if (data.success && data.data) {
        setStackExists(data.data.exists);
        setStackStatus(data.data.status);
        setStackId(data.data.stackId);
      } else {
        setError(data.error ?? "Failed to get stack status");
      }
    } catch (error) {
      console.error("[STACK_STATUS] Failed to fetch stack status:", error);
      setError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    stackExists,
    stackStatus,
    stackId,
    isLoading,
    error,
    refetch,
  };
}
