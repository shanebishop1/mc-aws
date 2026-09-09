import { canonicalJson } from "@/lib/agent/canonical-json";
import {
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentCapability,
  type BackupEvaluation,
  type BackupMode,
  type EvaluatedPermissionDecision,
  type ImmutableBoundaryFacts,
  type JsonObject,
  type JsonValue,
  type PermissionDecision,
  type PermissionEvaluationInput,
  type PermissionPolicy,
  type ProposedInvocationSummary,
  type RiskClass,
  type RiskFacts,
  type TargetScope,
  type ToolInvocation,
} from "@/lib/agent/contracts";
import { DEFAULT_PERSISTENT_WORLD_ROOTS, minecraftDestructiveExplanation } from "@/lib/agent/minecraft-security";
import {
  DEFAULT_NETWORK_DOWNLOAD_MAX_BYTES,
  exactNetworkDownloadResource,
  validateNetworkDownloadExpectation,
} from "@/lib/agent/network-download";
import { redactSecretAwareJson, redactSensitiveText } from "@/lib/agent/redaction";
import { agentSchemas } from "@/lib/agent/validators";

const RISK_ORDER: Record<RiskClass, number> = { low: 0, risky: 1, destructive: 2 };

const IMMUTABLE_BOUNDARIES: ReadonlyArray<readonly [keyof ImmutableBoundaryFacts, string]> = [
  ["requestsRoot", "root access"],
  ["requestsLinuxCapabilities", "Linux capabilities"],
  ["administersHostPackagesOrServices", "host package or service administration"],
  ["accessesInstanceMetadata", "instance metadata"],
  ["accessesAwsApisOrCredentials", "AWS APIs or credentials"],
  ["accessesDeploymentSecrets", "deployment secrets"],
  ["accessesBackupProviderSecrets", "backup-provider secrets"],
  ["exposesHarnessOrProviderCredentials", "harness or provider credentials"],
  ["targetImmutableAsset", "an immutable runtime or profile asset"],
  ["targetOutsideAllowedRoots", "path outside the workspace or session scratch area"],
];

export const NO_IMMUTABLE_BOUNDARY_VIOLATIONS: ImmutableBoundaryFacts = Object.freeze({
  requestsRoot: false,
  requestsLinuxCapabilities: false,
  administersHostPackagesOrServices: false,
  accessesInstanceMetadata: false,
  accessesAwsApisOrCredentials: false,
  accessesDeploymentSecrets: false,
  accessesBackupProviderSecrets: false,
  exposesHarnessOrProviderCredentials: false,
  targetImmutableAsset: false,
  targetOutsideAllowedRoots: false,
});

export const LOW_RISK_FACTS: RiskFacts = Object.freeze({
  mutation: false,
  consoleMutation: false,
  executableOrConfigurationChange: false,
  bulkOperation: false,
  worldChange: false,
  permissionChange: false,
  broadMutation: false,
});

export function classifyRisk(capability: AgentCapability, facts: RiskFacts): RiskClass {
  if (capability === "workspace.delete" || facts.worldChange || facts.permissionChange || facts.broadMutation) {
    return "destructive";
  }
  if (
    facts.mutation ||
    facts.consoleMutation ||
    facts.executableOrConfigurationChange ||
    facts.bulkOperation ||
    capability === "shell.execute" ||
    capability === "network.outbound" ||
    capability === "extension.load" ||
    capability === "maintenance.apply"
  ) {
    return "risky";
  }
  return "low";
}

export function raiseRisk(current: RiskClass, hookRisk: RiskClass): RiskClass {
  return RISK_ORDER[hookRisk] > RISK_ORDER[current] ? hookRisk : current;
}

export function findImmutableBoundaryViolation(facts: ImmutableBoundaryFacts): string | undefined {
  return IMMUTABLE_BOUNDARIES.find(([key]) => facts[key])?.[1];
}

