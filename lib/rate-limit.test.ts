import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitRuntimeStateTelemetryMock, getRuntimeStateAdapterMock, incrementCounterMock } = vi.hoisted(() => {
  return {
    emitRuntimeStateTelemetryMock: vi.fn(),
    getRuntimeStateAdapterMock: vi.fn(),
    incrementCounterMock: vi.fn(),
  };
});

vi.mock("@/lib/runtime-state", () => {
  return {
    emitRuntimeStateTelemetry: emitRuntimeStateTelemetryMock,
    getRuntimeStateAdapter: getRuntimeStateAdapterMock,
  };
});

describe("rate-limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getRuntimeStateAdapterMock.mockReturnValue({
      incrementCounter: incrementCounterMock,
    });
  });

  describe("checkRateLimit", () => {
    it("uses runtime-state adapter incrementCounter", async () => {
      incrementCounterMock.mockResolvedValueOnce({
        ok: true,
        data: {
          allowed: true,
          count: 1,
          remaining: 5,
          retryAfterSeconds: 0,
          windowStartedAtMs: 123,
        },
      });

      const result = await checkRateLimit({
        route: "/api/status",
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });

      expect(incrementCounterMock).toHaveBeenCalledWith({
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });
      expect(result).toEqual({
        allowed: true,
        remaining: 5,
        retryAfterSeconds: 0,
      });
    });

    it("returns throttle result from runtime-state adapter", async () => {
      incrementCounterMock.mockResolvedValueOnce({
        ok: true,
        data: {
          allowed: false,
          count: 7,
          remaining: 0,
          retryAfterSeconds: 34,
          windowStartedAtMs: 123,
        },
      });

      const result = await checkRateLimit({
        route: "/api/status",
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });

      expect(result).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 34,
      });
      expect(emitRuntimeStateTelemetryMock).toHaveBeenCalledWith({
        operation: "rate-limit.increment-counter",
        outcome: "THROTTLE",
        source: "route",
        route: "/api/status",
        key: "status:127.0.0.1",
        retryAfterSeconds: 34,
        reason: "rate_limit_exceeded",
      });
    });

    it("normalizes throttled contract fields for caller compatibility", async () => {
      incrementCounterMock.mockResolvedValueOnce({
        ok: true,
        data: {
          allowed: false,
          count: 7,
          remaining: 4,
          retryAfterSeconds: 0,
          windowStartedAtMs: 123,
        },
      });

      const result = await checkRateLimit({
        route: "/api/status",
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });

      expect(result).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 1,
      });
    });

    it("fails open when runtime-state adapter returns a retryable backend error", async () => {
      incrementCounterMock.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "counter_unavailable",
          message: "Backend unavailable",
          retryable: true,
        },
      });

      const result = await checkRateLimit({
        route: "/api/status",
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });

      expect(result).toEqual({
        allowed: true,
        remaining: 5,
        retryAfterSeconds: 0,
      });
      expect(emitRuntimeStateTelemetryMock).toHaveBeenCalledWith({
        operation: "rate-limit.increment-counter",
        outcome: "FALLBACK",
        source: "route",
        route: "/api/status",
        key: "status:127.0.0.1",
        reason: "counter_backend_retryable_error:counter_unavailable",
      });
    });

    it("fails closed when runtime-state adapter returns a non-retryable backend error", async () => {
      incrementCounterMock.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "counter_invalid_input",
          message: "Invalid input",
          retryable: false,
        },
      });

      const result = await checkRateLimit({
        route: "/api/status",
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });

      expect(result).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 1,
      });
      expect(emitRuntimeStateTelemetryMock).toHaveBeenCalledWith({
        operation: "rate-limit.increment-counter",
        outcome: "THROTTLE",
        source: "route",
        route: "/api/status",
        key: "status:127.0.0.1",
        retryAfterSeconds: 1,
        reason: "counter_backend_non_retryable_error:counter_invalid_input",
      });
    });

    it("fails open when runtime-state adapter throws", async () => {
      incrementCounterMock.mockRejectedValueOnce(new Error("boom"));

      const result = await checkRateLimit({
        route: "/api/status",
        key: "status:127.0.0.1",
        limit: 6,
        windowMs: 60_000,
      });

      expect(result).toEqual({
        allowed: true,
        remaining: 5,
        retryAfterSeconds: 0,
      });
      expect(emitRuntimeStateTelemetryMock).toHaveBeenCalledWith({
        operation: "rate-limit.increment-counter",
        outcome: "FALLBACK",
        source: "route",
        route: "/api/status",
        key: "status:127.0.0.1",
        reason: "counter_backend_exception",
      });
    });
  });

  describe("getClientIp", () => {
    it("prefers cf-connecting-ip", () => {
      const headers = new Headers({
        "cf-connecting-ip": "198.51.100.7",
        "x-forwarded-for": "203.0.113.1",
      });

      expect(getClientIp(headers)).toBe("198.51.100.7");
    });

    it("falls back to first x-forwarded-for address", () => {
      const headers = new Headers({
        "x-forwarded-for": "203.0.113.1, 203.0.113.2",
      });

      expect(getClientIp(headers)).toBe("203.0.113.1");
    });

    it("returns unknown when no supported headers are present", () => {
      expect(getClientIp(new Headers())).toBe("unknown");
    });
  });
});
