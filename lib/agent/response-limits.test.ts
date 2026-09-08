import type { ToolResult } from "@/lib/agent/contracts";
import { agentSchemas } from "@/lib/agent/validators";
import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_MESSAGE_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_EVIDENCE,
  MAX_TOOL_EVIDENCE_FIELD_BYTES,
  MAX_TOOL_RESULT_BYTES,
  assertJsonBytes,
  boundToolResult,
  encodedJsonLine,
  truncateUtf8,
} from "./response-limits";

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    schemaVersion: 1,
    invocationId: "invocation-response-limits",
    status: "succeeded",
    completedAt: "2026-09-04T12:00:00.000Z",
    summary: "bounded result",
    output: { ok: true },
    evidence: [],
    ...overrides,
  };
}

describe("encoded response limits", () => {
  it("counts the newline and UTF-8 bytes at the message boundary", () => {
    const value = { text: "é".repeat(100) };
    const line = encodedJsonLine(value);
    expect(line.at(-1)).toBe(10);
    expect(line.byteLength).toBe(new TextEncoder().encode(`${JSON.stringify(value)}\n`).byteLength);
    expect(() => encodedJsonLine({ text: "x".repeat(MAX_AGENT_MESSAGE_BYTES) })).toThrow(/message-too-large/);
  });

  it("truncates multibyte text without producing a broken code point", () => {
    const bounded = truncateUtf8("😀".repeat(100), 7);
    expect(bounded.truncated).toBe(true);
    expect(new TextEncoder().encode(bounded.value).byteLength).toBeLessThanOrEqual(7);
    expect(bounded.value).toBe("😀".repeat(1));
  });

  it("keeps raw arguments below the result envelope budget", () => {
    expect(() =>
      assertJsonBytes({ content: "x".repeat(MAX_TOOL_ARGUMENT_BYTES) }, MAX_TOOL_ARGUMENT_BYTES, "arguments")
    ).toThrow();
    expect(() =>
      assertJsonBytes({ content: "x".repeat(MAX_TOOL_ARGUMENT_BYTES - 32) }, MAX_TOOL_ARGUMENT_BYTES, "arguments")
    ).not.toThrow();
  });

  it("bounds a megabyte output before schema validation while retaining its digest metadata", async () => {
    const bounded = await boundToolResult(result({ output: "界".repeat(400_000) }));
    agentSchemas.toolResult.parse(bounded);
    expect(JSON.stringify(bounded).length).toBeGreaterThan(0);
    expect(JSON.stringify(bounded).length).toBeLessThan(MAX_TOOL_RESULT_BYTES * 2);
    expect(bounded.output).toMatchObject({
      _mcAwsResult: {
        truncated: true,
        originalBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("bounds evidence count and fields while recording truncation evidence", async () => {
    const evidence = Array.from({ length: MAX_TOOL_EVIDENCE + 5 }, (_, index) => ({
      schemaVersion: 1 as const,
      evidenceId: `evidence-${index}`,
      kind: "file" as const,
      uri: `workspace://${"u".repeat(MAX_TOOL_EVIDENCE_FIELD_BYTES + 10)}`,
      description: "d".repeat(MAX_TOOL_EVIDENCE_FIELD_BYTES + 10),
    }));
    const bounded = await boundToolResult(result({ evidence }));
    agentSchemas.toolResult.parse(bounded);
    expect(bounded.evidence).toHaveLength(MAX_TOOL_EVIDENCE);
    expect(new TextEncoder().encode(bounded.evidence[0]!.uri).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_EVIDENCE_FIELD_BYTES
    );
    expect(bounded.output).toMatchObject({ _mcAwsResult: { evidenceTruncated: true, evidenceCount: evidence.length } });
  });

  it("bounds an oversized result without discarding a committed mutation proof", async () => {
    const bounded = await boundToolResult(
      result({
        summary: "s".repeat(100_000),
        output: "o".repeat(100_000),
        mutationCommit: { committed: true, point: "atomic-rename" },
      })
    );
    agentSchemas.toolResult.parse(bounded);
    expect(bounded.output).toMatchObject({ _mcAwsResult: { truncated: true } });
    expect(bounded.mutationCommit).toEqual({ committed: true, point: "atomic-rename" });
    expect(JSON.stringify(bounded).length).toBeLessThan(MAX_TOOL_RESULT_BYTES * 2);
  });
});
