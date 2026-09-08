import { pathToFileURL } from "node:url";

type CloudflareEnvelope = {
  success: true;
  result: unknown;
  result_info?: unknown;
};

export interface DnsRecordIdentity {
  id: string;
  type: "A" | "AAAA" | "CNAME";
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment: string;
}

export interface RouteIdentity {
  id: string;
  pattern: string;
  script: string;
}

const providerId = (value: unknown, description: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/i.test(value)) {
    throw new Error(`${description} identity is malformed.`);
  }
  return value;
};

const parseEnvelope = (raw: string): CloudflareEnvelope => {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("Cloudflare response is not JSON.");
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw.slice(start));
  } catch {
    throw new Error("Cloudflare response is malformed JSON.");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Cloudflare response envelope is malformed.");
  }
  const parsed = envelope as Partial<CloudflareEnvelope>;
  if (parsed.success !== true || !("result" in parsed)) throw new Error("Cloudflare response reports failure.");
  return parsed as CloudflareEnvelope;
};

const parseListResult = (raw: string): unknown[] => {
  const envelope = parseEnvelope(raw);
  if (!Array.isArray(envelope.result)) throw new Error("Cloudflare list response result must be an array.");

  if (!envelope.result_info || typeof envelope.result_info !== "object" || Array.isArray(envelope.result_info)) {
    throw new Error("Cloudflare list response pagination metadata is malformed.");
  }
  const info = envelope.result_info as Record<string, unknown>;
  const page = info.page;
  const totalPages = info.total_pages;
  const perPage = info.per_page;
  const count = info.count;
  const totalCount = info.total_count;
  if (
    typeof page !== "number" ||
    !Number.isInteger(page) ||
    typeof totalPages !== "number" ||
    !Number.isInteger(totalPages) ||
    typeof perPage !== "number" ||
    !Number.isInteger(perPage) ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    typeof totalCount !== "number" ||
    !Number.isInteger(totalCount) ||
    page !== 1 ||
    totalPages !== 1 ||
    perPage < 1 ||
    count !== envelope.result.length ||
    totalCount !== envelope.result.length ||
    totalCount > perPage ||
    (totalCount === 0 ? 1 : Math.ceil(totalCount / perPage)) !== totalPages
  ) {
    throw new Error("Cloudflare list response is not a complete single-page inventory.");
  }
  return envelope.result;
};

const parseObjectResult = (raw: string): Record<string, unknown> => {
  const result = parseEnvelope(raw).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Cloudflare object response result must be an object.");
  }
  return result as Record<string, unknown>;
};

const dnsRecord = (value: unknown): DnsRecordIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DNS record is malformed.");
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    !/^[a-f0-9]{32}$/i.test(item.id) ||
    !["A", "AAAA", "CNAME"].includes(String(item.type)) ||
    typeof item.name !== "string" ||
    typeof item.content !== "string" ||
    !Number.isInteger(item.ttl) ||
    Number(item.ttl) < 1 ||
    typeof item.proxied !== "boolean" ||
    (item.comment !== undefined && item.comment !== null && typeof item.comment !== "string")
  ) {
    throw new Error("DNS record identity is malformed.");
  }
  return {
    id: item.id,
    type: item.type as DnsRecordIdentity["type"],
    name: item.name.toLowerCase(),
    content: item.content,
    ttl: Number(item.ttl),
    proxied: item.proxied,
    comment: typeof item.comment === "string" ? item.comment : "",
  };
};

const route = (value: unknown): RouteIdentity => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker route is malformed.");
  const item = value as Record<string, unknown>;
  return {
    id: providerId(item.id, "Worker route"),
    pattern:
      typeof item.pattern === "string"
        ? item.pattern
        : (() => {
            throw new Error("Worker route identity is malformed.");
          })(),
    script:
      typeof item.script === "string"
        ? item.script
        : (() => {
            throw new Error("Worker route identity is malformed.");
          })(),
  };
};

const sameDnsIdentity = (actual: DnsRecordIdentity, expected: Omit<DnsRecordIdentity, "id">): boolean =>
  actual.type === expected.type &&
  actual.name === expected.name.toLowerCase() &&
  actual.content === expected.content &&
  actual.ttl === expected.ttl &&
  actual.proxied === expected.proxied &&
  actual.comment === expected.comment;

const sameRouteIdentity = (actual: RouteIdentity, expected: Omit<RouteIdentity, "id">): boolean =>
  actual.pattern === expected.pattern && actual.script === expected.script;

/** Parse an acknowledged DNS create response. This is deliberately an object response, never a list. */
export const parseDnsCreateResponse = (raw: string, expected: Omit<DnsRecordIdentity, "id">): DnsRecordIdentity => {
  const actual = dnsRecord(parseObjectResult(raw));
  if (!sameDnsIdentity(actual, expected))
    throw new Error("Cloudflare DNS create result does not match the complete request identity.");
  return actual;
};

/** Parse an acknowledged Worker route create response. This is deliberately an object response, never a list. */
export const parseRouteCreateResponse = (raw: string, expected: Omit<RouteIdentity, "id">): RouteIdentity => {
  const actual = route(parseObjectResult(raw));
  if (!sameRouteIdentity(actual, expected))
    throw new Error("Cloudflare route create result does not match the complete request identity.");
  return actual;
};

