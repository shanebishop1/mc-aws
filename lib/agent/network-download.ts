import type { TargetScope } from "@/lib/agent/contracts";

export const DEFAULT_NETWORK_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
const NETWORK_DOWNLOAD_SCOPE_TYPE = "network-download";
const SHA256 = /^[a-f0-9]{64}$/;

/** Operator-provided content identity. A URL is never a sufficient identity for a download. */
export interface NetworkDownloadExpectation {
  expectedSha256: string;
  expectedBytes: number;
}

export interface NetworkDownloadApprovalTarget {
  schemaVersion: 1;
  type: typeof NETWORK_DOWNLOAD_SCOPE_TYPE;
  resource: string;
  destination: TargetScope;
  expectedSha256: string;
  expectedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function validDestination(destination: TargetScope): boolean {
  const target = destination.normalizedTarget;
  const components = target.split("/");
  return (
    destination.schemaVersion === 1 &&
    (destination.kind === "workspace" || destination.kind === "session-scratch") &&
    target.length > 0 &&
    !target.startsWith("/") &&
    !target.includes("\0") &&
    !target.includes("\\") &&
    (target === "." || components.every((component) => component.length > 0 && component !== "." && component !== ".."))
  );
}

export function validateNetworkDownloadExpectation(value: NetworkDownloadExpectation): NetworkDownloadExpectation {
  if (!SHA256.test(value.expectedSha256))
    throw new TypeError("Expected download SHA-256 must be lowercase hexadecimal.");
  if (
    !Number.isSafeInteger(value.expectedBytes) ||
    value.expectedBytes < 1 ||
    value.expectedBytes > DEFAULT_NETWORK_DOWNLOAD_MAX_BYTES
  ) {
    throw new TypeError("Expected download size is outside its allowed bound.");
  }
  return value;
}

function encodeNetworkDownloadApprovalTarget(value: NetworkDownloadApprovalTarget): string {
  // Fixed key order is the schema-v1 canonical JSON representation.
  return JSON.stringify({
    destination: {
      kind: value.destination.kind,
      normalizedTarget: value.destination.normalizedTarget,
      schemaVersion: value.destination.schemaVersion,
    },
    expectedBytes: value.expectedBytes,
    expectedSha256: value.expectedSha256,
    resource: value.resource,
    schemaVersion: value.schemaVersion,
    type: value.type,
  });
}

/**
 * Returns the one canonical HTTPS resource identity accepted by the initial
 * download product. Query strings, fragments, userinfo, percent-encoding, and
 * dot segments are rejected rather than risking two representations of the
 * resource shown to an operator.
 */
export function normalizeNetworkDownloadUrl(value: string): URL {
  const hasUnsafeCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || character === "\\";
  });
  if (value.length < 1 || value.length > 8192 || !value.startsWith("https://") || hasUnsafeCharacter) {
    throw new TypeError("Download URL is invalid.");
  }
  if (value.includes("?") || value.includes("#")) {
    throw new TypeError("Download URLs cannot contain a query string or fragment.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Download URL must be absolute.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("Downloads require credential-free HTTPS URLs.");
  }

  const authorityEnd = value.indexOf("/", "https://".length);
  const rawPath = authorityEnd < 0 ? "" : value.slice(authorityEnd);
  if (
    rawPath.includes("%") ||
    url.pathname.includes("%") ||
    rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("Download URL path must be unambiguous and canonical.");
  }

  // URL canonicalizes host case, IDNs, default ports, and an omitted root path.
  url.hostname = url.hostname.replace(/\.$/, "");
  return url;
}

export function exactNetworkDownloadResource(value: string): string {
  const url = normalizeNetworkDownloadUrl(value);
  return `${url.origin}${url.pathname}`;
}

/** Parses only the exact schema-v1 canonical JSON approval identity. */
export function parseNetworkDownloadApprovalTarget(value: string): NetworkDownloadApprovalTarget {
  if (value.length < 1 || value.length > 16_384) throw new TypeError("Network approval target is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Network approval target must be canonical JSON.");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["destination", "expectedBytes", "expectedSha256", "resource", "schemaVersion", "type"])
  ) {
    throw new TypeError("Network approval target schema is invalid.");
  }
  const destination = parsed.destination;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.type !== NETWORK_DOWNLOAD_SCOPE_TYPE ||
    typeof parsed.resource !== "string" ||
    !isRecord(destination) ||
    !hasExactKeys(destination, ["kind", "normalizedTarget", "schemaVersion"]) ||
    destination.schemaVersion !== 1 ||
    (destination.kind !== "workspace" && destination.kind !== "session-scratch") ||
    typeof destination.normalizedTarget !== "string" ||
    typeof parsed.expectedSha256 !== "string" ||
    typeof parsed.expectedBytes !== "number"
  ) {
    throw new TypeError("Network approval target schema is invalid.");
  }
  const target: NetworkDownloadApprovalTarget = {
    schemaVersion: 1,
    type: NETWORK_DOWNLOAD_SCOPE_TYPE,
    resource: parsed.resource,
    expectedSha256: parsed.expectedSha256,
    expectedBytes: parsed.expectedBytes,
    destination: {
      schemaVersion: 1,
      kind: destination.kind,
      normalizedTarget: destination.normalizedTarget,
    },
  };
  if (
    !validDestination(target.destination) ||
    exactNetworkDownloadResource(target.resource) !== target.resource ||
    validateNetworkDownloadExpectation(target) !== target ||
    encodeNetworkDownloadApprovalTarget(target) !== value
  ) {
    throw new TypeError("Network approval target is not canonical.");
  }
  return target;
}

export function networkDownloadApprovalScope(
  resource: string,
  destination: TargetScope,
  expectation: NetworkDownloadExpectation
): TargetScope {
  const canonicalResource = exactNetworkDownloadResource(resource);
  validateNetworkDownloadExpectation(expectation);
  if (canonicalResource !== resource || !validDestination(destination)) {
    throw new TypeError("Network approval scope inputs are not canonical.");
  }
  return {
    schemaVersion: 1,
    kind: "network",
    normalizedTarget: encodeNetworkDownloadApprovalTarget({
      schemaVersion: 1,
      type: NETWORK_DOWNLOAD_SCOPE_TYPE,
      resource: canonicalResource,
      destination,
      expectedSha256: expectation.expectedSha256,
      expectedBytes: expectation.expectedBytes,
    }),
  };
}
