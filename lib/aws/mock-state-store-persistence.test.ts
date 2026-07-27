import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
