"use client";

import type { CostData, CostsResponse } from "@/lib/types";
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
    // localStorage full or unavailable - ignore
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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const cached = loadFromStorage();
    if (cached) {
      setCostData(cached.data);
      setCachedAt(cached.cachedAt);
    }
  }, []);

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
        const timestamp = data.data.cachedAt || Date.now();
        setCostData(data.data);
        setCachedAt(timestamp);
        saveToStorage(data.data, timestamp);
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
        const timestamp = data.data.cachedAt || Date.now();
        setCostData(data.data);
        setCachedAt(timestamp);
        saveToStorage(data.data, timestamp);
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
