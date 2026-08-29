import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = send;
  },
  SendMessageCommand: class {
    input;
    constructor(input) {
      this.input = input;
    }
  },
}));

import { handler, sanitizedFailureRecord } from "./index.js";

describe("failure destination sanitizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FAILURE_QUEUE_URL = "https://sqs.example.invalid/queue";
    send.mockResolvedValue({ MessageId: "message-1" });
  });

  it("drops raw request and response data from the queue message", async () => {
    const rawSentinel = "RAW-MIME-AND-ERROR-SENTINEL";
    const event = {
      requestContext: { approximateInvokeCount: 3 },
      requestPayload: {
        invocationType: "emailCommand",
        operationId: `email-${"a".repeat(40)}`,
        command: "backup",
        args: [rawSentinel],
        senderEmail: "sender@example.net",
        content: rawSentinel,
      },
      responsePayload: { errorMessage: rawSentinel },
    };

    const record = sanitizedFailureRecord(event);
    expect(JSON.stringify(record)).not.toContain(rawSentinel);
    expect(record).toMatchObject({ command: "backup", argumentCount: 1, attempts: 3 });
    await handler(event);
    const messageBody = send.mock.calls[0][0].input.MessageBody;
    expect(JSON.parse(messageBody)).toMatchObject({
      invocationType: record.invocationType,
      operationId: record.operationId,
      command: record.command,
      argumentCount: record.argumentCount,
    });
    expect(messageBody).not.toMatch(/sender@example|content|errorMessage|RAW-MIME/);
  });

  it("throws a terminal error when sanitized delivery fails", async () => {
    send.mockRejectedValueOnce(new Error("SQS unavailable"));
    await expect(handler({ requestPayload: { invocationType: "api", command: "start" } })).rejects.toThrow(
      "FAILURE_SANITIZER_DELIVERY_FAILED"
    );
  });
});
