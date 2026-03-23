import { getRuntimeStateAdapter } from "@/lib/runtime-state";
import type { RuntimeStateCounterKey } from "@/lib/runtime-state";

interface RateLimitOptions {
  key: RuntimeStateCounterKey;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function getClientIp(headers: Headers): string {
  const cfConnectingIp = headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const xForwardedFor = headers.get("x-forwarded-for")?.trim();
  if (xForwardedFor) {
    return xForwardedFor.split(",")[0]?.trim() || "unknown";
  }

  const xRealIp = headers.get("x-real-ip")?.trim();
  if (xRealIp) {
    return xRealIp;
  }

  return "unknown";
}

function fallbackRateLimitResult(limit: number): RateLimitResult {
  return {
    allowed: true,
    remaining: Math.max(0, limit - 1),
    retryAfterSeconds: 0,
  };
}

export async function checkRateLimit({ key, limit, windowMs }: RateLimitOptions): Promise<RateLimitResult> {
  try {
    const adapter = getRuntimeStateAdapter();
    const counterResult = await adapter.incrementCounter({
      key,
      limit,
      windowMs,
    });

    if (!counterResult.ok) {
      console.warn("[RATE-LIMIT] Counter backend unavailable, allowing request", {
        code: counterResult.error.code,
        key,
      });
      return fallbackRateLimitResult(limit);
    }

    return {
      allowed: counterResult.data.allowed,
      remaining: counterResult.data.remaining,
      retryAfterSeconds: counterResult.data.retryAfterSeconds,
    };
  } catch (error) {
    console.warn("[RATE-LIMIT] Unexpected counter backend error, allowing request", {
      key,
      error,
    });
    return fallbackRateLimitResult(limit);
  }
}
