import { canonicalJson } from "@/lib/agent/canonical-json";
import type { EvidenceReference, JsonObject, JsonValue, ToolResult } from "@/lib/agent/contracts";

/**
 * One byte budget for every local JSON message.  The protocol uses a newline
 * framed JSON envelope, so callers must budget for the newline, JSON escaping,
 * base64url signatures, and the fixed protocol metadata rather than comparing
 * JavaScript string lengths.
 */
export const MAX_AGENT_MESSAGE_BYTES = 128_000;
export const MAX_PROTOCOL_MESSAGE_BYTES = MAX_AGENT_MESSAGE_BYTES;
export const MAX_PROTOCOL_FIXED_OVERHEAD_BYTES = 2_048;
export const MAX_PROTOCOL_PAYLOAD_BYTES = MAX_AGENT_MESSAGE_BYTES - MAX_PROTOCOL_FIXED_OVERHEAD_BYTES;

/** Raw invocation arguments are deliberately below the complete envelope. */
export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_PROVIDER_TOOL_ARGUMENT_BYTES = MAX_TOOL_ARGUMENT_BYTES;
/** A result includes summary, evidence, mutation proof, and protocol metadata. */
export const MAX_TOOL_RESULT_BYTES = 48 * 1024;
export const MAX_TOOL_RESULT_OUTPUT_BYTES = 32 * 1024;
export const MAX_TOOL_EVIDENCE = 32;
export const MAX_TOOL_EVIDENCE_FIELD_BYTES = 1_024;
export const MAX_PROTOCOL_APPROVALS = 8;
export const MAX_AGENT_EVENT_PAYLOAD_BYTES = MAX_TOOL_RESULT_BYTES + 4_096;
export const MAX_TERMINAL_RECEIPT_BYTES = 4_096;

export const RESULT_OVERFLOW_CODE = "tool-result-overflow";

/**
 * Local hard ceilings for untrusted model/provider output. These limits are
 * enforced independently of provider token accounting and are not operator-tunable.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_PROVIDER_SSE_LINE_BYTES = 128 * 1024;
export const MAX_PROVIDER_SSE_EVENT_BYTES = 256 * 1024;
export const MAX_PROVIDER_SSE_EVENTS = 4_096;
export const MAX_PI_QUEUED_EVENTS = 64;
export const MAX_PI_QUEUED_EVENT_BYTES = 512 * 1024;

export const PROVIDER_RESOURCE_LIMIT_CODE = "provider-response-limit";
export const PROVIDER_RESOURCE_LIMIT_MESSAGE =
  "Provider response exceeded a local resource limit; the run was cancelled.";

export function serializedUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON encodable.");
  return new TextEncoder().encode(serialized).byteLength;
}

export function encodedJsonLine(value: unknown, maxBytes = MAX_AGENT_MESSAGE_BYTES): Uint8Array {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON encodable.");
  const bytes = new TextEncoder().encode(`${serialized}\n`);
  if (bytes.byteLength > maxBytes) throw new Error("message-too-large");
  return bytes;
}

export function assertJsonBytes(value: unknown, maximum: number, name: string): void {
  if (serializedUtf8Bytes(value) > maximum) throw new Error(`${name} exceeds its encoded byte budget.`);
}

export async function digestJson(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Truncates by UTF-8 bytes without leaving a partial code point. */
export function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return { value, truncated: false };
  let length = Math.max(0, maximumBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (length > 0) {
    try {
      return { value: decoder.decode(bytes.subarray(0, length)), truncated: true };
    } catch {
      length -= 1;
    }
  }
  return { value: "", truncated: true };
}

function compactJson(value: JsonValue, maximumBytes: number): JsonValue {
  if (typeof value === "string") return truncateUtf8(value, Math.min(maximumBytes, 8_192)).value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (maximumBytes < 16) return "[truncated]";
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, 64)) {
      const candidate = compactJson(item, Math.max(16, Math.floor(maximumBytes / Math.max(1, value.length))));
      if (serializedUtf8Bytes([...result, candidate]) > maximumBytes) break;
      result.push(candidate);
    }
    return result;
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    const candidate = compactJson(child, Math.max(16, Math.floor(maximumBytes / 2)));
    const next = { ...result, [key]: candidate };
    if (serializedUtf8Bytes(next) > maximumBytes) break;
    result[key] = candidate;
  }
  return result;
}

