import {
  AgentProviderCatalogConfigurationError,
  AgentProviderSelectionError,
} from "@/lib/agent/control-plane/provider-catalog";
import { AgentApiValidationError } from "@/lib/agent/control-plane/validation";
import {
  AgentStateConfigurationError,
  AgentStateConflictError,
  AgentStateNotFoundError,
  AgentStateReplayError,
  AgentStateTransitionError,
} from "@/lib/agent/state";
import { requireAdmin } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { type NextRequest, NextResponse } from "next/server";

export async function authenticateAgentAdmin(request: NextRequest): Promise<{ actorId: string } | NextResponse> {
  try {
    const user = await requireAdmin(request);
    const { deriveOpaqueActorId } = await import("@/lib/agent/control-plane/service");
    return { actorId: await deriveOpaqueActorId(user.email) };
  } catch (error) {
    if (error instanceof Response) return noStore(error as NextResponse);
    return agentErrorResponse(error);
  }
}

export async function enforceAgentRateLimit(
  _request: NextRequest,
  actorId: string,
  route: string,
  mutation: boolean
): Promise<NextResponse | null> {
  if (process.env.NODE_ENV === "test" && process.env.MC_ENABLE_RATE_LIMIT_IN_TESTS !== "true") return null;
  const result = await checkRateLimit({
    route,
    key: `agent:${mutation ? "mutate" : "read"}:${route}:${actorId}`,
    limit: mutation ? 12 : 60,
    windowMs: 60_000,
    failureMode: "closed",
  });
  if (result.allowed) return null;
  const response = NextResponse.json(
    { success: false, error: "Too many agent requests. Please retry shortly.", timestamp: new Date().toISOString() },
    { status: 429 }
  );
  response.headers.set("Retry-After", String(result.retryAfterSeconds));
  return noStore(response);
}

export function agentSuccess<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { success: true, data, timestamp: new Date().toISOString() },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

export function agentErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentApiValidationError) return failure(400, "Request is invalid");
  if (error instanceof AgentProviderSelectionError) return failure(400, "Provider or model is not allowed");
  if (error instanceof AgentStateReplayError) return failure(400, "Replay cursor is invalid");
  if (error instanceof AgentStateNotFoundError) return failure(404, "Agent session not found");
  if (error instanceof AgentStateConflictError) return failure(409, "Agent session revision or idempotency conflict");
  if (error instanceof AgentStateTransitionError)
    return failure(409, "Agent session mutation is not allowed in its current state");
  if (error instanceof AgentStateConfigurationError) return failure(503, "Agent session state service is unavailable");
  if (error instanceof AgentProviderCatalogConfigurationError)
    return failure(503, "Agent provider catalog is unavailable");
  console.error("[AGENT-API] Request failed");
  return failure(500, "Agent request failed");
}

function failure(status: number, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: message, timestamp: new Date().toISOString() },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
