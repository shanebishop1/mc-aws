import { mockProvider } from "@/lib/aws/mock-provider";
import { getMockStateStore, resetMockStateStore } from "@/lib/aws/mock-state-store";
import { ServerState } from "@/lib/types";
import { describe, expect, test } from "vitest";

describe("mockProvider.executeSSMCommand", () => {
  test("returns active for systemctl status when instance is running", async () => {
    resetMockStateStore();
    const stateStore = getMockStateStore();
    await stateStore.setInstance({
      state: ServerState.Running,
      instanceId: "i-mock1234567890abcdef",
    });

    const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", ["systemctl is-active minecraft"]);

    expect(output).toBe("active");
  });

  test("returns inactive for systemctl status when instance is not running", async () => {
    resetMockStateStore();
    const stateStore = getMockStateStore();
    await stateStore.setInstance({
      state: ServerState.Stopped,
      instanceId: "i-mock1234567890abcdef",
    });

    const output = await mockProvider.executeSSMCommand("i-mock1234567890abcdef", ["systemctl is-active minecraft"]);

    expect(output).toBe("inactive");
  });
});
