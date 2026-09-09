export const AGENT_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const AGENT_CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "shell.execute",
  "console.execute",
  "network.outbound",
  "backup.create",
  "extension.load",
  "maintenance.apply",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];
export type PermissionDecision = "allow" | "ask-once" | "ask-always" | "deny";
export type PermissionPresetName = "copilot" | "maintainer" | "autopilot" | "custom";
export type BackupMode = "never" | "before-destructive" | "before-risky" | "before-any-mutation";
export type RiskClass = "low" | "risky" | "destructive";

export interface EvidenceReference {
  schemaVersion: 1;
  evidenceId: string;
  kind: "file" | "command-output" | "console-output" | "backup" | "diff";
  uri: string;
  description: string;
}

export interface TargetScope {
  schemaVersion: 1;
  kind: "workspace" | "session-scratch" | "console" | "network";
  normalizedTarget: string;
}

export type SideEffectClass = "read" | "write" | "delete" | "execute" | "network" | "backup" | "extension";

export type ShellMode = "read-only" | "staged-write";
export type ShellChangeOperation = "replace" | "delete";

/** The only command authority exposed by the shell tool. */
export interface ShellChange {
  operation: ShellChangeOperation;
  /** Canonical workspace-relative regular-file target. */
  path: string;
}

export interface ShellCommand {
  mode: ShellMode;
  /** A bounded POSIX shell program, evaluated by the reviewed shell toolchain. */
  command: string;
  timeoutMs: number;
  change?: ShellChange;
}

export interface ToolDefinition {
  schemaVersion: 1;
  toolId: string;
  displayName: string;
  description: string;
  capability: AgentCapability;
  sideEffect: SideEffectClass;
  inputSchema: JsonObject;
}

export interface ToolInvocation {
  schemaVersion: 1;
  invocationId: string;
  sessionId: string;
  toolId: string;
  capability: AgentCapability;
  targetScope: TargetScope;
  arguments: JsonObject;
  requestedAt: string;
}

export interface ToolProgress {
  schemaVersion: 1;
  invocationId: string;
  sequence: number;
  timestamp: string;
  message: string;
  percent?: number;
}

export interface MutationCommit {
  /** False is an authenticated no-effect result; omission remains reserved for unknown effect truth. */
  committed: boolean;
  point?: "atomic-rename" | "console-dispatch" | "server-properties-root-generation" | "maintenance-edit";
}

export interface ToolResult {
  schemaVersion: 1;
  invocationId: string;
  status: "succeeded" | "failed" | "cancelled" | "indeterminate";
  completedAt: string;
  summary: string;
  output: JsonValue;
  evidence: EvidenceReference[];
  /** Exact host-effect truth when the executor can establish it. */
  mutationCommit?: MutationCommit;
}

export interface ToolCancellation {
  schemaVersion: 1;
  invocationId: string;
  requestedAt: string;
  reason: string;
}

export interface SkillManifest {
  schemaVersion: 1;
  skillId: string;
  version: string;
  displayName: string;
  description: string;
  compatibility: {
    contractSchemaVersions: number[];
    platforms: string[];
  };
  instructions: string;
  resources: string[];
  requestedTools: string[];
  provenance: {
    source: "mc-aws" | "operator" | "third-party";
    reference: string;
    integrity: string;
  };
}

export type HookPoint =
  | "before-invocation"
  | "after-invocation"
  | "approval"
  | "backup"
  | "event"
  | "session-start"
  | "session-end";

export interface HookDefinition {
  schemaVersion: 1;
  hookId: string;
  hookPoint: HookPoint;
  priority: number;
  failureBehavior: "fail-closed" | "continue";
  handlerRef: string;
}

export type ExtensionProvenanceSource = "mc-aws" | "operator" | "third-party";

/** Data-only public extension contract. Loading a bundle never imports or executes its hook references. */
export interface AgentExtensionBundle {
  schemaVersion: 1;
  extensionId: string;
  version: string;
  compatibility: {
    contractSchemaVersions: number[];
    platforms: string[];
  };
  provenance: {
    source: ExtensionProvenanceSource;
    reference: string;
    integrity: string;
  };
  tools: ToolDefinition[];
  skills: SkillManifest[];
  hooks: HookDefinition[];
}

export interface ProviderDefinition {
  schemaVersion: 1;
  providerId: string;
  kind: "openrouter" | "openai-compatible" | "fake";
  displayName: string;
  endpoint: string;
  supportedFeatures: Array<"streaming" | "tools" | "reasoning-summary">;
}

export interface ProviderConfiguration {
  schemaVersion: 1;
  profileId: string;
  providerId: string;
  model: string;
  credentialRef: string;
  timeoutMs: number;
}

