import { describe, expect, it } from "vitest";
import { isSSMTerminalFailureStatus } from "./ssm-client";

describe("application SSM command statuses", () => {
  it.each([
    "Cancelled",
    "TimedOut",
    "Cancelling",
    "DeliveryTimedOut",
    "ExecutionTimedOut",
    "Failed",
    "Undeliverable",
    "Terminated",
  ])("treats %s as a terminal failure", (status) => {
    expect(isSSMTerminalFailureStatus(status)).toBe(true);
  });

  it.each(["Pending", "InProgress", "Delayed", "Success"])("does not treat %s as a terminal failure", (status) => {
    expect(isSSMTerminalFailureStatus(status)).toBe(false);
  });
});
