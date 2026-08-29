import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), getStackOutputValue: vi.fn() }));

vi.mock("@aws-sdk/client-lambda", () => ({
  InvokeCommand: class InvokeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  LambdaClient: class LambdaClient {
    send = mocks.send;
  },
}));
vi.mock("./cloudformation-client", () => ({ getStackOutputValue: mocks.getStackOutputValue }));

import { invokeLambda } from "./lambda-client";

describe("Lambda invocation dispatch classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStackOutputValue.mockResolvedValue("resolved-lifecycle-lambda");
  });

  it("accepts only the asynchronous 202 response for Event dispatch", async () => {
    mocks.send.mockResolvedValueOnce({ StatusCode: 202 });
    await expect(invokeLambda("StartMinecraftServer", { command: "stop" })).resolves.toBeUndefined();
  });

  it("marks a non-202 service response as a definite pre-dispatch rejection", async () => {
    mocks.send.mockResolvedValueOnce({ StatusCode: 403 });
    await expect(invokeLambda("StartMinecraftServer", { command: "stop" })).rejects.toMatchObject({
      name: "LambdaInvokeRejectedError",
      remoteDispatchRejected: true,
    });
  });
});
