import { isIP } from "node:net";
import { AgentProviderError } from "@/lib/agent/providers/errors";
import type { AgentDnsResolver, ValidatedProviderEndpoint } from "@/lib/agent/providers/types";

const FORBIDDEN_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc0586300, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function ipv4Number(address: string): number {
  return address.split(".").reduce((result, octet) => result * 256 + Number(octet), 0) >>> 0;
}

function isForbiddenIpv4(address: string): boolean {
  const value = ipv4Number(address);
  return FORBIDDEN_IPV4_RANGES.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function expandIpv6(address: string): number[] | undefined {
  const withoutZone = address.toLowerCase().split("%")[0];
  const mappedMatch = withoutZone.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let normalized = withoutZone;
  if (mappedMatch) {
    const value = ipv4Number(mappedMatch[2]);
    normalized = `${mappedMatch[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  if (parts.length !== 8) return undefined;
  const parsed = parts.map((part) => Number.parseInt(part, 16));
  return parsed.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? parsed : undefined;
}

function isForbiddenIpv6(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts) return true;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isForbiddenIpv4(`${parts[6] >>> 8}.${parts[6] & 255}.${parts[7] >>> 8}.${parts[7] & 255}`);
  }
  const first = parts[0];
  const second = parts[1];
  return (
    parts.every((part) => part === 0) ||
    parts.slice(0, 6).every((part) => part === 0) ||
    (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x0064 && second === 0xff9b) ||
    (first === 0x0100 && second === 0) ||
    (first === 0x2001 &&
      (second === 0 || second === 2 || (second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002
  );
}

function isLoopbackAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return (ipv4Number(address) & 0xff000000) === 0x7f000000;
  if (version !== 6) return false;
  const parts = expandIpv6(address);
  return parts?.slice(0, 7).every((part) => part === 0) === true && parts[7] === 1;
}

export function isForbiddenProviderAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isForbiddenIpv4(address) : version === 6 ? isForbiddenIpv6(address) : true;
}

// A linear, fail-closed sequence is easier to audit than distributing URL security rules across callers.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: security validation intentionally remains centralized
export async function validateProviderEndpoint(
  endpoint: string | URL,
  resolveDns: AgentDnsResolver,
  options: { providerId: string; testOnlyAllowLocalhost?: boolean }
): Promise<ValidatedProviderEndpoint> {
  let url: URL;
  try {
    url = endpoint instanceof URL ? new URL(endpoint) : new URL(endpoint);
  } catch {
    throw new AgentProviderError({
      code: "configuration",
      providerId: options.providerId,
      message: "Provider endpoint must be an absolute URL.",
    });
  }
  if (url.username || url.password || url.hash) {
    throw new AgentProviderError({
      code: "security",
      providerId: options.providerId,
      message: "Provider endpoint contains forbidden URL components.",
    });
  }
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const localhost = hostname === "localhost" || hostname.endsWith(".localhost");
  const localAllowed = options.testOnlyAllowLocalhost === true && localhost;
  if (url.protocol !== "https:" && !(localAllowed && url.protocol === "http:")) {
    throw new AgentProviderError({
      code: "security",
      providerId: options.providerId,
      message: "Provider endpoint must use HTTPS.",
    });
  }

  let addresses: readonly string[];
  const literal = isIP(hostname);
  try {
    addresses = literal ? [hostname] : await resolveDns(hostname);
  } catch {
    throw new AgentProviderError({
      code: "security",
      providerId: options.providerId,
      message: "Provider endpoint DNS resolution failed closed.",
    });
  }
  const validatedAddresses = [...new Set(addresses)];
  const forbiddenResolution = localAllowed
    ? validatedAddresses.some((address) => !isLoopbackAddress(address))
    : validatedAddresses.some(isForbiddenProviderAddress);
  if (validatedAddresses.length === 0 || forbiddenResolution) {
    throw new AgentProviderError({
      code: "security",
      providerId: options.providerId,
      message: "Provider endpoint resolves to a forbidden network range.",
    });
  }
  const addressesTuple: [string, ...string[]] = [validatedAddresses[0], ...validatedAddresses.slice(1)];
  return {
    url,
    addresses: Object.freeze(addressesTuple),
  };
}
