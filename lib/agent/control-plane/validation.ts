import {
  AGENT_CAPABILITIES,
  type AgentCapability,
  type BackupMode,
  type CapabilityRule,
  type PermissionDecision,
  type PermissionPresetName,
} from "@/lib/agent/contracts";
import type {
  AgentApprovalDecisionRequestDto,
  AgentRevisionMutationRequestDto,
  ContinueAgentSessionRequestDto,
  CreateAgentSessionRequestDto,
} from "@/lib/agent/control-plane/contracts";
import { PERMISSION_PRESETS } from "@/lib/agent/presets";

export const AGENT_API_BODY_LIMIT_BYTES = 12_000;
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const PRESETS = new Set<PermissionPresetName>(["copilot", "maintainer", "autopilot", "custom"]);
const DECISIONS = new Set<PermissionDecision>(["allow", "ask-once", "ask-always", "deny"]);
const BACKUP_MODES = new Set<BackupMode>(["never", "before-destructive", "before-risky", "before-any-mutation"]);

export class AgentApiValidationError extends Error {
  constructor(message = "Request is invalid") {
    super(message);
    this.name = "AgentApiValidationError";
  }
}

function record(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentApiValidationError();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || required.some((key) => !(key in result))) {
    throw new AgentApiValidationError();
  }
  return result;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !AGENT_ID_PATTERN.test(value)) throw new AgentApiValidationError();
  return value;
}

function revision(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new AgentApiValidationError();
  return value as number;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) throw new AgentApiValidationError();
  return value;
}

function reason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 500 || value.trim().length === 0) throw new AgentApiValidationError();
  return value.trim();
}

function rules(value: unknown): CapabilityRule[] {
  if (!Array.isArray(value) || value.length !== AGENT_CAPABILITIES.length) throw new AgentApiValidationError();
  const parsed = value.map((item) => {
    const rule = record(item, ["schemaVersion", "capability", "decision"]);
    if (rule.schemaVersion !== 1 || !AGENT_CAPABILITIES.includes(rule.capability as AgentCapability)) {
      throw new AgentApiValidationError();
    }
    if (!DECISIONS.has(rule.decision as PermissionDecision)) throw new AgentApiValidationError();
    return {
      schemaVersion: 1 as const,
      capability: rule.capability as AgentCapability,
      decision: rule.decision as PermissionDecision,
    };
  });
  if (new Set(parsed.map((rule) => rule.capability)).size !== AGENT_CAPABILITIES.length) {
    throw new AgentApiValidationError();
  }
  return parsed;
}

export async function readStrictJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AGENT_API_BODY_LIMIT_BYTES) throw new AgentApiValidationError();
  if (!request.body) throw new AgentApiValidationError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AGENT_API_BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new AgentApiValidationError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AgentApiValidationError) throw error;
    throw new AgentApiValidationError();
  }
}

export function parseCreateSessionRequest(value: unknown): CreateAgentSessionRequestDto {
  const body = record(value, [
    "schemaVersion",
    "expectedRevision",
    "idempotencyKey",
    "task",
    "providerProfileId",
    "model",
    "policy",
  ]);
  if (body.schemaVersion !== 1 || revision(body.expectedRevision, 0) !== 0) throw new AgentApiValidationError();
  if (typeof body.task !== "string" || body.task.trim().length === 0 || body.task.length > 8_000) {
    throw new AgentApiValidationError();
  }
  const policy = record(body.policy, ["schemaVersion", "preset", "rules", "backupMode"]);
  if (
    policy.schemaVersion !== 1 ||
    !PRESETS.has(policy.preset as PermissionPresetName) ||
    !BACKUP_MODES.has(policy.backupMode as BackupMode)
  ) {
    throw new AgentApiValidationError();
  }
  const model = typeof body.model === "string" && MODEL_PATTERN.test(body.model) ? body.model : null;
  if (!model) throw new AgentApiValidationError();
  const parsedRules = rules(policy.rules);
  const preset = policy.preset as PermissionPresetName;
  const backupMode = policy.backupMode as BackupMode;
  if (preset !== "custom") {
    const canonical = PERMISSION_PRESETS[preset];
    if (
      canonical.backupMode !== backupMode ||
      canonical.rules.some(
        (canonicalRule) =>
          parsedRules.find((candidate) => candidate.capability === canonicalRule.capability)?.decision !==
          canonicalRule.decision
      )
    ) {
      throw new AgentApiValidationError();
    }
  }
  return {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: idempotencyKey(body.idempotencyKey),
    task: body.task,
    providerProfileId: id(body.providerProfileId),
    model,
    policy: {
      schemaVersion: 1,
      preset,
      rules: parsedRules,
      backupMode,
    },
  };
}

export function parseRevisionMutation(value: unknown): AgentRevisionMutationRequestDto {
  const body = record(
    value,
    ["schemaVersion", "expectedRevision", "idempotencyKey", "reason"],
    ["schemaVersion", "expectedRevision", "idempotencyKey"]
  );
  if (body.schemaVersion !== 1) throw new AgentApiValidationError();
  return {
    schemaVersion: 1,
    expectedRevision: revision(body.expectedRevision, 1),
    idempotencyKey: idempotencyKey(body.idempotencyKey),
    ...(body.reason === undefined ? {} : { reason: reason(body.reason) }),
  };
}

export function parseContinueSessionRequest(value: unknown): ContinueAgentSessionRequestDto {
  const body = record(value, [
    "schemaVersion",
    "expectedRevision",
    "idempotencyKey",
    "task",
    "providerProfileId",
    "model",
  ]);
  if (
    body.schemaVersion !== 1 ||
    typeof body.task !== "string" ||
    body.task.trim().length === 0 ||
    body.task.length > 8_000 ||
    typeof body.model !== "string" ||
    !MODEL_PATTERN.test(body.model)
  ) {
    throw new AgentApiValidationError();
  }
  return {
    schemaVersion: 1,
    expectedRevision: revision(body.expectedRevision, 1),
    idempotencyKey: idempotencyKey(body.idempotencyKey),
    task: body.task.trim(),
    providerProfileId: id(body.providerProfileId),
    model: body.model,
  };
}

export function parseApprovalDecision(value: unknown): AgentApprovalDecisionRequestDto {
  const body = record(
    value,
    ["schemaVersion", "expectedRevision", "idempotencyKey", "decision", "reason"],
    ["schemaVersion", "expectedRevision", "idempotencyKey", "decision"]
  );
  const base = parseRevisionMutation({
    schemaVersion: body.schemaVersion,
    expectedRevision: body.expectedRevision,
    idempotencyKey: body.idempotencyKey,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
  });
  if (body.decision !== "approve" && body.decision !== "deny") throw new AgentApiValidationError();
  return { ...base, decision: body.decision };
}

export function parseAgentId(value: string): string {
  return id(value);
}
