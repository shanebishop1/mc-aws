import { describe, expect, it, vi } from "vitest";

import { parseEmailFromEvent } from "./email-parser.js";

function createEvent(from: string, subject = "START") {
  return {
    Records: [
      {
        Sns: {
          MessageId: "sns-message-123",
          Timestamp: "2026-04-13T12:00:00.000Z",
          Message: JSON.stringify({
            mail: { messageId: "ses-message-123", commonHeaders: { from: [from], subject } },
            receipt: {
              spfVerdict: { status: "PASS" },
              dkimVerdict: { status: "PASS" },
              dmarcVerdict: { status: "PASS" },
            },
          }),
        },
      },
    ],
  };
}

describe("parseEmailFromEvent", () => {
  it("extracts an angle-bracket sender and preserves fallback behavior", () => {
    expect(parseEmailFromEvent(createEvent("Example User <USER@example.com>"))).toMatchObject({
      senderEmail: "user@example.com",
      subject: "start",
      eventIdentity: "ses-message-123",
      requestedAt: "2026-04-13T12:00:00.000Z",
    });
    expect(parseEmailFromEvent(createEvent("USER@example.com"))).toMatchObject({
      senderEmail: "user@example.com",
    });
    expect(parseEmailFromEvent(createEvent("<> <SECOND@example.com>"))).toMatchObject({
      senderEmail: "second@example.com",
    });
  });

  it("handles a long malformed sender without repeated regex scans", () => {
    const from = "<".repeat(200_000);

    expect(parseEmailFromEvent(createEvent(from))).toMatchObject({ senderEmail: from });
  });

  it("never logs raw subject content or command keywords", () => {
    const subject = "PRIVATE-START-KEYWORD do not disclose";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(parseEmailFromEvent(createEvent("user@example.com", subject))).toMatchObject({
        subject: subject.toLowerCase(),
      });
      const logged = [...log.mock.calls, ...error.mock.calls].flat().join(" ");
      expect(logged).not.toContain(subject);
      expect(logged.toLowerCase()).not.toContain("private-start-keyword");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
