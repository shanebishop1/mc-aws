interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const limiterStore = new Map<string, RateLimitEntry>();

function cleanupExpired(nowMs: number, windowMs: number) {
  for (const [key, entry] of limiterStore.entries()) {
    if (nowMs - entry.windowStartMs >= windowMs) {
      limiterStore.delete(key);
    }
  }
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

export function checkRateLimit({ key, limit, windowMs }: RateLimitOptions): RateLimitResult {
  const nowMs = Date.now();

  if (limiterStore.size > 10_000) {
    cleanupExpired(nowMs, windowMs);
  }

  const current = limiterStore.get(key);

  if (!current || nowMs - current.windowStartMs >= windowMs) {
    limiterStore.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });

    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: 0,
    };
  }

  if (current.count >= limit) {
    const retryAfterSeconds = Math.ceil((windowMs - (nowMs - current.windowStartMs)) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  current.count += 1;
  limiterStore.set(key, current);

  return {
    allowed: true,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: 0,
  };
}
