import {
  agentErrorResponse,
  agentSuccess,
  authenticateAgentAdmin,
  enforceAgentRateLimit,
} from "@/lib/agent/control-plane/http";
import { getPublicAgentProviderCatalog } from "@/lib/agent/control-plane/provider-catalog";
import type { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(request, auth.actorId, "/api/agent/providers", false);
  if (throttled) return throttled;
  try {
    return agentSuccess(getPublicAgentProviderCatalog());
  } catch (error) {
    return agentErrorResponse(error);
  }
}
