"use client";

import { fetchCosts } from "@/lib/client-api";
import type { CostData } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mc-aws-cost-cache";

interface CachedCostData {
  data: CostData;
  cachedAt: number;
}

function loadFromStorage(): CachedCostData | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as CachedCostData;
  } catch {
    return null;
  }
}

function saveToStorage(data: CostData, cachedAt: number): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, cachedAt }));
  } catch {
    return;
  }
}

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
  const [error, setError] = useState<string | null>(null);

  const fetchCostsMutation = useMutation({
    mutationFn: () => fetchCosts(false),
  });

  const refreshCostsMutation = useMutation({
    mutationFn: () => fetchCosts(true),
  });

  useEffect(() => {
    const cached = loadFromStorage();
    if (cached) {
      setCostData(cached.data);
      setCachedAt(cached.cachedAt);
    }
  }, []);

  const applyCostData = useCallback((data: CostData, timestamp: number) => {
    setCostData(data);
    setCachedAt(timestamp);
    saveToStorage(data, timestamp);
  }, []);

  const fetchCostsNow = useCallback(async () => {
    setError(null);

    try {
      const result = await fetchCostsMutation.mutateAsync();
      if (result.data) {
        const timestamp = result.data.cachedAt || Date.now();
        applyCostData(result.data, timestamp);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch cost data";
      setError(errorMessage);
    }
  }, [applyCostData, fetchCostsMutation]);

  const refresh = useCallback(async () => {
    setError(null);

    try {
      const result = await refreshCostsMutation.mutateAsync();
      if (result.data) {
        const timestamp = result.data.cachedAt || Date.now();
        applyCostData(result.data, timestamp);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to refresh cost data";
      setError(errorMessage);
    }
  }, [applyCostData, refreshCostsMutation]);

  return {
    costData,
    cachedAt,
    isLoading: fetchCostsMutation.isPending || refreshCostsMutation.isPending,
    error,
    isStale: cachedAt ? Date.now() - cachedAt > 86_400_000 : false,
    setError,
    fetchCosts: fetchCostsNow,
    refresh,
  };
}
