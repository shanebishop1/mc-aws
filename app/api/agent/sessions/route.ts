import {
  agentErrorResponse,
  agentSuccess,
  authenticateAgentAdmin,
  enforceAgentRateLimit,
} from "@/lib/agent/control-plane/http";
import { AgentControlPlaneService } from "@/lib/agent/control-plane/service";
import { parseCreateSessionRequest, readStrictJson } from "@/lib/agent/control-plane/validation";
import { getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(request, auth.actorId, "/api/agent/sessions", false);
  if (throttled) return throttled;
  try {
    const service = new AgentControlPlaneService(await getAgentSessionStore());
    return agentSuccess(await service.listSessions(auth.actorId));
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(request, auth.actorId, "/api/agent/sessions", true);
  if (throttled) return throttled;
  try {
    const input = parseCreateSessionRequest(await readStrictJson(request));
    const service = new AgentControlPlaneService(await getAgentSessionStore());
    return agentSuccess(await service.createSession(auth.actorId, input), 201);
  } catch (error) {
    return agentErrorResponse(error);
  }
}
