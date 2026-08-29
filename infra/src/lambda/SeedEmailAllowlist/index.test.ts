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
  PutParameterCommand: class {
    input;
    constructor(input) {
      this.input = input;
    }
  },
}));

import { handler } from "./index.js";

describe("email allowlist custom resource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PARAM_NAME = "/minecraft/email-allowlist";
    process.env.SEED_VALUE = "";
  });

  it("is delete-idempotent and preserves the operator-managed parameter", async () => {
    await expect(handler({ RequestType: "Delete" })).resolves.toEqual({
      PhysicalResourceId: "/minecraft/email-allowlist",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not attempt to create an invalid empty SSM parameter", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "ParameterNotFound" }));
    await expect(handler({ RequestType: "Create" })).resolves.toEqual({
      PhysicalResourceId: "/minecraft/email-allowlist",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