/**
 * Derives the effective rule used by both executor evaluation and durable authorization.
 * Destructive work always returns to an exact operator decision unless the base rule denies it.
 */
export function permissionDecisionForRisk(
  policy: PermissionPolicy,
  capability: AgentCapability,
  risk: RiskClass
): PermissionDecision | undefined {
  const configured = policy.rules.find((candidate) => candidate.capability === capability)?.decision;
  if (risk === "destructive" && (configured === "allow" || configured === "ask-once")) {
    return "ask-always";
  }
  return configured;
}

function scopesEqual(left: TargetScope, right: TargetScope): boolean {
  return left.kind === right.kind && left.normalizedTarget === right.normalizedTarget;
}

function matchesScope(
  approval: AgentApproval,
  policyId: string,
  policyRevision: number,
  actorId: string,
  sessionId: string,
  capability: AgentCapability,
  targetScope: TargetScope,
  risk: RiskClass
): boolean {
  return (
    approval.actorId === actorId &&
    approval.sessionId === sessionId &&
    approval.policyId === policyId &&
    approval.policyRevision === policyRevision &&
    approval.scope.capability === capability &&
    approval.scope.risk === risk &&
    scopesEqual(approval.scope.targetScope, targetScope)
  );
}

function newestFirst(approvals: AgentApproval[]): AgentApproval[] {
  return [...approvals].sort((left, right) => {
    const timeComparison = (right.decidedAt ?? "").localeCompare(left.decidedAt ?? "");
    return timeComparison || right.approvalId.localeCompare(left.approvalId);
  });
}

function baseDecision(input: PermissionEvaluationInput): Omit<EvaluatedPermissionDecision, "outcome" | "reason"> {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    capability: input.capability,
    targetScope: input.targetScope,
    risk: input.risk,
  };
}

function validateApprovalSet(approvals: AgentApproval[]): void {
  const approvalIds = new Set<string>();
  for (const approval of approvals) {
    agentSchemas.agentApproval.parse(approval);
    if (approvalIds.has(approval.approvalId)) throw new Error("Duplicate approval ID rejected");
    approvalIds.add(approval.approvalId);
  }
}

export function evaluatePermission(input: PermissionEvaluationInput): EvaluatedPermissionDecision {
  agentSchemas.permissionPolicy.parse(input.policy);
  agentSchemas.targetScope.parse(input.targetScope);
  if (!/^[a-f0-9]{64}$/.test(input.invocationDigest))
    throw new Error("invocationDigest must be a lowercase SHA-256 digest");
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error("now must be a valid ISO timestamp");
  const common = baseDecision(input);
  validateApprovalSet(input.approvals);
  const boundary = findImmutableBoundaryViolation(input.immutableBoundary);
  if (boundary) {
    return {
      ...common,
      outcome: "deny",
      reason: `Immutable boundary denied ${boundary}.`,
      immutableBoundary: boundary,
    };
  }

  const configuredRule = input.policy.rules.find((candidate) => candidate.capability === input.capability);
  const decision = permissionDecisionForRisk(input.policy, input.capability, input.risk);
  if (!configuredRule || !decision)
    return { ...common, outcome: "deny", reason: "Policy has no rule for this capability." };
  if (decision === "allow") return { ...common, outcome: "allow", reason: "Capability is allowed by policy." };
  if (decision === "deny") return { ...common, outcome: "deny", reason: "Capability is denied by policy." };

  const matching = newestFirst(input.approvals).filter((approval) => {
    if (
      !matchesScope(
        approval,
        input.policy.policyId,
        input.policy.revision,
        input.actorId,
        input.sessionId,
        input.capability,
        input.targetScope,
        input.risk
      )
    )
      return false;
    if (decision === "ask-always") {
      return approval.scope.kind === "single-invocation" && approval.invocationDigest === input.invocationDigest;
    }
    return (
      approval.scope.kind === "session-capability" &&
      (approval.decision === "approved" ||
        approval.decision === "revoked" ||
        approval.invocationDigest === input.invocationDigest)
    );
  });
  const approval = matching[0];
  if (!approval) {
    return {
      ...common,
      outcome: "require-approval",
      reason: "No matching approval exists.",
      approvalKind: decision,
    };
  }
  if (approval.decision === "revoked") {
    return {
      ...common,
      outcome: "require-approval",
      reason: "The session approval was revoked.",
      approvalKind: decision,
    };
  }
  if (approval.decision === "denied" || approval.decision === "cancelled") {
    return {
      ...common,
      outcome: "deny",
      reason: `Approval was ${approval.decision}.`,
      approvalId: approval.approvalId,
    };
  }
  if (approval.decision === "pending") {
    return {
      ...common,
      outcome: "require-approval",
      reason: "Approval is pending.",
      approvalKind: decision,
      approvalId: approval.approvalId,
    };
  }
  if (Date.parse(approval.expiresAt) <= now) {
    return { ...common, outcome: "require-approval", reason: "Approval expired.", approvalKind: decision };
  }
  if (decision === "ask-always" && approval.consumedAt) {
    return {
      ...common,
      outcome: "require-approval",
      reason: "Single-invocation approval was already consumed; replay rejected.",
      approvalKind: decision,
    };
  }
  return { ...common, outcome: "allow", reason: "A matching approval is active.", approvalId: approval.approvalId };
}

