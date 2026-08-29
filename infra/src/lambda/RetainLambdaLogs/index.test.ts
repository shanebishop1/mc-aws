import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    send = send;
  },
  DescribeLogGroupsCommand: class {
    input;
    constructor(input) {
      this.input = input;
    }
  },
  PutRetentionPolicyCommand: class {
    input;
    constructor(input) {
      this.input = input;
    }
  },
}));

import { handler } from "./index.js";

describe("existing Lambda log retention migration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates only exact listed existing groups to 30 days", async () => {
    const providerGroup = "/aws/lambda/MinecraftStack-SeedEmailAllowlistProvider-framework";
    send
      .mockResolvedValueOnce({
        logGroups: [
          { logGroupName: "/aws/lambda/MinecraftStack-owned" },
          { logGroupName: "/aws/lambda/MinecraftStack-owned-unrelated-suffix" },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ logGroups: [{ logGroupName: providerGroup }] })
      .mockResolvedValueOnce({});
    await handler({
      RequestType: "Create",
      StackId: "stack-id",
      ResourceProperties: {
        LogGroupNames: ["/aws/lambda/MinecraftStack-owned", providerGroup],
        RetentionInDays: 30,
      },
    });
    expect(send.mock.calls[1][0].input).toEqual({
      logGroupName: "/aws/lambda/MinecraftStack-owned",
      retentionInDays: 30,
    });
    expect(send.mock.calls[2][0].input).toEqual({ logGroupNamePrefix: providerGroup, limit: 1 });
    expect(send.mock.calls[3][0].input).toEqual({ logGroupName: providerGroup, retentionInDays: 30 });
  });

  it("keeps replacement and delete idempotent without removing log groups", async () => {
    await expect(
      handler({
        RequestType: "Delete",
        StackId: "stack-id",
        PhysicalResourceId: "stable-id",
        OldResourceProperties: { LogGroupNames: ["/aws/lambda/MinecraftStack-owned"] },
      })
    ).resolves.toEqual({ PhysicalResourceId: "stable-id" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects wildcard and duplicate ownership claims", async () => {
    await expect(
      handler({
        RequestType: "Create",
        StackId: "stack-id",
        ResourceProperties: { LogGroupNames: ["/aws/lambda/MinecraftStack-*"], RetentionInDays: 30 },
      })
    ).rejects.toThrow(/Invalid log retention/);
    expect(send).not.toHaveBeenCalled();
  });
});
