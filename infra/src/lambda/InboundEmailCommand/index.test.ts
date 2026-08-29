import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lambdaSend: vi.fn(), ssmSend: vi.fn() }));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = mocks.lambdaSend;
  },
  InvokeCommand: class {
    input;
    constructor(input) {
      this.input = input;
    }
  },
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = mocks.ssmSend;
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

function inboundEvent(overrides = {}) {
  const payload = {
    mail: {
      messageId: "ses-message-1",
      timestamp: "2026-08-28T12:00:00.000Z",
      destination: ["commands@example.net"],
      commonHeaders: { from: ["Admin <admin@example.net>"], subject: "backup nightly" },
    },
    receipt: {
      recipients: ["commands@example.net"],
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
    },
    content: Buffer.from("From: admin@example.net\r\n\r\nconfidential MIME body").toString("base64"),
    ...overrides,
  };
  return {
    Records: [
      {
        EventSource: "aws:sns",
        Sns: {
          TopicArn: "arn:aws:sns:us-west-1:111111111111:commands",
          MessageId: "sns-1",
          Message: JSON.stringify(payload),
        },
      },
    ],
  };
}

describe("inbound email command sanitizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EXPECTED_TOPIC_ARN = "arn:aws:sns:us-west-1:111111111111:commands";
    process.env.EXPECTED_RECIPIENT = "commands@example.net";
    process.env.LIFECYCLE_FUNCTION_NAME = "lifecycle";
    process.env.ADMIN_EMAIL = "admin@example.net";
    process.env.START_KEYWORD = "start";
    process.env.ALLOWED_EMAILS = "";
    mocks.lambdaSend.mockResolvedValue({ StatusCode: 202 });
  });

  it("dispatches only opaque identity and validated command metadata", async () => {
    await expect(handler(inboundEvent())).resolves.toMatchObject({ statusCode: 202 });
    const command = mocks.lambdaSend.mock.calls[0][0];
    const dispatched = JSON.parse(Buffer.from(command.input.Payload).toString("utf8"));
    expect(dispatched).toEqual({
      invocationType: "emailCommand",
      operationId: expect.stringMatching(/^email-[a-f0-9]{40}$/),
      command: "backup",
      args: ["nightly"],
      requestedAt: "2026-08-28T12:00:00.000Z",
    });
    expect(JSON.stringify(dispatched)).not.toMatch(/admin@example|subject|body|content|MIME/);
  });

  it("rejects an unexpected topic or failed authentication without dispatch", async () => {
    const event = inboundEvent({ receipt: { spfVerdict: { status: "FAIL" } } });
    await expect(handler(event)).resolves.toMatchObject({ statusCode: 400 });
    expect(mocks.lambdaSend).not.toHaveBeenCalled();
  });

  it("applies admin allowlist updates at ingress without sending body data to lifecycle", async () => {
    const event = inboundEvent({
      mail: {
        messageId: "allowlist-1",
        destination: ["commands@example.net"],
        commonHeaders: { from: ["admin@example.net"], subject: "allowlist" },
      },
      content: Buffer.from("Header: value\r\n\r\nfriend@example.net").toString("base64"),
    });
    mocks.ssmSend.mockResolvedValue({});

    await expect(handler(event)).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.lambdaSend).not.toHaveBeenCalled();
    expect(mocks.ssmSend.mock.calls[0][0].input).toMatchObject({
      Name: "/minecraft/email-allowlist",
      Value: "admin@example.net,friend@example.net",
      Overwrite: true,
    });
  });
});