export function consumeSingleInvocationApproval(
  approval: AgentApproval,
  sessionId: string,
  invocationDigest: string,
  now: string
): AgentApproval {
  agentSchemas.agentApproval.parse(approval);
  if (approval.scope.kind !== "single-invocation") throw new Error("Session-capability approvals are not consumed");
  if (approval.sessionId !== sessionId) throw new Error("Approval belongs to another session");
  if (approval.invocationDigest !== invocationDigest) throw new Error("Approval digest does not match the invocation");
  if (approval.decision !== "approved") throw new Error("Only approved approvals can be consumed");
  if (approval.consumedAt) throw new Error("Approval replay rejected");
  const consumedAt = new Date(now);
  if (!Number.isFinite(consumedAt.getTime())) throw new Error("now must be a valid timestamp");
  if (consumedAt.getTime() >= Date.parse(approval.expiresAt)) throw new Error("Approval expired");
  return { ...approval, consumedAt: consumedAt.toISOString() };
}

async function sha256(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createInvocationDigest(invocation: ToolInvocation): Promise<string> {
  const parsed = agentSchemas.toolInvocation.parse(invocation);
  return sha256(parsed as unknown as JsonValue);
}

function bounded(value: string, max = 4_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

function downloadInvocationArguments(
  invocation: ToolInvocation,
  redacted: JsonObject,
  exactSecrets: readonly string[]
): JsonObject {
  const url = typeof invocation.arguments.url === "string" ? invocation.arguments.url : "";
  const sourceResource = redactSensitiveText(exactNetworkDownloadResource(url), exactSecrets);
  const expectedSha256 = redacted.expectedSha256;
  const expectedBytes = redacted.expectedBytes;
  validateNetworkDownloadExpectation({ expectedSha256, expectedBytes } as {
    expectedSha256: string;
    expectedBytes: number;
  });
  return {
    sourceResource,
    destination:
      typeof redacted.destination === "string"
        ? bounded(redacted.destination)
        : invocation.targetScope.normalizedTarget,
    maxBytes: typeof redacted.maxBytes === "number" ? redacted.maxBytes : DEFAULT_NETWORK_DOWNLOAD_MAX_BYTES,
    expectedSha256,
    expectedBytes,
  };
}

function ordinaryInvocationArguments(redacted: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (key === "content" || key === "patch") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      result[key] = bounded(text, 8_000);
      result[`${key}Bytes`] = new TextEncoder().encode(text).byteLength;
      if (text.length > 8_000) result[`${key}Truncated`] = true;
      continue;
    }
    result[key] = typeof value === "string" ? bounded(value) : value;
  }
  return result;
}

