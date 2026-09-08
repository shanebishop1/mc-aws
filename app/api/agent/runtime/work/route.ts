import {
  AgentRuntimeService,
  agentRuntimeError,
  agentRuntimeSuccess,
  authenticateAgentRuntime,
  enforceRuntimeRateLimit,
  parseWorkLeaseRequest,
  readRuntimeJson,
} from "@/lib/agent/runtime";
import { getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRuntime(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceRuntimeRateLimit(auth.runtimeId, "/api/agent/runtime/work");
  if (throttled) return throttled;
  try {
    const input = parseWorkLeaseRequest(await readRuntimeJson(request));
    const service = new AgentRuntimeService(await getAgentSessionStore());
    return agentRuntimeSuccess(await service.leaseWork(auth.runtimeId, input, request.signal));
  } catch (error) {
    return agentRuntimeError(error);
  }
}
