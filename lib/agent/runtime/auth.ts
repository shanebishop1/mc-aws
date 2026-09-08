import { AgentRuntimeValidationError } from "@/lib/agent/runtime/validation";
import {
  AgentStateConfigurationError,
  AgentStateConflictError,
  AgentStateNotFoundError,
  AgentStateTransitionError,
} from "@/lib/agent/state";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BEARER_LENGTH = 512;

function response(status: number, error: string): NextResponse {
  return NextResponse.json(
    { success: false, error, timestamp: new Date().toISOString() },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

function parseBearer(header: string | null): string | null {
  if (!header || !header.startsWith("Bearer ") || header.includes(",")) return null;
  const token = header.slice(7);
  if (token.length < 32 || token.length > MAX_BEARER_LENGTH || /\s/.test(token)) return null;
  return token;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Length-normalized XOR comparison; both inputs are fixed-size lowercase SHA-256 strings. */
function constantTimeDigestEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left.padEnd(64, "0").slice(0, 64));
  const rightBytes = new TextEncoder().encode(right.padEnd(64, "0").slice(0, 64));
  let difference = left.length ^ right.length;
  for (let index = 0; index < 64; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function authenticateAgentRuntime(request: Request): Promise<{ runtimeId: string } | NextResponse> {
  // Check the canonical switch before consulting retained identity material. Cloudflare
  // secrets omitted by a later deploy can remain bound, so absence and false must both
  // make an old bearer unusable.
  if (process.env.MC_AGENT_RUNTIME_ENABLED?.trim().toLowerCase() !== "true") {
    return response(503, "Agent runtime authentication is unavailable");
  }
  const runtimeId = process.env.MC_AGENT_RUNTIME_ID?.trim() ?? "";
  const expectedHash = process.env.MC_AGENT_RUNTIME_TOKEN_SHA256?.trim().toLowerCase() ?? "";
  if (!RUNTIME_ID.test(runtimeId) || !SHA256.test(expectedHash)) {
    return response(503, "Agent runtime authentication is unavailable");
  }
  const bearer = parseBearer(request.headers.get("authorization"));
  if (!bearer) return response(401, "Agent runtime authentication failed");
  const actualHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))));
  if (!constantTimeDigestEqual(actualHash, expectedHash)) {
    return response(401, "Agent runtime authentication failed");
  }
  return { runtimeId };
}

export async function enforceRuntimeRateLimit(
  runtimeId: string,
  route: string,
  publication = false
): Promise<NextResponse | null> {
  if (process.env.NODE_ENV === "test" && process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS !== "true") return null;
  const result = await checkRateLimit({
    route,
    key: `agent-runtime:${route}:${runtimeId}`,
    limit: publication ? 600 : 120,
    windowMs: 60_000,
    failureMode: "closed",
  });
  if (result.allowed) return null;
  const denied = response(429, "Too many agent runtime requests");
  denied.headers.set("Retry-After", String(result.retryAfterSeconds));
  return denied;
}

export function agentRuntimeError(error: unknown): NextResponse {
  if (error instanceof AgentRuntimeValidationError) return response(400, "Agent runtime request is invalid");
  if (error instanceof AgentStateNotFoundError) return response(404, "Agent runtime work was not found");
  if (error instanceof AgentStateConflictError || error instanceof AgentStateTransitionError) {
    return response(409, "Agent runtime lease or state conflict");
  }
  if (error instanceof AgentStateConfigurationError) return response(503, "Agent runtime state is unavailable");
  console.error("[AGENT-RUNTIME-API] Request failed");
  return response(500, "Agent runtime request failed");
}

export function agentRuntimeSuccess<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { success: true, data, timestamp: new Date().toISOString() },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}