function invocationArguments(invocation: ToolInvocation, exactSecrets: readonly string[]): JsonObject {
  const redacted = redactSecretAwareJson(invocation.arguments, exactSecrets);
  return invocation.toolId === "network.download"
    ? downloadInvocationArguments(invocation, redacted, exactSecrets)
    : ordinaryInvocationArguments(redacted);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exact redaction and destructive explanations are assembled together for one digest-bound approval summary.
export async function createProposedInvocationSummary(
  invocation: ToolInvocation,
  risk: RiskClass,
  options: {
    exactSecrets?: readonly string[];
    backupFailureStatus?: "failed" | "unavailable";
    targetScope?: TargetScope;
    persistentWorldRoots?: readonly string[];
  } = {}
): Promise<ProposedInvocationSummary> {
  const parsed = agentSchemas.toolInvocation.parse(invocation);
  const invocationDigest = await createInvocationDigest(parsed);
  const sanitizedArguments = invocationArguments(parsed, options.exactSecrets ?? []);
  const rawDiff =
    typeof parsed.arguments.diff === "string"
      ? parsed.arguments.diff
      : typeof parsed.arguments.patch === "string"
        ? parsed.arguments.patch
        : typeof parsed.arguments.content === "string"
          ? `Proposed complete content for ${parsed.targetScope.normalizedTarget}:\n${parsed.arguments.content}`
          : undefined;
  const destructiveExplanation =
    risk === "destructive"
      ? minecraftDestructiveExplanation(parsed, options.persistentWorldRoots ?? DEFAULT_PERSISTENT_WORLD_ROOTS)
      : undefined;
  const diffSummary =
    typeof rawDiff === "string"
      ? bounded(
          [destructiveExplanation, redactSensitiveText(rawDiff, options.exactSecrets)].filter(Boolean).join("\n\n"),
          8_000
        )
      : typeof parsed.arguments.path === "string" || typeof parsed.arguments.destination === "string"
        ? [destructiveExplanation, `File target: ${parsed.targetScope.normalizedTarget}`].filter(Boolean).join("\n\n")
        : destructiveExplanation;
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    invocationId: parsed.invocationId,
    invocationDigest,
    toolId: parsed.toolId,
    capability: parsed.capability,
    targetScope: { ...(options.targetScope ?? parsed.targetScope) },
    risk,
    sanitizedArguments,
    ...(diffSummary ? { diffSummary } : {}),
    ...(options.backupFailureStatus ? { backupFailureStatus: options.backupFailureStatus } : {}),
  };
}

export async function createInvocationSummaryDigest(summary: ProposedInvocationSummary): Promise<string> {
  const parsed = agentSchemas.proposedInvocationSummary.parse(summary);
  return sha256(parsed as unknown as JsonValue);
}

export function evaluateBackup(
  mode: BackupMode,
  risk: RiskClass,
  isMutation: boolean,
  status: "not-requested" | "succeeded" | "failed" | "unavailable" = "not-requested"
): BackupEvaluation {
  const required =
    isMutation &&
    (mode === "before-any-mutation" ||
      (mode === "before-risky" && RISK_ORDER[risk] >= RISK_ORDER.risky) ||
      (mode === "before-destructive" && risk === "destructive"));
  if (!required)
    return { required: false, outcome: "not-required", reason: "Backup policy does not require a backup." };
  if (status === "failed" || status === "unavailable") {
    return {
      required: true,
      outcome: "pause",
      reason: `Required backup ${status}; explicit proceed-or-cancel is required.`,
    };
  }
  if (status === "succeeded") return { required: true, outcome: "proceed", reason: "Required backup completed." };
  return { required: true, outcome: "create-backup", reason: "A backup is required before this mutation." };
}
