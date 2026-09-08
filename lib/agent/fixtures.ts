import {
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentEvent,
  type AgentSession,
  type AgentTurn,
  type ApprovalScope,
  type CapabilityRule,
  type EvaluatedPermissionDecision,
  type EvidenceReference,
  type HarnessMetadata,
  type HookDefinition,
  type PermissionPolicy,
  type PermissionPreset,
  type ProviderConfiguration,
  type ProviderDefinition,
  type RedactedEventPayload,
  type SkillManifest,
  type TargetScope,
  type ToolCancellation,
  type ToolDefinition,
  type ToolInvocation,
  type ToolProgress,
  type ToolResult,
} from "@/lib/agent/contracts";
import { PERMISSION_PRESETS, createCustomPreset, createPolicyFromPreset } from "@/lib/agent/presets";

const timestamp = "2026-09-02T12:00:00.000Z";

const targetScope: TargetScope = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  kind: "workspace",
  normalizedTarget: "config/server.properties",
};

const evidenceReference: EvidenceReference = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  evidenceId: "evidence-1",
  kind: "diff",
  uri: "agent-evidence://session-1/evidence-1",
  description: "Redacted configuration diff",
};

const toolDefinition: ToolDefinition = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  toolId: "workspace.patch",
  displayName: "Patch workspace file",
  description: "Apply an exact patch inside the mounted server workspace.",
  capability: "workspace.write",
  sideEffect: "write",
  inputSchema: { type: "object", required: ["path", "patch"] },
};

const toolInvocation: ToolInvocation = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  invocationId: "invocation-1",
  sessionId: "session-1",
  toolId: "workspace.patch",
  capability: "workspace.write",
  targetScope,
  arguments: { path: "config/server.properties", patch: "motd=Welcome" },
  requestedAt: timestamp,
};

const toolProgress: ToolProgress = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  invocationId: "invocation-1",
  sequence: 1,
  timestamp,
  message: "Validating patch",
  percent: 50,
};

const toolResult: ToolResult = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  invocationId: "invocation-1",
  status: "succeeded",
  completedAt: timestamp,
  summary: "Updated one configuration property.",
  output: { changed: true },
  evidence: [evidenceReference],
};

const toolCancellation: ToolCancellation = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  invocationId: "invocation-1",
  requestedAt: timestamp,
  reason: "Operator cancelled the task.",
};

const skillManifest: SkillManifest = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  skillId: "mc-aws.inspect-config",
  version: "1.0.0",
  displayName: "Inspect Minecraft configuration",
  description: "Inspects server configuration and reports evidence.",
  compatibility: { contractSchemaVersions: [1], platforms: ["mc-aws-agent"] },
  instructions: "Read configuration before proposing changes.",
  resources: ["resources/configuration.md"],
  requestedTools: ["workspace.patch"],
  provenance: { source: "mc-aws", reference: "lib/agent/fixtures", integrity: "sha256:fixture" },
};

const hookDefinition: HookDefinition = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  hookId: "mc-aws.backup-before-risk",
  hookPoint: "backup",
  priority: 100,
  failureBehavior: "fail-closed",
  handlerRef: "backup-before-risk",
};

const providerDefinition: ProviderDefinition = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  providerId: "openrouter",
  kind: "openrouter",
  displayName: "OpenRouter",
  endpoint: "https://openrouter.ai/api/v1",
  supportedFeatures: ["streaming", "tools", "reasoning-summary"],
};

const providerConfiguration: ProviderConfiguration = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  profileId: "operator-openrouter",
  providerId: "openrouter",
  model: "example/model",
  credentialRef: "secret-ref:providers/openrouter/operator",
  timeoutMs: 60_000,
};

const capabilityRule: CapabilityRule = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  capability: "workspace.write",
  decision: "ask-once",
};

const permissionPolicy: PermissionPolicy = createPolicyFromPreset("maintainer", "policy-1");
const permissionPreset: PermissionPreset = createCustomPreset(PERMISSION_PRESETS.maintainer);

const approvalScope: ApprovalScope = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  kind: "session-capability",
  capability: "workspace.write",
  targetScope,
  risk: "risky",
};

const agentApproval: AgentApproval = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  approvalId: "approval-1",
  actorId: "admin-1",
  sessionId: "session-1",
  policyId: "policy-1",
  policyRevision: 1,
  invocationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  invocationSummary: {
    schemaVersion: AGENT_SCHEMA_VERSION,
    invocationId: "invocation-1",
    invocationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    toolId: "workspace.patch",
    capability: "workspace.write",
    targetScope,
    risk: "risky",
    sanitizedArguments: { path: "config/server.properties", patch: "motd=Welcome", patchBytes: 12 },
    diffSummary: "File target: config/server.properties",
  },
  invocationSummaryDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  scope: approvalScope,
  expiresAt: "2026-09-02T13:00:00.000Z",
  decision: "approved",
  reason: "Approved configuration edits in this scope.",
  decidedAt: timestamp,
};

const evaluatedPermissionDecision: EvaluatedPermissionDecision = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  outcome: "allow",
  capability: "workspace.write",
  targetScope,
  risk: "risky",
  reason: "A matching approval is active.",
  approvalId: "approval-1",
};

const harnessMetadata: HarnessMetadata = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  adapterId: "fake-harness",
  adapterVersion: "1.0.0",
  providerProfileId: "operator-openrouter",
  providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
  model: "example/model",
};

const agentTurn: AgentTurn = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  turnId: "turn-1",
  kind: "task",
  content: "Inspect and update the MOTD.",
  createdAt: timestamp,
};

const agentSession: AgentSession = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  sessionId: "session-1",
  actorId: "admin-1",
  status: "running",
  createdAt: timestamp,
  updatedAt: timestamp,
  policyId: "policy-1",
  policyRevision: 1,
  harness: harnessMetadata,
  turns: [agentTurn],
};

const redactedEventPayload: RedactedEventPayload = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  redacted: true,
  data: { invocationId: "invocation-1", summary: "Update the server MOTD." },
};

const agentEvent: AgentEvent = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  eventId: "event-1",
  sessionId: "session-1",
  sequence: 1,
  timestamp,
  kind: "tool-proposal",
  payload: redactedEventPayload,
  replayCursor: "session-1:1",
};

export const canonicalAgentFixtures = Object.freeze({
  evidenceReference,
  targetScope,
  toolDefinition,
  toolInvocation,
  toolProgress,
  toolResult,
  toolCancellation,
  skillManifest,
  hookDefinition,
  providerDefinition,
  providerConfiguration,
  capabilityRule,
  permissionPolicy,
  permissionPreset,
  approvalScope,
  agentApproval,
  evaluatedPermissionDecision,
  harnessMetadata,
  agentTurn,
  redactedEventPayload,
  agentSession,
  agentEvent,
});
