/**
 * Canonical JSON shared by authenticated and digest-bound agent surfaces.
 *
 * Keys use JavaScript UTF-16 code-unit ordering. Strings must contain Unicode
 * scalar values so the emitted UTF-8 bytes can be reproduced by the root
 * Python verifier without surrogate replacement or ASCII escaping.
 */
function assertUnicodeScalars(value: string): void {
  for (const scalar of value) {
    if (scalar.length !== 1) continue;
    const codeUnit = scalar.charCodeAt(0);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical JSON contains an invalid Unicode scalar.");
    }
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertUnicodeScalars(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === undefined) throw new TypeError("Canonical JSON contains an undefined value.");
  if (typeof value !== "object") throw new TypeError("Value is not canonical JSON encodable.");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Canonical JSON objects must be plain objects.");
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => {
      assertUnicodeScalars(key);
      return [key, child] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
