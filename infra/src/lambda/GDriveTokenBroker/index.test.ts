import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-ssm", () => ({
  GetParameterCommand: class GetParameterCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  PutParameterCommand: class PutParameterCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SSMClient: class SSMClient {
    send = mocks.send;
  },
}));

import { handler } from "./index.js";

describe("GDrive token broker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads only the fixed SecureString and returns sanitized status", async () => {
    mocks.send.mockResolvedValueOnce({ Parameter: { Type: "SecureString", Value: "ciphertext" } });

    await expect(handler({ operation: "get" })).resolves.toEqual({ configured: true });
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      Name: "/minecraft/gdrive-token",
      WithDecryption: false,
    });
  });

  it("reports a missing token without exposing SSM errors", async () => {
    const error = new Error("not found");
    error.name = "ParameterNotFound";
    mocks.send.mockRejectedValueOnce(error);

    await expect(handler({ operation: "get" })).resolves.toEqual({ configured: false });
  });

  it("writes only the fixed SecureString and never returns its value", async () => {
    mocks.send.mockResolvedValueOnce({ Version: 4 });

    await expect(handler({ operation: "put", value: "credential-envelope" })).resolves.toEqual({ configured: true });
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      Name: "/minecraft/gdrive-token",
      Type: "SecureString",
      Value: "credential-envelope",
      Overwrite: true,
    });
  });

  it("rejects parameter names, operations, and oversized values supplied by callers", async () => {
    await expect(handler({ operation: "get", name: "/minecraft/other-secret" })).rejects.toThrow(
      "GDRIVE_BROKER_REQUEST_INVALID"
    );
    await expect(handler({ operation: "delete" })).rejects.toThrow("GDRIVE_BROKER_REQUEST_INVALID");
    await expect(handler({ operation: "put", value: "x".repeat(4097) })).rejects.toThrow(
      "GDRIVE_BROKER_REQUEST_INVALID"
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
