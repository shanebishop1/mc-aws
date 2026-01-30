import { getEmailAllowlist } from "./aws/ssm-client";

interface CacheEntry {
  data: string[];
  timestamp: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the email allowlist from cache or fetch from SSM.
 * Defaults to empty list on error to fail closed.
 */
export async function getCachedAllowlist(): Promise<string[]> {
  const now = Date.now();

  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  try {
    console.log("[Allowlist] Cache miss, fetching from SSM...");
    const emails = await getEmailAllowlist();
    cache = {
      data: emails,
      timestamp: now,
    };
    return emails;
  } catch (error) {
    console.error("[Allowlist] Failed to fetch allowlist from SSM:", error);
    // Fail closed: return empty list (or fall back to stale cache if critical?)
    // Decision: Return empty list to prevent unauthorized access if we can't verify source of truth.
    return [];
  }
}

/**
 * Force refresh the cache (useful after admin updates)
 */
export function invalidateAllowlistCache() {
  cache = null;
}
