import { beforeEach, describe, expect, it, vi } from "vitest";
import { DescribeInstancesCommand, StartInstancesCommand } from "./clients.js";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("./clients.js", async () => {
  const actual = await vi.importActual<typeof import("./clients.js")>("./clients.js");
  return { ...actual, ec2: { send: mocks.send } };
});

vi.mock("./runtime-budgets.js", () => ({
  INSTANCE_STATE_MAX_ATTEMPTS: 3,
  INSTANCE_STATE_POLL_INTERVAL_MS: 0,
  PUBLIC_IP_MAX_ATTEMPTS: 3,
  PUBLIC_IP_POLL_INTERVAL_MS: 0,
}));

import { ensureInstanceRunning } from "./ec2.js";

describe("Lambda EC2 lifecycle recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for an initially stopping instance, then starts it after it reaches stopped", async () => {
    const states = ["stopping", "stopped", "running"];
    mocks.send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeInstancesCommand) {
        return { Reservations: [{ Instances: [{ State: { Name: states.shift() } }] }] };
      }
      return {};
    });

    await expect(ensureInstanceRunning("i-managed")).resolves.toBeUndefined();

    const startCommands = mocks.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof StartInstancesCommand);
    expect(startCommands).toHaveLength(1);
    expect(startCommands[0].input.InstanceIds).toEqual(["i-managed"]);
    const startOrder = mocks.send.mock.invocationCallOrder.find(
      (_, index) => mocks.send.mock.calls[index][0] instanceof StartInstancesCommand
    )!;
    const describeOrders = mocks.send.mock.invocationCallOrder.filter(
      (_, index) => mocks.send.mock.calls[index][0] instanceof DescribeInstancesCommand
    );
    expect(describeOrders[1]).toBeLessThan(startOrder);
  });
});
