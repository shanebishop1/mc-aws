import type { AgentEvent, BackupMode, CapabilityRule, PermissionPresetName } from "@/lib/agent/contracts";
import type {
  AgentApprovalDecisionRequestDto,
  AgentRevisionMutationRequestDto,
  ContinueAgentSessionRequestDto,
  CreateAgentSessionRequestDto,
  PublicAgentSessionDetailDto,
  PublicAgentSessionSummaryDto,
} from "@/lib/agent/control-plane/contracts";
import type { PublicAgentProviderCatalogDto } from "@/lib/agent/control-plane/provider-catalog";
import { agentSchemas } from "@/lib/agent/validators";
import { ClientApiError } from "@/lib/client-api";

const MAX_SSE_BUFFER_CHARS = 1_000_000;

interface AgentApiEnvelope<T> {
  success: true;
  data: T;
  timestamp: string;
}

export interface NewAgentSessionInput {
  task: string;
  preset: PermissionPresetName;
  rules: CapabilityRule[];
  backupMode: BackupMode;
  idempotencyKey: string;
  providerProfileId: string;
  model: string;
}

export type AgentStreamMessage =
  | { type: "event"; event: AgentEvent }
  | { type: "replay-truncated"; retainedFromSequence: number }
  | { type: "stream-error"; message: string };

export const agentQueryKeys = {
  sessions: ["agent", "sessions"] as const,
  session: (sessionId: string) => ["agent", "sessions", sessionId] as const,
  providers: ["agent", "providers"] as const,
};

async function agentJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? ((payload as { error: string }).error as string)
        : `Agent request failed (${response.status})`;
    throw new ClientApiError(message, response.status);
  }
  if (!payload || typeof payload !== "object" || (payload as { success?: unknown }).success !== true) {
    throw new ClientApiError("Agent response was invalid", response.status);
  }
  return (payload as AgentApiEnvelope<T>).data;
}

export function fetchAgentSessions(): Promise<PublicAgentSessionSummaryDto[]> {
  return agentJson("/api/agent/sessions");
}

export function fetchAgentProviderCatalog(): Promise<PublicAgentProviderCatalogDto> {
  return agentJson("/api/agent/providers");
}

export function fetchAgentSession(sessionId: string): Promise<PublicAgentSessionDetailDto> {
  return agentJson(`/api/agent/sessions/${encodeURIComponent(sessionId)}`);
}

export function createAgentSession(input: NewAgentSessionInput): Promise<PublicAgentSessionDetailDto> {
  const request: CreateAgentSessionRequestDto = {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: input.idempotencyKey,
    task: input.task,
    providerProfileId: input.providerProfileId,
    model: input.model,
    policy: {
      schemaVersion: 1,
      preset: input.preset,
      rules: input.rules,
      backupMode: input.backupMode,
    },
  };
  return agentJson("/api/agent/sessions", { method: "POST", body: JSON.stringify(request) });
}

export function continueAgentSession(
  sessionId: string,
  input: Omit<ContinueAgentSessionRequestDto, "schemaVersion">
): Promise<PublicAgentSessionDetailDto> {
  return agentJson(`/api/agent/sessions/${encodeURIComponent(sessionId)}/continue`, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, ...input } satisfies ContinueAgentSessionRequestDto),
  });
}

function revisionRequest(revision: number, idempotencyKey: string, reason: string): AgentRevisionMutationRequestDto {
  return { schemaVersion: 1, expectedRevision: revision, idempotencyKey, reason };
}

export function cancelAgentSession(
  sessionId: string,
  revision: number,
  idempotencyKey: string
): Promise<PublicAgentSessionDetailDto> {
  return agentJson(`/api/agent/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    body: JSON.stringify(revisionRequest(revision, idempotencyKey, "cancelled from the agent workspace")),
  });
}

export function decideAgentApproval(
  sessionId: string,
  approvalId: string,
  revision: number,
  decision: "approve" | "deny",
  idempotencyKey: string
): Promise<PublicAgentSessionDetailDto> {
  const request: AgentApprovalDecisionRequestDto = {
    ...revisionRequest(revision, idempotencyKey, `${decision}d from the agent workspace`),
    decision,
  };
  return agentJson(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
    { method: "POST", body: JSON.stringify(request) }
  );
}

export function revokeAgentApproval(
  sessionId: string,
  approvalId: string,
  revision: number,
  idempotencyKey: string
): Promise<PublicAgentSessionDetailDto> {
  return agentJson(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify(revisionRequest(revision, idempotencyKey, "revoked from the agent workspace")),
    }
  );
}

// A complete strict SSE field dispatch is clearer kept at this trust boundary than split into partial parsers.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: parses the finite set of supported SSE fields and event variants.
export function parseAgentSseBlock(block: string): AgentStreamMessage | null {
  let eventType = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventType = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return { type: "stream-error", message: "The event stream returned malformed data." };
  }
  if (eventType === "agent" && parsed && typeof parsed === "object") {
    const event = agentSchemas.agentEvent.safeParse(parsed);
    return event.success
      ? { type: "event", event: event.data }
      : { type: "stream-error", message: "The event stream returned an invalid event." };
  }
  if (eventType === "replay-truncated" && parsed && typeof parsed === "object") {
    const retained = (parsed as { retainedFromSequence?: unknown }).retainedFromSequence;
    if (typeof retained === "number") return { type: "replay-truncated", retainedFromSequence: retained };
  }
  if (eventType === "stream-error") return { type: "stream-error", message: "The event stream is unavailable." };
  return null;
}

/** Reads one finite SSE response. Callers reconnect with the last cursor returned by an event. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Finite SSE framing validates each bounded protocol branch in one parser.
export async function readAgentEventStream(
  sessionId: string,
  lastEventId: string | undefined,
  onMessage: (message: AgentStreamMessage) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/events`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: lastEventId ? { "Last-Event-ID": lastEventId } : undefined,
    signal,
  });
  if (!response.ok || !response.body)
    throw new ClientApiError(`Event stream failed (${response.status})`, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      await reader.cancel();
      throw new ClientApiError("The event stream exceeded its safety limit.", 502);
    }
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const message = parseAgentSseBlock(block);
      if (message) onMessage(message);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const message = parseAgentSseBlock(buffer);
    if (message) onMessage(message);
  }
}