function evidenceDigestInput(evidence: readonly EvidenceReference[]): JsonValue {
  return evidence as unknown as JsonValue;
}

function attachMetadata(output: JsonValue, metadata: JsonObject): JsonValue {
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    return { ...(output as JsonObject), _mcAwsResult: metadata };
  }
  return { value: output, _mcAwsResult: metadata };
}

/**
 * Bounds a host/provider result before schema validation and journal writes.
 * The original encoded output/evidence digest and byte counts remain in the
 * sanitized result, while a committed mutation proof is never discarded.
 */
export async function boundToolResult(input: ToolResult): Promise<ToolResult> {
  const originalOutputBytes = serializedUtf8Bytes(input.output);
  const originalOutputSha256 = await digestJson(input.output);
  const originalEvidenceBytes = serializedUtf8Bytes(input.evidence as unknown as JsonValue);
  const originalEvidenceSha256 = await digestJson(evidenceDigestInput(input.evidence));
  let evidence = input.evidence.slice(0, MAX_TOOL_EVIDENCE).map((item) => ({
    ...item,
    uri: truncateUtf8(item.uri, MAX_TOOL_EVIDENCE_FIELD_BYTES).value,
    description: truncateUtf8(item.description, MAX_TOOL_EVIDENCE_FIELD_BYTES).value,
  }));
  const evidenceTruncated =
    evidence.length !== input.evidence.length ||
    evidence.some(
      (item, index) =>
        item.uri !== input.evidence[index]?.uri || item.description !== input.evidence[index]?.description
    );
  const compactedOutput = compactJson(input.output, MAX_TOOL_RESULT_OUTPUT_BYTES);
  const outputTruncated = serializedUtf8Bytes(compactedOutput) !== originalOutputBytes;
  const metadata: JsonObject = {
    originalBytes: originalOutputBytes,
    sha256: originalOutputSha256,
    truncated: outputTruncated,
    ...(evidenceTruncated
      ? {
          evidenceOriginalBytes: originalEvidenceBytes,
          evidenceCount: input.evidence.length,
          evidenceSha256: originalEvidenceSha256,
          evidenceTruncated: true,
        }
      : {}),
  };
  let candidate: ToolResult = {
    ...input,
    summary: truncateUtf8(input.summary, 2_048).value,
    output: outputTruncated || evidenceTruncated ? attachMetadata(compactedOutput, metadata) : compactedOutput,
    evidence,
  };
  if (serializedUtf8Bytes(candidate) > MAX_TOOL_RESULT_BYTES && evidenceTruncated) {
    evidence = evidence.map((item) => ({
      ...item,
      uri: truncateUtf8(item.uri, 256).value,
      description: truncateUtf8(item.description, 256).value,
    }));
    candidate = { ...candidate, evidence };
  }
  if (serializedUtf8Bytes(candidate) <= MAX_TOOL_RESULT_BYTES) return candidate;

  // Shrink only the human-readable fields first. MutationCommit and the
  // deterministic overflow metadata are retained in the final fallback.
  candidate = {
    ...candidate,
    summary: truncateUtf8(candidate.summary, 256).value,
    output: attachMetadata(
      { code: RESULT_OVERFLOW_CODE },
      {
        originalBytes: serializedUtf8Bytes(input),
        sha256: await digestJson(input as unknown as JsonValue),
        truncated: true,
        ...(input.status === "failed" ? { error: "result exceeded its encoded byte budget" } : {}),
      }
    ),
    evidence: [],
  };
  if (serializedUtf8Bytes(candidate) <= MAX_TOOL_RESULT_BYTES) return candidate;

  // This branch is intentionally tiny and deterministic. It is reachable only
  // if fixed contract metadata itself is unexpectedly enlarged.
  return {
    schemaVersion: 1,
    invocationId: input.invocationId,
    status: input.status,
    completedAt: input.completedAt,
    summary: "Tool result exceeded its encoded byte budget.",
    output: {
      code: RESULT_OVERFLOW_CODE,
      originalBytes: serializedUtf8Bytes(input),
      sha256: await digestJson(input as unknown as JsonValue),
      truncated: true,
    },
    evidence: [],
    ...(input.mutationCommit ? { mutationCommit: input.mutationCommit } : {}),
  };
}
