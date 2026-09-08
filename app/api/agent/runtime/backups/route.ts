import {
  AgentRuntimeService,
  agentRuntimeError,
  agentRuntimeSuccess,
  authenticateAgentRuntime,
  enforceRuntimeRateLimit,
  getRuntimeBackupControlAdapter,
  parseRuntimeBackupRequest,
  readRuntimeJson,
} from "@/lib/agent/runtime";
import { AgentStateConflictError, getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRuntime(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceRuntimeRateLimit(auth.runtimeId, "/api/agent/runtime/backups");
  if (throttled) return throttled;
  try {
    const input = parseRuntimeBackupRequest(await readRuntimeJson(request));
    const adapter = getRuntimeBackupControlAdapter();
    if (input.action === "availability") {
      return agentRuntimeSuccess({
        schemaVersion: 1,
        availability: await adapter.evaluateAvailability(),
      });
    }
    if (input.action === "finalize") {
      return agentRuntimeSuccess(await adapter.finalize({ ...input, runtimeId: auth.runtimeId }, request.signal));
    }
    if (input.action === "renew") {
      const authorization = input.authorization;
      const service = new AgentRuntimeService(await getAgentSessionStore());
      await service.assertBackupBinding(auth.runtimeId, {
        schemaVersion: 1,
        action: "create",
        leaseId: authorization.leaseId,
        leaseGeneration: authorization.leaseGeneration,
        sessionId: authorization.sessionId,
        taskId: authorization.taskId,
        invocationId: authorization.invocationId,
        invocationDigest: authorization.invocationDigest,
      });
      return agentRuntimeSuccess(await adapter.renew({ ...input, runtimeId: auth.runtimeId }, request.signal));
    }
    const service = new AgentRuntimeService(await getAgentSessionStore());
    // This authority check must precede the durable operation lookup. A completed
    // backup is only reusable by the still-current invocation; operation
    // idempotency is not an authority grant.
    await service.assertBackupBinding(auth.runtimeId, input);
    const recovered = await adapter.recoverExisting({ ...input, runtimeId: auth.runtimeId }, request.signal);
    if (recovered) return agentRuntimeSuccess(recovered);
    return agentRuntimeSuccess(
      await adapter.startOrPoll({ ...input, runtimeId: auth.runtimeId }, request.signal, async () => {
        try {
          await service.assertBackupBinding(auth.runtimeId, input);
          return true;
        } catch (error) {
          if (error instanceof AgentStateConflictError) return false;
          throw error;
        }
      })
    );
  } catch (error) {
    return agentRuntimeError(error);
  }
}
