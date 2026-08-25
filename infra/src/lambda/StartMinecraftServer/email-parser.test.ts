import { describe, expect, it } from "vitest";

import { parseEmailFromEvent } from "./email-parser.js";

function createEvent(from: string) {
  return {
    Records: [
      {
        Sns: {
          Message: JSON.stringify({
            mail: { commonHeaders: { from: [from], subject: "START" } },
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
});
