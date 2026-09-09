import type { ExecutorReceiptVerifierSet } from "../../../lib/agent/contracts";
import type { PublicAgentProviderCatalogDto } from "../../../lib/agent/control-plane/provider-catalog";
import { AgentControlPlaneService } from "../../../lib/agent/control-plane/service";
import { verifyExecutorTerminalReceipt } from "../../../lib/agent/runtime/executor-receipt";
import { AgentRuntimeService } from "../../../lib/agent/runtime/service";
import {
  parseTerminalPublicationAuthorization,
  terminalPublicationSignedContent,
} from "../../../lib/agent/runtime/terminal-publication";
import {
  parseApproval,
  parseApprovalConsumption,
  parseDecisionPoll,
  parseEvents,
  parseInvocationAuthorization,
  parseLeaseMutation,
  parseRecoveryPublication,
  parseRenew,
  parseStatus,
  parseWorkLeaseRequest,
} from "../../../lib/agent/runtime/validation";
import {
  AgentSessionDurableObject,
  AgentSessionIndexDurableObject,
  AgentSessionShardDurableObject,
  AgentStateConflictError,
  AgentStateNotFoundError,
  AgentStateTransitionError,
  CloudflareAgentStateRepository,
  RepositoryAgentSessionStore,
} from "../../../lib/agent/state";

export { AgentSessionDurableObject, AgentSessionIndexDurableObject, AgentSessionShardDurableObject };

interface Environment {
  AGENT_SESSION_DURABLE_OBJECT: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  };
  AGENT_SESSION_INDEX_DURABLE_OBJECT: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  };
  AGENT_SESSION_SHARD_DURABLE_OBJECT: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  };
  FIXTURE_RECEIPT_PUBLIC_KEY?: string;
  MC_AGENT_RUNTIME_ENABLED?: string;
  MC_AGENT_RUNTIME_ID?: string;
  MC_AGENT_RUNTIME_TOKEN_SHA256?: string;
}

const PROFILE_CATALOG = {
  schemaVersion: 1 as const,
  profiles: [
    {
      schemaVersion: 1 as const,
      profileId: "local-fake",
      providerId: "fake",
      providerKind: "fake",
      displayName: "Local fake provider",
      endpointOrigin: "local://fake",
      endpointDisplay: "Local only",
      allowedModels: ["deterministic-v1"],
      supportedFeatures: ["streaming", "tools"] as const,
    },
  ],
} satisfies PublicAgentProviderCatalogDto;

const NOW = "2026-09-09T12:00:00.000Z";
const acknowledgementKeys = crypto.subtle.generateKey({ name: "Ed25519" }, false, [
  "sign",
  "verify",
]) as Promise<CryptoKeyPair>;
// Durable Object stub.fetch is a platform binding call and does not use this
// global fetch guard. Workerd OS-level egress is intentionally not qualified by
// this fixture; only the Worker API boundary is denied here.
const nativeFetch = globalThis.fetch.bind(globalThis);

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!isLoopbackHost(url.hostname)) {
    throw new Error("External network access is disabled in the Worker fixture.");
  }
  return await nativeFetch(input, init);
};

function base64Url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function json(data: unknown, status = 200): Response {
  return Response.json(
    {
      success: status >= 200 && status < 300,
      ...(status >= 200 && status < 300 ? { data } : { error: data }),
      timestamp: NOW,
    },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

function runtimeError(error: unknown): Response {
  if (error instanceof AgentStateNotFoundError) return json("Agent runtime work was not found", 404);
  if (error instanceof AgentStateConflictError || error instanceof AgentStateTransitionError) {
    return json("Agent runtime lease or state conflict", 409);
  }
  if (error instanceof Error && error.message.includes("invalid")) return json("Agent runtime request is invalid", 400);
  return json("Agent runtime request failed", 500);
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 1_000_000) throw new Error("invalid body");
  return JSON.parse(text) as unknown;
}

function store(environment: Environment): RepositoryAgentSessionStore {
  return new RepositoryAgentSessionStore(
    new CloudflareAgentStateRepository(
      environment.AGENT_SESSION_DURABLE_OBJECT,
      environment.AGENT_SESSION_INDEX_DURABLE_OBJECT,
      environment.AGENT_SESSION_SHARD_DURABLE_OBJECT
    )
  );
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left.padEnd(64, "0").slice(0, 64));
  const rightBytes = new TextEncoder().encode(right.padEnd(64, "0").slice(0, 64));
  let difference = left.length ^ right.length;
  for (let index = 0; index < 64; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

async function authenticateRuntime(request: Request, environment: Environment): Promise<string | Response> {
  if (environment.MC_AGENT_RUNTIME_ENABLED !== "true") return json("Agent runtime authentication is unavailable", 503);
  const configuredRuntimeId = environment.MC_AGENT_RUNTIME_ID?.trim() ?? "";
  const expectedHash = environment.MC_AGENT_RUNTIME_TOKEN_SHA256?.trim().toLowerCase() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configuredRuntimeId) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return json("Agent runtime authentication is unavailable", 503);
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.includes(",")) {
    return json("Agent runtime authentication failed", 401);
  }
  const bearer = authorization.slice(7);
  if (bearer.length < 32 || bearer.length > 512 || /\s/.test(bearer)) {
    return json("Agent runtime authentication failed", 401);
  }
  const actualHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))));
  return constantTimeEqual(actualHash, expectedHash)
    ? configuredRuntimeId
    : json("Agent runtime authentication failed", 401);
}

