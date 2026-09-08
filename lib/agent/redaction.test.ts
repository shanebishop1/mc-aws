import {
  ConfiguredSecretDetector,
  REDACTION_MARKER,
  StreamingSecretRedactor,
  redactSensitiveText,
} from "@/lib/agent/redaction";
import { describe, expect, it } from "vitest";

describe("streaming secret redaction", () => {
  const secret = "session-secret-value";

  it.each(Array.from({ length: secret.length - 1 }, (_, index) => index + 1))(
    "redacts an exact value split at byte boundary %i",
    (boundary) => {
      const redactor = new StreamingSecretRedactor([secret]);
      const output =
        redactor.push(secret.slice(0, boundary)) + redactor.push(secret.slice(boundary)) + redactor.flush();
      expect(output).toBe(REDACTION_MARKER);
      expect(output).not.toContain(secret);
    }
  );

  it("never flushes a retained possible-secret prefix", () => {
    for (let length = 1; length < secret.length; length++) {
      const prefix = secret.slice(0, length);
      const redactor = new StreamingSecretRedactor([secret]);
      expect(redactor.push(prefix)).toBe("");
      const flushed = redactor.flush();
      expect(flushed).toBe(REDACTION_MARKER);
      expect(flushed).not.toContain(prefix);
    }
  });

  it("preserves non-secret text around repeated and overlapping configured values", () => {
    const redactor = new StreamingSecretRedactor(["secret", "secret-long"]);
    const output = ["safe se", "cret middle secret-", "long end"]
      .map((chunk) => redactor.push(chunk))
      .join("")
      .concat(redactor.flush());
    expect(output).toBe(`safe ${REDACTION_MARKER} middle ${REDACTION_MARKER} end`);
  });

  it.each([
    ["URL encoding", encodeURIComponent(secret)],
    ["base64", Buffer.from(secret).toString("base64")],
    ["base64url", Buffer.from(secret).toString("base64url")],
    ["hex", Buffer.from(secret).toString("hex")],
  ])("redacts %s across model event boundaries", (_label, encoded) => {
    const boundary = Math.floor(encoded.length / 2);
    const redactor = new StreamingSecretRedactor([secret]);
    const output =
      redactor.push(encoded.slice(0, boundary)) + redactor.push(encoded.slice(boundary)) + redactor.flush();
    expect(output).toBe(REDACTION_MARKER);
    expect(redactSensitiveText(`reflected=${encoded}`, [secret])).toBe(`reflected=${REDACTION_MARKER}`);
  });
});

describe("configured secret detection", () => {
  const secret = "Provider-Secret/Value+2026";
  const detector = new ConfiguredSecretDetector([secret]);

  it.each([
    ["raw", secret],
    ["URL encoded", encodeURIComponent(secret)],
    ["base64", Buffer.from(secret).toString("base64")],
    ["base64url", Buffer.from(secret).toString("base64url")],
    ["hex", Buffer.from(secret).toString("hex").toUpperCase()],
  ])("detects a %s configured value", (_label, value) => {
    expect(detector.contains({ command: ["printf", value] })).toBe(true);
  });

  it("detects encoded material split across separate argument leaves", () => {
    const encoded = Buffer.from(secret).toString("base64");
    const boundary = Math.floor(encoded.length / 2);
    expect(detector.contains({ contentChunks: [encoded.slice(0, boundary), encoded.slice(boundary)] })).toBe(true);
  });

  it("does not flag unrelated model-created content", () => {
    expect(detector.contains({ command: ["printf", "safe deterministic content"] })).toBe(false);
  });
});
