import { emitRuntimeStateTelemetry, getRuntimeStateAdapter } from "@/lib/runtime-state";
import type { RuntimeStateCounterKey } from "@/lib/runtime-state";

interface RateLimitOptions {
  route: string;
  key: RuntimeStateCounterKey;
  limit: number;
  windowMs: number;
  failureMode?: "open" | "closed";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function getClientIp(headers: Headers): string {
  const isProduction = process.env.NODE_ENV === "production";
  const cfConnectingIp = headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  if (isProduction) {
    return "unknown";
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

function failClosedRateLimitResult(): RateLimitResult {
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 1,
  };
}

function normalizeRateLimitResult(result: RateLimitResult): RateLimitResult {
  if (result.allowed) {
    return {
      allowed: true,
      remaining: Math.max(0, result.remaining),
      retryAfterSeconds: 0,
    };
  }

  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, result.retryAfterSeconds),
  };
}

export async function checkRateLimit({
  route,
  key,
  limit,
  windowMs,
  failureMode = "open",
}: RateLimitOptions): Promise<RateLimitResult> {
  const failClosed = failureMode === "closed";

  try {
    const adapter = getRuntimeStateAdapter();
    const counterResult = await adapter.incrementCounter({
      key,
      limit,
      windowMs,
    });

    if (!counterResult.ok) {
      if (counterResult.error.retryable) {
        if (failClosed) {
          emitRuntimeStateTelemetry({
            operation: "rate-limit.increment-counter",
            outcome: "THROTTLE",
            source: "route",
            route,
            key,
            retryAfterSeconds: 1,
            reason: `counter_backend_retryable_error:${counterResult.error.code}`,
          });

          console.warn("[RATE-LIMIT] Retryable counter backend error, denying request", {
            route,
            code: counterResult.error.code,
            retryable: counterResult.error.retryable,
            key,
          });
          return failClosedRateLimitResult();
        }

        emitRuntimeStateTelemetry({
          operation: "rate-limit.increment-counter",
          outcome: "FALLBACK",
          source: "route",
          route,
          key,
          reason: `counter_backend_retryable_error:${counterResult.error.code}`,
        });

        console.warn("[RATE-LIMIT] Retryable counter backend error, allowing request", {
          route,
          code: counterResult.error.code,
          retryable: counterResult.error.retryable,
          key,
        });
        return fallbackRateLimitResult(limit);
      }

      emitRuntimeStateTelemetry({
        operation: "rate-limit.increment-counter",
        outcome: "THROTTLE",
        source: "route",
        route,
        key,
        retryAfterSeconds: 1,
        reason: `counter_backend_non_retryable_error:${counterResult.error.code}`,
      });

      console.warn("[RATE-LIMIT] Non-retryable counter backend error, denying request", {
        route,
        code: counterResult.error.code,
        retryable: counterResult.error.retryable,
        key,
      });
      return failClosedRateLimitResult();
    }

    const normalizedResult = normalizeRateLimitResult({
      allowed: counterResult.data.allowed,
      remaining: counterResult.data.remaining,
      retryAfterSeconds: counterResult.data.retryAfterSeconds,
    });

    if (!normalizedResult.allowed) {
      emitRuntimeStateTelemetry({
        operation: "rate-limit.increment-counter",
        outcome: "THROTTLE",
        source: "route",
        route,
        key,
        retryAfterSeconds: normalizedResult.retryAfterSeconds,
        reason: "rate_limit_exceeded",
      });
    }

    return normalizedResult;
  } catch (error) {
    if (failClosed) {
      emitRuntimeStateTelemetry({
        operation: "rate-limit.increment-counter",
        outcome: "THROTTLE",
        source: "route",
        route,
        key,
        retryAfterSeconds: 1,
        reason: "counter_backend_exception",
      });

      console.warn("[RATE-LIMIT] Unexpected counter backend error, denying request", {
        route,
        key,
        error,
      });
      return failClosedRateLimitResult();
    }

    emitRuntimeStateTelemetry({
      operation: "rate-limit.increment-counter",
      outcome: "FALLBACK",
      source: "route",
      route,
      key,
      reason: "counter_backend_exception",
    });

    console.warn("[RATE-LIMIT] Unexpected counter backend error, allowing request", {
      route,
      key,
      error,
    });
    return fallbackRateLimitResult(limit);
  }
}
