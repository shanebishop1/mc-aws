import {
  agentErrorResponse,
  agentSuccess,
  authenticateAgentAdmin,
  enforceAgentRateLimit,
} from "@/lib/agent/control-plane/http";
import { AgentControlPlaneService } from "@/lib/agent/control-plane/service";
import { parseAgentId } from "@/lib/agent/control-plane/validation";
import { getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

interface Context {
  params: Promise<{ sessionId: string }>;
}

export async function GET(request: NextRequest, context: Context): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(request, auth.actorId, "/api/agent/sessions/[sessionId]", false);
  if (throttled) return throttled;
  try {
    const { sessionId } = await context.params;
    const service = new AgentControlPlaneService(await getAgentSessionStore());
    return agentSuccess(await service.getSession(auth.actorId, parseAgentId(sessionId)));
  } catch (error) {
    return agentErrorResponse(error);
  }
}
