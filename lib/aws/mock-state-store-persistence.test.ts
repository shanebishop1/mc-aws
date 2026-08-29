import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { ServerState } from "@/lib/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockStateStore, getMockStateStore, resetMockStateStore } from "./mock-state-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  resetMockStateStore();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MockStateStore file persistence", () => {
  it("keeps separate route-runtime stores coherent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mc-aws-mock-state-"));
    temporaryDirectories.push(directory);
    const persistencePath = path.join(directory, "state.json");
    const options = { enablePersistence: true, persistencePath };
    const scenarioStore = new MockStateStore(options);
    const routeStore = new MockStateStore(options);

    await scenarioStore.setInstance({ state: ServerState.Running, publicIp: "203.0.113.42" });
    expect((await routeStore.getInstance()).state).toBe("running");

    await routeStore.setParameter("/minecraft/test", "updated");
    expect((await scenarioStore.getInstance()).state).toBe("running");
    expect(await scenarioStore.getParameter("/minecraft/test")).toBe("updated");
  });

  it("serializes truly concurrent stores and preserves monotonic fencing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mc-aws-mock-state-lock-"));
    temporaryDirectories.push(directory);
    const persistencePath = path.join(directory, "state.json");
    const options = { enablePersistence: true, persistencePath };
    const firstStore = new MockStateStore(options);
    const secondStore = new MockStateStore(options);
    const now = Date.now();
    const candidate = (lockId: string) => ({
      lockId,
      action: "backup",
      ownerEmail: "admin@example.com",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    const contenders = await Promise.all([
      firstStore.acquireLifecycleLock(candidate("lock-first"), now),
      secondStore.acquireLifecycleLock(candidate("lock-second"), now),
    ]);
    const winner = contenders.find((result) => result.acquired)?.lock;

    expect(contenders.filter((result) => result.acquired)).toHaveLength(1);
    expect(winner?.fencingToken).toBe(1);
    await expect(
      firstStore.releaseLifecycleLock({ lockId: winner!.lockId, fencingToken: winner!.fencingToken })
    ).resolves.toBe(true);

    const next = await secondStore.acquireLifecycleLock(candidate("lock-next"), now + 1);
    expect(next).toMatchObject({ acquired: true, lock: { fencingToken: 2 } });
    await expect(access(`${persistencePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${persistencePath}.lock.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans owned lock and temporary artifacts when persistence fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mc-aws-mock-state-write-failure-"));
    temporaryDirectories.push(directory);
    const persistencePath = path.join(directory, "state.json");
    const store = new MockStateStore({ enablePersistence: true, persistencePath });

    await expect(
      store.transact(async () => {
        await mkdir(persistencePath);
      })
    ).rejects.toThrow("Failed to persist state");

    expect((await readdir(directory)).filter((entry) => entry.includes(".lock") || entry.endsWith(".tmp"))).toEqual([]);
  });

  it("recovers a stale invalid lock and removes only the recovered artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mc-aws-mock-state-stale-lock-"));
    temporaryDirectories.push(directory);
    const persistencePath = path.join(directory, "state.json");
    const lockPath = `${persistencePath}.lock`;
    await writeFile(lockPath, "incomplete-owner-metadata", "utf-8");
    const staleTime = new Date(Date.now() - 1_000);
    await utimes(lockPath, staleTime, staleTime);
    const store = new MockStateStore({
      enablePersistence: true,
      persistencePath,
      persistenceLockStaleMs: 20,
      persistenceLockTimeoutMs: 500,
    });

    await store.setParameter("/minecraft/recovered", "true");

    expect(await store.getParameter("/minecraft/recovered")).toBe("true");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${lockPath}.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let a stale release unlink a replacement lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mc-aws-mock-state-stale-release-"));
    temporaryDirectories.push(directory);
    const persistencePath = path.join(directory, "state.json");
    const lockPath = `${persistencePath}.lock`;
    const store = new MockStateStore({ enablePersistence: true, persistencePath, persistenceLockTimeoutMs: 100 });
    const lockHandle = await (
      store as unknown as {
        acquirePersistenceLock(): Promise<{ release(): Promise<void> }>;
      }
    ).acquirePersistenceLock();
    const replacement = JSON.stringify({
      ownerToken: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    });
    await writeFile(lockPath, replacement, { encoding: "utf-8", mode: 0o600 });

    await expect(lockHandle.release()).rejects.toThrow("owned by another runtime");

    expect(await readFile(lockPath, "utf-8")).toBe(replacement);
    await rm(lockPath);
    await expect(access(`${lockPath}.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("MockStateStore singleton reset", () => {
  it("cancels pending transitions before replacing the store", async () => {
    vi.useFakeTimers();
    let transitionCompleted = false;
    const store = getMockStateStore();
    store.registerTimeout(
      setTimeout(() => {
        transitionCompleted = true;
      }, 1_000)
    );

    resetMockStateStore();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(transitionCompleted).toBe(false);
  });
});
