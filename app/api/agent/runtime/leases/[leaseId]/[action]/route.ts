import {
  AgentRuntimeService,
  AgentRuntimeValidationError,
  agentRuntimeError,
  agentRuntimeSuccess,
  authenticateAgentRuntime,
  enforceRuntimeRateLimit,
  getRuntimeBackupControlAdapter,
  parseApproval,
  parseApprovalConsumption,
  parseDecisionPoll,
  parseEvents,
  parseInvocationAuthorization,
  parseLeaseMutation,
  parseRecoveryPublication,
  parseRenew,
  parseStatus,
  readRuntimeJson,
} from "@/lib/agent/runtime";
import { getAgentSessionStore } from "@/lib/agent/state";
import type { NextRequest, NextResponse } from "next/server";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIONS = new Set([
  "ack",
  "renew",
  "events",
  "recovery",
  "approval",
  "consume-approval",
  "authorize-invocation",
  "status",
  "decisions",
]);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Route action dispatch keeps authentication, rate limits, parsing, and service boundaries explicit.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ leaseId: string; action: string }> }
): Promise<NextResponse> {
  const auth = await authenticateAgentRuntime(request);
  if (auth instanceof Response) return auth as NextResponse;
  const { leaseId, action } = await context.params;
  if (!ID.test(leaseId) || !ACTIONS.has(action)) return agentRuntimeError(new AgentRuntimeValidationError());
  const throttled = await enforceRuntimeRateLimit(
    auth.runtimeId,
    `/api/agent/runtime/leases/:leaseId/${action}`,
    action === "events" || action === "recovery"
  );
  if (throttled) return throttled;
  try {
    const body = await readRuntimeJson(request);
    const receiptVerifier = action === "recovery" ? getRuntimeBackupControlAdapter() : undefined;
    const service = new AgentRuntimeService(await getAgentSessionStore(), {
      ...(receiptVerifier?.verifyTerminalReceipt
        ? { verifyRecoveryReceipt: (receipt) => receiptVerifier.verifyTerminalReceipt!(receipt) }
        : {}),
    });
    if (action === "ack") {
      const result = await service.acknowledge(auth.runtimeId, leaseId, parseLeaseMutation(body));
      return agentRuntimeSuccess({ schemaVersion: 1, revision: result.state.revision });
    }
    if (action === "renew") {
      const result = await service.renew(auth.runtimeId, leaseId, parseRenew(body));
      const task = result.state.tasks.find((candidate) => candidate.lease?.leaseId === leaseId);
      return agentRuntimeSuccess({
        schemaVersion: 1,
        revision: result.state.revision,
        expiresAt: task?.lease?.expiresAt,
      });
    }
    if (action === "events") {
      return agentRuntimeSuccess(await service.publishEvents(auth.runtimeId, leaseId, parseEvents(body)));
    }
    if (action === "recovery") {
      return agentRuntimeSuccess(
        await service.publishRecovery(auth.runtimeId, leaseId, parseRecoveryPublication(body))
      );
    }
    if (action === "approval") {
      const result = await service.publishApproval(auth.runtimeId, leaseId, parseApproval(body));
      return agentRuntimeSuccess({ schemaVersion: 1, revision: result.state.revision });
    }
    if (action === "consume-approval") {
      const consumption = parseApprovalConsumption(body);
      const result = await service.consumeApproval(auth.runtimeId, leaseId, consumption);
      const approval = result.state.approvals.find((candidate) => candidate.approvalId === consumption.approvalId);
      return agentRuntimeSuccess({
        schemaVersion: 1,
        revision: result.state.revision,
        consumedAt: approval?.consumedAt,
      });
    }
    if (action === "authorize-invocation") {
      return agentRuntimeSuccess(
        await service.authorizeInvocation(auth.runtimeId, leaseId, parseInvocationAuthorization(body))
      );
    }
    if (action === "status") {
      const result = await service.publishStatus(auth.runtimeId, leaseId, parseStatus(body));
      return agentRuntimeSuccess({
        schemaVersion: 1,
        revision: result.state.revision,
        status: result.state.session.status,
      });
    }
    return agentRuntimeSuccess(
      await service.waitForDecision(auth.runtimeId, leaseId, parseDecisionPoll(body), request.signal)
    );
  } catch (error) {
    return agentRuntimeError(error);
  }
}