/** Verify an exact, already-journaled DNS ID from a provider object response. */
export const verifyDnsRecordResponse = (raw: string, expected: DnsRecordIdentity): DnsRecordIdentity => {
  const actual = dnsRecord(parseObjectResult(raw));
  if (actual.id !== expected.id || !sameDnsIdentity(actual, expected)) {
    throw new Error(`Cloudflare DNS record ${expected.id} does not match the exact journaled identity.`);
  }
  return actual;
};

/** Verify an exact, already-journaled route ID from a provider object response. */
export const verifyRouteResponse = (raw: string, expected: RouteIdentity): RouteIdentity => {
  const actual = route(parseObjectResult(raw));
  if (actual.id !== expected.id || !sameRouteIdentity(actual, expected)) {
    throw new Error(`Cloudflare Worker route ${expected.id} does not match the exact journaled identity.`);
  }
  return actual;
};

/** Return the only DNS record at a name from a complete list response. */
export const uniqueDnsRecordAtName = (raw: string, name: string): DnsRecordIdentity | undefined => {
  const expectedName = name.toLowerCase();
  const matches = parseListResult(raw)
    .map(dnsRecord)
    .filter((item) => item.name === expectedName);
  if (matches.length > 1) throw new Error(`Ambiguous DNS inventory for ${expectedName}.`);
  return matches[0];
};

/** A lost create response has no safe adoption path: comments are mutable, not idempotency keys. */
export const reconcileDnsCreation = (): never => {
  throw new Error(
    "Indeterminate DNS create: no immutable provider ID was acknowledged; preserving the active journal."
  );
};

/** Return the only route for a pattern from a complete list response. */
export const uniqueRouteAtPattern = (raw: string, pattern: string): RouteIdentity | undefined => {
  const matches = parseListResult(raw)
    .map(route)
    .filter((item) => item.pattern === pattern);
  if (matches.length > 1) throw new Error(`Ambiguous Worker route inventory for ${pattern}.`);
  return matches[0];
};

/** A lost create response has no safe adoption path: route pattern/script is mutable state. */
export const reconcileRouteCreation = (): never => {
  throw new Error(
    "Indeterminate Worker route create: no immutable provider ID was acknowledged; preserving the active journal."
  );
};

const getArg = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the CLI intentionally keeps every provider response boundary explicit and fail-closed.
const runCli = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
  if (command === "dns-inventory") {
    const record = uniqueDnsRecordAtName(raw, getArg(args, "--name"));
    process.stdout.write(record ? JSON.stringify(record) : "absent");
    return;
  }
  if (command === "dns-create-response") {
    const record = parseDnsCreateResponse(raw, {
      type: getArg(args, "--type") as DnsRecordIdentity["type"],
      name: getArg(args, "--name"),
      content: getArg(args, "--content"),
      ttl: Number(getArg(args, "--ttl")),
      proxied: getArg(args, "--proxied") === "true",
      comment: getArg(args, "--comment"),
    });
    process.stdout.write(JSON.stringify(record));
    return;
  }
  if (command === "dns-verify") {
    const record = verifyDnsRecordResponse(raw, {
      id: getArg(args, "--id"),
      type: getArg(args, "--type") as DnsRecordIdentity["type"],
      name: getArg(args, "--name"),
      content: getArg(args, "--content"),
      ttl: Number(getArg(args, "--ttl")),
      proxied: getArg(args, "--proxied") === "true",
      comment: getArg(args, "--comment"),
    });
    process.stdout.write(JSON.stringify(record));
    return;
  }
  if (command === "dns-observe") {
    const observed = dnsRecord(parseObjectResult(raw));
    if (args.includes("--id")) {
      const expected = {
        id: getArg(args, "--id"),
        type: getArg(args, "--type") as DnsRecordIdentity["type"],
        name: getArg(args, "--name"),
        content: getArg(args, "--content"),
        proxied: getArg(args, "--proxied") === "true",
      };
      if (
        observed.id !== expected.id ||
        observed.type !== expected.type ||
        observed.name !== expected.name.toLowerCase() ||
        observed.content !== expected.content ||
        observed.proxied !== expected.proxied
      ) {
        throw new Error("Cloudflare DNS observed identity does not match the expected record.");
      }
    }
    process.stdout.write(JSON.stringify(observed));
    return;
  }
  if (command === "route-inventory") {
    const record = uniqueRouteAtPattern(raw, getArg(args, "--pattern"));
    process.stdout.write(record ? JSON.stringify(record) : "absent");
    return;
  }
  if (command === "route-create-response") {
    const record = parseRouteCreateResponse(raw, {
      pattern: getArg(args, "--pattern"),
      script: getArg(args, "--script"),
    });
    process.stdout.write(JSON.stringify(record));
    return;
  }
  if (command === "route-verify") {
    const record = verifyRouteResponse(raw, {
      id: getArg(args, "--id"),
      pattern: getArg(args, "--pattern"),
      script: getArg(args, "--script"),
    });
    process.stdout.write(JSON.stringify(record));
    return;
  }
  throw new Error(`Unknown Cloudflare reconciliation command: ${String(command)}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