function runtimeService(environment: Environment): AgentRuntimeService {
  return new AgentRuntimeService(store(environment), {
    now: () => new Date(NOW),
    createId: () => "fixture-lease-id",
    sleep: async () => undefined,
    issueTerminalAcknowledgement: async (value) => {
      const { privateKey } = await acknowledgementKeys;
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        new TextEncoder().encode(terminalPublicationSignedContent(value))
      );
      return parseTerminalPublicationAuthorization({ ...value, signature: base64Url(signature) });
    },
    verifyRecoveryReceipt: async (receipt) => {
      const publicKey = environment.FIXTURE_RECEIPT_PUBLIC_KEY;
      if (!publicKey) return false;
      const verifierSet: ExecutorReceiptVerifierSet = {
        schemaVersion: 1,
        currentKeyId: receipt.executorKeyId,
        verifiers: [{ schemaVersion: 1, keyId: receipt.executorKeyId, publicKeySpki: publicKey, keyEpoch: 1 }],
      };
      return await verifyExecutorTerminalReceipt(receipt, verifierSet);
    },
  });
}

async function runtime(request: Request, environment: Environment): Promise<Response> {
  const path = new URL(request.url).pathname;
  const authenticated = await authenticateRuntime(request, environment);
  if (authenticated instanceof Response) return authenticated;
  const runtimeName = authenticated;
  const service = runtimeService(environment);
  const input = await body(request);
  if (path === "/api/agent/runtime/work") {
    return json(await service.leaseWork(runtimeName, parseWorkLeaseRequest(input), request.signal));
  }
  const match = /^\/api\/agent\/runtime\/leases\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return json("not found", 404);
  const leaseId = match[1];
  const action = match[2];
  switch (action) {
    case "ack":
      return json(await service.acknowledge(runtimeName, leaseId, parseLeaseMutation(input)));
    case "events":
      return json(await service.publishEvents(runtimeName, leaseId, parseEvents(input)));
    case "renew":
      return json(await service.renew(runtimeName, leaseId, parseRenew(input)));
    case "approval":
      return json(await service.publishApproval(runtimeName, leaseId, parseApproval(input)));
    case "consume-approval":
      return json(await service.consumeApproval(runtimeName, leaseId, parseApprovalConsumption(input)));
    case "authorize":
      return json(await service.authorizeInvocation(runtimeName, leaseId, parseInvocationAuthorization(input)));
    case "status":
      return json(await service.publishStatus(runtimeName, leaseId, parseStatus(input)));
    case "decisions":
      return json(await service.waitForDecision(runtimeName, leaseId, parseDecisionPoll(input), request.signal));
    case "recovery":
      return json(await service.publishRecovery(runtimeName, leaseId, parseRecoveryPublication(input)));
    default:
      return json("not found", 404);
  }
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST") return json("method not allowed", 405);
      if (path === "/fixture/health") {
        const namespaces = [
          environment.AGENT_SESSION_DURABLE_OBJECT,
          environment.AGENT_SESSION_INDEX_DURABLE_OBJECT,
          environment.AGENT_SESSION_SHARD_DURABLE_OBJECT,
        ];
        return json({
          execution: "worker-http",
          durableObjectBindings: namespaces.filter(
            (namespace) => typeof namespace.idFromName === "function" && typeof namespace.get === "function"
          ).length,
          runtime: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
          networkEnforcement: {
            workerFetch: "loopback-only",
            workerdOsEgress: "not-qualified",
          },
        });
      }
      if (path === "/fixture/network-probe") {
        try {
          await fetch("https://example.invalid");
          return json({ blocked: false });
        } catch {
          return json({ blocked: true });
        }
      }
      if (path === "/fixture/create") {
        const input = (await body(request)) as {
          actorId: string;
          request: Parameters<AgentControlPlaneService["createSession"]>[1];
        };
        const service = new AgentControlPlaneService(store(environment), () => new Date(NOW), false, PROFILE_CATALOG);
        return json(await service.createSession(input.actorId, input.request));
      }
      if (path === "/fixture/approve") {
        const input = (await body(request)) as {
          actorId: string;
          sessionId: string;
          approvalId: string;
          request: Parameters<AgentControlPlaneService["decideApproval"]>[3];
        };
        const service = new AgentControlPlaneService(store(environment), () => new Date(NOW), false, PROFILE_CATALOG);
        return json(await service.decideApproval(input.actorId, input.sessionId, input.approvalId, input.request));
      }
      if (path === "/fixture/read" || path === "/fixture/replay") {
        const input = (await body(request)) as { sessionId: string; afterCursor?: string };
        const sessionStore = store(environment);
        if (path === "/fixture/read") return json(await sessionStore.getSession(input.sessionId));
        return json(await sessionStore.replayEvents(input.sessionId, input.afterCursor));
      }
      if (path.startsWith("/api/agent/runtime/")) return await runtime(request, environment);
      return json("not found", 404);
    } catch (error) {
      return runtimeError(error);
    }
  },
};
