import { inMemoryRuntimeStateAdapter } from "@/lib/runtime-state/in-memory-adapter";
import { advanceFrozenTimeBy, freezeTime, restoreTime } from "@/tests/fixtures";
import { afterEach, describe, expect, it } from "vitest";

describe("in-memory runtime-state adapter", () => {
  afterEach(() => {
    restoreTime();
  });

  describe("strict counter correctness", () => {
    it("keeps authoritative counter progression inside a window", async () => {
      freezeTime("2026-01-02T03:04:05.000Z");

      const key = "counter:strict-window";
      const limit = 3;
      const windowMs = 60_000;

      const firstIncrement = await inMemoryRuntimeStateAdapter.incrementCounter({
        key,
        limit,
        windowMs,
      });
      const checkAfterFirst = await inMemoryRuntimeStateAdapter.checkCounter({
        key,
        limit,
        windowMs,
      });
      const boundaryIncrement = await inMemoryRuntimeStateAdapter.incrementCounter({
        key,
        limit,
        windowMs,
        incrementBy: 2,
      });
      const overflowIncrement = await inMemoryRuntimeStateAdapter.incrementCounter({
        key,
        limit,
        windowMs,
      });

      expect(firstIncrement).toMatchObject({
        ok: true,
        data: {
          allowed: true,
          count: 1,
          remaining: 2,
          retryAfterSeconds: 0,
        },
      });
      expect(checkAfterFirst).toMatchObject({
        ok: true,
        data: {
          allowed: true,
          count: 1,
          remaining: 2,
          retryAfterSeconds: 0,
        },
      });
      expect(boundaryIncrement).toMatchObject({
        ok: true,
        data: {
          allowed: true,
          count: 3,
          remaining: 0,
          retryAfterSeconds: 0,
        },
      });
      expect(overflowIncrement).toMatchObject({
        ok: true,
        data: {
          allowed: false,
          count: 4,
          remaining: 0,
          retryAfterSeconds: 60,
        },
      });
    });

    it("resets counter state after the window elapses", async () => {
      freezeTime("2026-01-02T03:04:05.000Z");

      const key = "counter:strict-reset";
      const limit = 1;
      const windowMs = 1_000;

      const firstIncrement = await inMemoryRuntimeStateAdapter.incrementCounter({
        key,
        limit,
        windowMs,
      });
      const overflowIncrement = await inMemoryRuntimeStateAdapter.incrementCounter({
        key,
        limit,
        windowMs,
      });

      advanceFrozenTimeBy(windowMs + 1);

      const resetIncrement = await inMemoryRuntimeStateAdapter.incrementCounter({
        key,
        limit,
        windowMs,
      });

      expect(firstIncrement).toMatchObject({ ok: true, data: { allowed: true, count: 1 } });
      expect(overflowIncrement).toMatchObject({ ok: true, data: { allowed: false, count: 2, retryAfterSeconds: 1 } });
      expect(resetIncrement).toMatchObject({
        ok: true,
        data: {
          allowed: true,
          count: 1,
          remaining: 0,
          retryAfterSeconds: 0,
        },
      });
    });
  });

  describe("staleness-tolerant snapshot semantics", () => {
    it("serves cached snapshots within ttl and expires them after ttl", async () => {
      freezeTime("2026-01-02T03:04:05.000Z");

      const key = "snapshot:bounded-staleness";
      const ttlSeconds = 5;
      const ttlMs = ttlSeconds * 1000;
      const snapshotValue = {
        generatedAt: "2026-01-02T03:04:05.000Z",
        status: "CREATE_COMPLETE",
      };

      const writeResult = await inMemoryRuntimeStateAdapter.setSnapshot({
        key,
        value: snapshotValue,
        ttlSeconds,
      });

      advanceFrozenTimeBy(ttlMs - 1);
      const staleButAllowedRead = await inMemoryRuntimeStateAdapter.getSnapshot<typeof snapshotValue>({ key });

      advanceFrozenTimeBy(1);
      const expiredRead = await inMemoryRuntimeStateAdapter.getSnapshot<typeof snapshotValue>({ key });

      expect(writeResult).toMatchObject({
        ok: true,
        data: {
          key,
          expiresAt: "2026-01-02T03:04:10.000Z",
        },
      });
      expect(staleButAllowedRead).toMatchObject({
        ok: true,
        data: {
          status: "hit",
          value: snapshotValue,
        },
      });
      expect(expiredRead).toEqual({
        ok: true,
        data: {
          status: "miss",
        },
      });
    });
  });
});
