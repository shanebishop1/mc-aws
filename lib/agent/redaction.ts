import type { JsonObject, JsonValue } from "@/lib/agent/contracts";
import { isSensitiveKey } from "@/lib/agent/sensitive-keys";

const REDACTION_MARKER = "[REDACTED]";
const SENSITIVE_TEXT = [
  /\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:sk|api)[-_][a-zA-Z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g,
  /\b(?:password|passwd|token|api[-_ ]?key|secret(?:[-_ ]?access)?[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi,
] as const;

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1] ?? 0;
    const third = bytes[offset + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    encoded += alphabet[(value >> 18) & 63];
    encoded += alphabet[(value >> 12) & 63];
    encoded += offset + 1 < bytes.length ? alphabet[(value >> 6) & 63] : "=";
    encoded += offset + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return encoded;
}

function encodedVariants(secret: string): string[] {
  const bytes = new TextEncoder().encode(secret);
  const standardBase64 = base64(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const percent = encodeURIComponent(secret);
  const lowerPercentEscapes = percent.replace(/%[0-9A-F]{2}/gu, (encodedByte) => encodedByte.toLowerCase());
  return [
    secret,
    percent,
    lowerPercentEscapes,
    standardBase64,
    standardBase64.replace(/=+$/u, ""),
    standardBase64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
    hex,
    hex.toUpperCase(),
  ];
}

function textualLeaves(value: JsonValue, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) textualLeaves(item, output);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    textualLeaves(child, output);
  }
}

function decodedCandidates(value: string): string[] {
  const candidates = [value];
  let decoded = value;
  for (let pass = 0; pass < 2; pass++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      candidates.push(next);
      decoded = next;
    } catch {
      break;
    }
  }
  return candidates;
}

/**
 * Fail-closed detector for configured secret values reflected into model-created tool input.
 * It checks raw, URL, base64/base64url, and hex forms, including values split across JSON leaves.
 */
export class ConfiguredSecretDetector {
  private readonly variants: readonly string[];
  private readonly compactVariants: readonly string[];

  constructor(exactSecrets: readonly string[]) {
    const secrets = [...new Set(exactSecrets.filter((secret) => secret.length > 0))];
    this.variants = [...new Set(secrets.flatMap(encodedVariants))].sort((left, right) => right.length - left.length);
    this.compactVariants = this.variants.filter((variant) => !/\s/u.test(variant));
  }

  contains(value: JsonValue): boolean {
    if (this.variants.length === 0) return false;
    const leaves: string[] = [];
    textualLeaves(value, leaves);
    const candidates = [...leaves, leaves.join("")];
    return candidates.some((candidate) => {
      for (const decoded of decodedCandidates(candidate)) {
        if (this.variants.some((variant) => decoded.includes(variant))) return true;
        const compact = decoded.replace(/\s+/gu, "");
        if (compact !== decoded && this.compactVariants.some((variant) => compact.includes(variant))) return true;
      }
      return false;
    });
  }
}

export function redactSensitiveText(value: string, exactSecrets: readonly string[] = []): string {
  let redacted = value;
  const variants = [...new Set(exactSecrets.filter(Boolean).flatMap(encodedVariants))].sort(
    (left, right) => right.length - left.length
  );
  for (const variant of variants) {
    redacted = redacted.split(variant).join(REDACTION_MARKER);
  }
  for (const pattern of SENSITIVE_TEXT) redacted = redacted.replace(pattern, REDACTION_MARKER);
  return redacted;
}

/** Central deep redactor used before any agent value is persisted or published. */
export function redactSecretAwareJson(value: JsonObject, exactSecrets: readonly string[] = []): JsonObject {
  const visit = (item: JsonValue): JsonValue => {
    if (typeof item === "string") return redactSensitiveText(item, exactSecrets);
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(visit);
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(item)) {
      if (!isSensitiveKey(key)) result[key] = visit(child);
    }
    return result;
  };
  return visit(value) as JsonObject;
}

/**
 * Redacts configured values from a text stream without exposing values split
 * across transport or model event boundaries. A bounded suffix is retained
 * until it can no longer be the prefix of a configured secret.
 */
export class StreamingSecretRedactor {
  private readonly secrets: readonly string[];
  private pending = "";

  constructor(exactSecrets: readonly string[]) {
    this.secrets = [...new Set(exactSecrets.filter((secret) => secret.length > 0).flatMap(encodedVariants))].sort(
      (left, right) => right.length - left.length
    );
  }

  push(chunk: string): string {
    this.pending += chunk;
    let output = "";
    while (this.pending.length > 0) {
      const exact = this.secrets.find((secret) => this.pending.startsWith(secret));
      if (exact) {
        if (this.secrets.some((secret) => secret.length > exact.length && secret.startsWith(this.pending))) break;
        output += REDACTION_MARKER;
        this.pending = this.pending.slice(exact.length);
        continue;
      }
      if (this.secrets.some((secret) => secret.startsWith(this.pending))) break;
      output += this.pending[0];
      this.pending = this.pending.slice(1);
    }
    return output;
  }

  flush(): string {
    // pending can only be a prefix of a configured secret. Emitting it at end
    // of stream would disclose a retained possible-secret prefix.
    const output = this.pending.length > 0 ? REDACTION_MARKER : "";
    this.pending = "";
    return output;
  }
}

export { REDACTION_MARKER };
