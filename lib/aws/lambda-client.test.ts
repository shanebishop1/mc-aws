import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), getStackOutputValue: vi.fn(), resolveInstanceId: vi.fn() }));

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
vi.mock("./instance-resolver", () => ({ resolveInstanceId: mocks.resolveInstanceId }));

import { getMinecraftServiceStatus, invokeLambda } from "./lambda-client";

describe("Lambda invocation dispatch classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStackOutputValue.mockResolvedValue("resolved-lifecycle-lambda");
    mocks.resolveInstanceId.mockResolvedValue("i-managed");
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

  it("dispatches only the fixed service-status operation and returns no command output", async () => {
    mocks.send.mockResolvedValueOnce({
      StatusCode: 200,
      Payload: new TextEncoder().encode(
        JSON.stringify({
          statusCode: 200,
          body: JSON.stringify({ instanceState: "running", instanceRunning: true, serviceActive: true }),
        })
      ),
    });

    await expect(getMinecraftServiceStatus()).resolves.toEqual({
      instanceState: "running",
      instanceRunning: true,
      serviceActive: true,
    });
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      FunctionName: "resolved-lifecycle-lambda",
      InvocationType: "RequestResponse",
      Payload: JSON.stringify({ invocationType: "serviceStatus", instanceId: "i-managed" }),
    });
  });
});
