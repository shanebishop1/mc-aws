import {
  agentErrorResponse,
  agentSuccess,
  authenticateAgentAdmin,
  enforceAgentRateLimit,
} from "@/lib/agent/control-plane/http";
import { AgentControlPlaneService } from "@/lib/agent/control-plane/service";
import { parseAgentId, parseApprovalDecision, readStrictJson } from "@/lib/agent/control-plane/validation";
import { getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

interface Context {
  params: Promise<{ sessionId: string; approvalId: string }>;
}

export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(
    request,
    auth.actorId,
    "/api/agent/sessions/[sessionId]/approvals/[approvalId]/decision",
    true
  );
  if (throttled) return throttled;
  try {
    const { sessionId, approvalId } = await context.params;
    const input = parseApprovalDecision(await readStrictJson(request));
    const service = new AgentControlPlaneService(await getAgentSessionStore());
    return agentSuccess(
      await service.decideApproval(auth.actorId, parseAgentId(sessionId), parseAgentId(approvalId), input)
    );
  } catch (error) {
    return agentErrorResponse(error);
  }
}
