"use client";

import type { CostData, CostsResponse } from "@/lib/types";
import { useCallback, useState } from "react";

interface UseCostDataReturn {
  costData: CostData | null;
  cachedAt: number | null;
  isLoading: boolean;
  error: string | null;
  isStale: boolean;
  setError: (error: string | null) => void;
  fetchCosts: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useCostData(): UseCostDataReturn {
  const [costData, setCostData] = useState<CostData | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStale = cachedAt ? Date.now() - cachedAt > 86400000 : false; // 1 day

  const fetchCosts = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/costs");
      const data: CostsResponse = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch cost data");
      }

      if (data.data) {
        setCostData(data.data);
        setCachedAt(data.data.cachedAt || Date.now());
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch cost data";
      setError(errorMessage);
      console.error("Failed to fetch costs:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/costs?refresh=true");
      const data: CostsResponse = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to refresh cost data");
      }

      if (data.data) {
        setCostData(data.data);
        setCachedAt(data.data.cachedAt || Date.now());
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to refresh cost data";
      setError(errorMessage);
      console.error("Failed to refresh costs:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    costData,
    cachedAt,
    isLoading,
    error,
    isStale,
    setError,
    fetchCosts,
    refresh,
  };
}