export interface CapabilityRule {
  schemaVersion: 1;
  capability: AgentCapability;
  decision: PermissionDecision;
}

export interface PermissionPolicy {
  schemaVersion: 1;
  policyId: string;
  revision: number;
  preset: PermissionPresetName;
  rules: CapabilityRule[];
  backupMode: BackupMode;
}

export interface PermissionPreset {
  schemaVersion: 1;
  name: PermissionPresetName;
  displayName: string;
  isDefault: boolean;
  rules: CapabilityRule[];
  backupMode: BackupMode;
}

export interface ApprovalScope {
  schemaVersion: 1;
  kind: "single-invocation" | "session-capability";
  capability: AgentCapability;
  targetScope: TargetScope;
  risk: RiskClass;
}

export interface ProposedInvocationSummary {
  schemaVersion: 1;
  invocationId: string;
  invocationDigest: string;
  toolId: string;
  capability: AgentCapability;
  targetScope: TargetScope;
  risk: RiskClass;
  sanitizedArguments: JsonObject;
  diffSummary?: string;
  backupFailureStatus?: "failed" | "unavailable";
}

export type ApprovalDecision = "pending" | "approved" | "denied" | "cancelled" | "revoked";

export interface AgentApproval {
  schemaVersion: 1;
  approvalId: string;
  actorId: string;
  sessionId: string;
  policyId: string;
  policyRevision: number;
  invocationDigest: string;
  invocationSummary: ProposedInvocationSummary;
  invocationSummaryDigest: string;
  scope: ApprovalScope;
  expiresAt: string;
  decision: ApprovalDecision;
  reason: string;
  decidedAt?: string;
  consumedAt?: string;
}

/**
 * Authoritative control-plane decision that linearizes an exact gated invocation
 * against approval revocation and lease cancellation. The signed local gateway
 * protocol carries this value unchanged to the executor.
 */
