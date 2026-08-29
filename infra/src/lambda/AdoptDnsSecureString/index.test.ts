import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = send;
  },
  GetParameterCommand: class {
    input;
    constructor(input) {
      this.input = input;
    }
  },
}));

import { handler } from "./index.js";

describe("DNS SecureString adoption custom resource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("verifies type without decrypting or receiving a secret value", async () => {
    send.mockResolvedValue({ Parameter: { Type: "SecureString" } });
    const event = {
      RequestType: "Update",
      PhysicalResourceId: "old-physical-id",
      ResourceProperties: { ParameterName: "/minecraft/cloudflare-api-token" },
    };
    await expect(handler(event)).resolves.toEqual({ PhysicalResourceId: "old-physical-id" });
    expect(send.mock.calls[0][0].input).toEqual({
      Name: "/minecraft/cloudflare-api-token",
      WithDecryption: false,
    });
  });

  it("makes replacement/delete a non-destructive no-op", async () => {
    await expect(
      handler({
        RequestType: "Delete",
        PhysicalResourceId: "old-physical-id",
        OldResourceProperties: { ParameterName: "/minecraft/cloudflare-api-token" },
      })
    ).resolves.toEqual({ PhysicalResourceId: "old-physical-id" });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a fixed CloudFormation response without reflecting legacy secret properties", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    send.mockResolvedValue({ Parameter: { Type: "SecureString" } });
    const secretSentinel = "legacy-plaintext-token-sentinel";
    await handler(
      {
        RequestType: "Update",
        ResponseURL: "https://cloudformation-response.example.invalid",
        StackId: "stack-id",
        RequestId: "request-id",
        LogicalResourceId: "CloudflareTokenSecureParam",
        PhysicalResourceId: "old-physical-id",
        ResourceProperties: { ParameterName: "/minecraft/cloudflare-api-token" },
        OldResourceProperties: { Value: secretSentinel },
      },
      { logStreamName: "stream" }
    );
    const responseBody = fetchMock.mock.calls[0][1].body;
    expect(responseBody).not.toContain(secretSentinel);
    expect(JSON.parse(responseBody)).toMatchObject({ Status: "SUCCESS", NoEcho: true });
    vi.unstubAllGlobals();
  });
});
