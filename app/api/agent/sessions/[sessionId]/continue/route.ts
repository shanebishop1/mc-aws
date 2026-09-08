import {
  agentErrorResponse,
  agentSuccess,
  authenticateAgentAdmin,
  enforceAgentRateLimit,
} from "@/lib/agent/control-plane/http";
import { AgentControlPlaneService } from "@/lib/agent/control-plane/service";
import { parseAgentId, parseContinueSessionRequest, readStrictJson } from "@/lib/agent/control-plane/validation";
import { getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

interface Context {
  params: Promise<{ sessionId: string }>;
}

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(
    request,
    auth.actorId,
    "/api/agent/sessions/[sessionId]/continue",
    true
  );
  if (throttled) return throttled;
  try {
    const { sessionId } = await context.params;
    const input = parseContinueSessionRequest(await readStrictJson(request));
    const service = new AgentControlPlaneService(await getAgentSessionStore());
    return agentSuccess(await service.continueSession(auth.actorId, parseAgentId(sessionId), input), 201);
  } catch (error) {
    return agentErrorResponse(error);
  }
}