export interface InvocationAuthorization {
  schemaVersion: 1;
  authorizationId: string;
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  taskId: string;
  sessionId: string;
  actorId: string;
  policyId: string;
  policyRevision: number;
  invocationId: string;
  invocationDigest: string;
  approvalId: string;
  approvalKind: "ask-once" | "ask-always";
  capability: AgentCapability;
  targetScope: TargetScope;
  risk: RiskClass;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Control-plane-signed proof that an exact required backup completed while the
 * global lifecycle lock remains held for one exact executor invocation.
 */
export interface BackupFenceAuthorization {
  schemaVersion: 1;
  status: "succeeded";
  authorizationId: string;
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  sessionId: string;
  taskId: string;
  invocationId: string;
  invocationDigest: string;
  backupId: string;
  /** Exact global lifecycle owner; never a bearer credential. */
  lifecycleLockId: string;
  lifecycleFencingToken: number;
  /** Monotonic renewal generation for this lifecycle owner. */
  lifecycleLeaseGeneration: number;
  /** Authoritative lock horizon used by the executor's immediate pre-commit check. */
  lifecycleLeaseExpiresAt: string;
  /** Executor receipt key selected by the control plane for this operation. */
  executorKeyId?: string;
  /** Monotonic receipt-key epoch selected with executorKeyId. */
  executorKeyEpoch?: number;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

/**
 * Authenticated proof from the executor that the exact invocation reached a
 * terminal state. The lifecycle fields are present when the invocation held a
 * backup fence; ordinary executions still receive the same signed evidence.
 */
export interface BackupTerminalReceipt {
  schemaVersion: 1;
  source: "executor-journal";
  /** Terminal journal result, or a root-authorized clean executor epoch proving no old effect is active. */
  proofKind: "terminal" | "clean-start-no-active";
  outcome: "committed" | "failed" | "cancelled" | "indeterminate";
  executorKeyId: string;
  /** Receipt-key epoch; distinct from the clean-start executor epoch below. */
  executorKeyEpoch?: number;
  executorEpoch: string;
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  sessionId: string;
  taskId: string;
  invocationId: string;
  invocationDigest: string;
  /** Present only when this terminal result also held a backup lifecycle fence. */
  backupId?: string;
  lifecycleLockId?: string;
  lifecycleFencingToken?: number;
  /** Current monotonic lifecycle lease generation, not the work-lease generation. */
  lifecycleLeaseGeneration?: number;
  resultDigest: string;
  /** Executor journal record/checkpoint sequence proving terminal persistence. */
  journalSequence: number;
  completedAt: string;
  /** Ed25519 signature over the canonical receipt with this field omitted. */
  signature: string;
  /** Issuance time of the exact fence used for the terminal commit. */
  fenceIssuedAt?: string;
}

/**
 * Control-plane proof that executor terminal evidence is durably published and
 * the owning invocation has reached a coherent publication boundary. A live
 * gateway may retain the exact task lease for the next invocation; recovery
 * terminalizes the interrupted task instead.
 * The gateway may transport this proof but cannot mint or alter it.
 */
export interface TerminalPublicationAuthorization {
  schemaVersion: 1;
  source: "control-plane-terminal-publication";
  runtimeId: string;
  sessionId: string;
  taskId: string;
  leaseId: string;
  leaseGeneration: number;
  invocationId: string;
  invocationDigest: string;
  journalSequence: number;
  resultDigest: string;
  terminalReceiptDigest: string;
  outcome: "committed" | "failed" | "cancelled";
  /** Omitted legacy authorizations are task-terminal publications. */
  taskDisposition?: "continue" | "terminate";
  taskStatus: "running" | "waiting-approval" | "completed" | "failed" | "cancelled";
  sessionStatus: "running" | "waiting-approval" | "idle" | "completed" | "failed" | "cancelled";
  publicationRevision: number;
  publishedAt: string;
  /** Ed25519 signature over the canonical authorization with this field omitted. */
  signature: string;
}

export interface ExecutorReceiptVerifier {
  schemaVersion: 1;
  keyId: string;
  /** Canonical base64 DER SubjectPublicKeyInfo for an Ed25519 verifier. */
  publicKeySpki: string;
  /** Monotonic receipt-key epoch. Omitted legacy current keys are epoch one. */
  keyEpoch?: number;
  /** Required for retained keys; the last time an operation may use this key. */
  rotationCutoffAt?: string;
}

/** Current verifier plus a bounded history retained while old-key receipts may be in flight. */
export interface ExecutorReceiptVerifierSet {
  schemaVersion: 1;
  currentKeyId: string;
  verifiers: ExecutorReceiptVerifier[];
}

export interface EvaluatedPermissionDecision {
  schemaVersion: 1;
  outcome: "allow" | "deny" | "require-approval";
  capability: AgentCapability;
  targetScope: TargetScope;
  risk: RiskClass;
  reason: string;
  approvalKind?: "ask-once" | "ask-always";
  approvalId?: string;
  immutableBoundary?: string;
}

export interface AgentTurn {
  schemaVersion: 1;
  turnId: string;
  kind: "task" | "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface HarnessMetadata {
  schemaVersion: 1;
  adapterId: string;
  adapterVersion: string;
  providerProfileId: string;
  providerProfileFingerprint: string;
  model: string;
}

export interface AgentSession {
  schemaVersion: 1;
  sessionId: string;
  actorId: string;
  status: "pending" | "running" | "waiting-approval" | "idle" | "cancelled" | "failed" | "completed";
  createdAt: string;
  updatedAt: string;
  policyId: string;
  policyRevision: number;
  harness: HarnessMetadata;
  turns: AgentTurn[];
}

export const AGENT_EVENT_KINDS = [
  "model",
  "reasoning-summary",
  "tool-proposal",
  "tool-progress",
  "tool-result",
  "policy",
  "backup",
  "approval",
  "error",
  "cancellation",
  "completion",
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export interface RedactedEventPayload {
  schemaVersion: 1;
  redacted: true;
  data: JsonObject;
}

export interface AgentEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  kind: AgentEventKind;
  payload: RedactedEventPayload;
  replayCursor: string;
}

export interface ImmutableBoundaryFacts {
  requestsRoot: boolean;
  requestsLinuxCapabilities: boolean;
  administersHostPackagesOrServices: boolean;
  accessesInstanceMetadata: boolean;
  accessesAwsApisOrCredentials: boolean;
  accessesDeploymentSecrets: boolean;
  accessesBackupProviderSecrets: boolean;
  exposesHarnessOrProviderCredentials: boolean;
  /** A generic agent tool targeted a protected executable/runtime asset. */
  targetImmutableAsset: boolean;
  targetOutsideAllowedRoots: boolean;
}

export interface RiskFacts {
  mutation: boolean;
  consoleMutation: boolean;
  executableOrConfigurationChange: boolean;
  bulkOperation: boolean;
  worldChange: boolean;
  permissionChange: boolean;
  broadMutation: boolean;
}

export interface PermissionEvaluationInput {
  policy: PermissionPolicy;
  actorId: string;
  sessionId: string;
  invocationDigest: string;
  capability: AgentCapability;
  targetScope: TargetScope;
  risk: RiskClass;
  immutableBoundary: ImmutableBoundaryFacts;
  approvals: AgentApproval[];
  now: string;
}

export interface BackupEvaluation {
  required: boolean;
  outcome: "not-required" | "create-backup" | "proceed" | "pause";
  reason: string;
}
