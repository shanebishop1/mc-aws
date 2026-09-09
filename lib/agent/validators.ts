import {
  AGENT_CAPABILITIES,
  AGENT_EVENT_KINDS,
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentEvent,
  type AgentExtensionBundle,
  type AgentSession,
  type AgentTurn,
  type ApprovalScope,
  type CapabilityRule,
  type EvaluatedPermissionDecision,
  type EvidenceReference,
  type HarnessMetadata,
  type HookDefinition,
  type JsonObject,
  type PermissionPolicy,
  type PermissionPreset,
  type ProposedInvocationSummary,
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
import { parseNetworkDownloadApprovalTarget } from "@/lib/agent/network-download";
import {
  MAX_AGENT_EVENT_PAYLOAD_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  serializedUtf8Bytes,
} from "@/lib/agent/response-limits";
import { isSensitiveKey } from "@/lib/agent/sensitive-keys";

export class AgentContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentContractValidationError";
  }
}

export interface RuntimeSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: AgentContractValidationError };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CREDENTIAL_REF = /^secret-ref:[a-z0-9][a-z0-9/_-]{2,127}$/;

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new AgentContractValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string, allowedKeys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const object = value as UnknownRecord;
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  return object;
}

function required(object: UnknownRecord, keys: readonly string[], path: string): void {
  for (const key of keys) if (!(key in object)) fail(`${path}.${key}`, "is required");
}

function string(value: unknown, path: string, options?: { pattern?: RegExp; allowEmpty?: boolean }): string {
  if (typeof value !== "string" || (!options?.allowEmpty && value.length === 0))
    fail(path, "must be a non-empty string");
  if (options?.pattern && !options.pattern.test(value as string)) fail(path, "has an invalid format");
  return value as string;
}

function number(value: unknown, path: string, options?: { integer?: boolean; min?: number; max?: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  if (options?.integer && !Number.isInteger(value)) fail(path, "must be an integer");
  if (options?.min !== undefined && value < options.min) fail(path, `must be at least ${options.min}`);
  if (options?.max !== undefined && value > options.max) fail(path, `must be at most ${options.max}`);
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${expected}`);
  return expected;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(path, `must be one of ${choices.join(", ")}`);
  return value as T;
}

function array<T>(value: unknown, path: string, parseItem: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((item, index) => parseItem(item, `${path}[${index}]`));
}

function optionalString(object: UnknownRecord, key: string, path: string, pattern?: RegExp): void {
  if (object[key] !== undefined) string(object[key], `${path}.${key}`, { pattern });
}

function versioned(
  value: unknown,
  path: string,
  keys: readonly string[],
  requiredKeys: readonly string[]
): UnknownRecord {
  const object = record(value, path, ["schemaVersion", ...keys]);
  required(object, ["schemaVersion", ...requiredKeys], path);
  literal(object.schemaVersion, AGENT_SCHEMA_VERSION, `${path}.schemaVersion`);
  return object;
}

function assertJson(value: unknown, path: string): asserts value is JsonObject[keyof JsonObject] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") fail(path, "must be JSON-serializable");
  for (const [key, child] of Object.entries(value as UnknownRecord)) {
    if (isSensitiveKey(key)) fail(`${path}.${key}`, "raw credential fields are forbidden; use credentialRef");
    assertJson(child, `${path}.${key}`);
  }
}

function jsonObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a JSON object");
  assertJson(value, path);
  return value as JsonObject;
}

function boundedJson(value: unknown, maximum: number, path: string): void {
  let bytes: number;
  try {
    bytes = serializedUtf8Bytes(value);
  } catch {
    fail(path, "must be JSON-serializable");
  }
  if (bytes > maximum) fail(path, `exceeds its encoded byte budget of ${maximum}`);
}

function timestamp(value: unknown, path: string): string {
  const parsed = string(value, path, { pattern: ISO_TIMESTAMP });
  if (!Number.isFinite(Date.parse(parsed))) fail(path, "must be a valid ISO timestamp");
  return parsed;
}

function id(value: unknown, path: string): string {
  return string(value, path, { pattern: ID });
}

function parseEvidence(value: unknown, path = "evidenceReference"): EvidenceReference {
  const object = versioned(
    value,
    path,
    ["evidenceId", "kind", "uri", "description"],
    ["evidenceId", "kind", "uri", "description"]
  );
  id(object.evidenceId, `${path}.evidenceId`);
  oneOf(object.kind, ["file", "command-output", "console-output", "backup", "diff"] as const, `${path}.kind`);
  string(object.uri, `${path}.uri`);
  string(object.description, `${path}.description`);
  return object as unknown as EvidenceReference;
}

function parseTargetScope(value: unknown, path = "targetScope"): TargetScope {
  const object = versioned(value, path, ["kind", "normalizedTarget"], ["kind", "normalizedTarget"]);
  oneOf(object.kind, ["workspace", "session-scratch", "console", "network"] as const, `${path}.kind`);
  const target = string(object.normalizedTarget, `${path}.normalizedTarget`);
  if (target.includes("\0") || target.includes("\\"))
    fail(`${path}.normalizedTarget`, "contains an unsafe path character");
  if ((object.kind === "workspace" || object.kind === "session-scratch") && target.split("/").includes(".."))
    fail(`${path}.normalizedTarget`, "contains parent path traversal");
  if (object.kind === "network") {
    try {
      parseNetworkDownloadApprovalTarget(target);
    } catch {
      fail(`${path}.normalizedTarget`, "must be a canonical network approval target");
    }
  }
  return object as unknown as TargetScope;
}

function parseCapabilityRule(value: unknown, path = "capabilityRule"): CapabilityRule {
  const object = versioned(value, path, ["capability", "decision"], ["capability", "decision"]);
  oneOf(object.capability, AGENT_CAPABILITIES, `${path}.capability`);
  oneOf(object.decision, ["allow", "ask-once", "ask-always", "deny"] as const, `${path}.decision`);
  return object as unknown as CapabilityRule;
}

function parseRules(value: unknown, path: string): CapabilityRule[] {
  const rules = array(value, path, parseCapabilityRule);
  if (rules.length !== AGENT_CAPABILITIES.length) fail(path, "must contain exactly one rule for every capability");
  const capabilities = new Set(rules.map((rule) => rule.capability));
  if (capabilities.size !== AGENT_CAPABILITIES.length || AGENT_CAPABILITIES.some((item) => !capabilities.has(item))) {
    fail(path, "must contain exactly one rule for every capability");
  }
  return rules;
}

function parseToolDefinition(value: unknown): ToolDefinition {
  const path = "toolDefinition";
  const object = versioned(
    value,
    path,
    ["toolId", "displayName", "description", "capability", "sideEffect", "inputSchema"],
    ["toolId", "displayName", "description", "capability", "sideEffect", "inputSchema"]
  );
  id(object.toolId, `${path}.toolId`);
  string(object.displayName, `${path}.displayName`);
  string(object.description, `${path}.description`);
  oneOf(object.capability, AGENT_CAPABILITIES, `${path}.capability`);
  oneOf(
    object.sideEffect,
    ["read", "write", "delete", "execute", "network", "backup", "extension"] as const,
    `${path}.sideEffect`
  );
  jsonObject(object.inputSchema, `${path}.inputSchema`);
  return object as unknown as ToolDefinition;
}

function parseToolInvocation(value: unknown): ToolInvocation {
  const path = "toolInvocation";
  const object = versioned(
    value,
    path,
    ["invocationId", "sessionId", "toolId", "capability", "targetScope", "arguments", "requestedAt"],
    ["invocationId", "sessionId", "toolId", "capability", "targetScope", "arguments", "requestedAt"]
  );
  id(object.invocationId, `${path}.invocationId`);
  id(object.sessionId, `${path}.sessionId`);
  id(object.toolId, `${path}.toolId`);
  oneOf(object.capability, AGENT_CAPABILITIES, `${path}.capability`);
  parseTargetScope(object.targetScope, `${path}.targetScope`);
  jsonObject(object.arguments, `${path}.arguments`);
  boundedJson(object.arguments, MAX_TOOL_ARGUMENT_BYTES, `${path}.arguments`);
  timestamp(object.requestedAt, `${path}.requestedAt`);
  return object as unknown as ToolInvocation;
}

function parseToolProgress(value: unknown): ToolProgress {
  const path = "toolProgress";
  const object = versioned(
    value,
    path,
    ["invocationId", "sequence", "timestamp", "message", "percent"],
    ["invocationId", "sequence", "timestamp", "message"]
  );
  id(object.invocationId, `${path}.invocationId`);
  number(object.sequence, `${path}.sequence`, { integer: true, min: 1 });
  timestamp(object.timestamp, `${path}.timestamp`);
  string(object.message, `${path}.message`);
  if ("percent" in object) number(object.percent, `${path}.percent`, { min: 0, max: 100 });
  return object as unknown as ToolProgress;
}

function parseToolResult(value: unknown): ToolResult {
  const path = "toolResult";
  const object = versioned(
    value,
    path,
    ["invocationId", "status", "completedAt", "summary", "output", "evidence", "mutationCommit"],
    ["invocationId", "status", "completedAt", "summary", "output", "evidence"]
  );
  id(object.invocationId, `${path}.invocationId`);
  oneOf(object.status, ["succeeded", "failed", "cancelled", "indeterminate"] as const, `${path}.status`);
  timestamp(object.completedAt, `${path}.completedAt`);
  string(object.summary, `${path}.summary`);
  assertJson(object.output, `${path}.output`);
  array(object.evidence, `${path}.evidence`, parseEvidence);
  boundedJson(object, MAX_TOOL_RESULT_BYTES, path);
  if (object.mutationCommit !== undefined) {
    const commit = record(object.mutationCommit, `${path}.mutationCommit`, ["committed", "point"]);
    required(commit, ["committed"], `${path}.mutationCommit`);
    if (typeof commit.committed !== "boolean") fail(`${path}.mutationCommit.committed`, "must be a boolean");
    if (commit.committed) {
      required(commit, ["point"], `${path}.mutationCommit`);
      oneOf(
        commit.point,
        ["atomic-rename", "console-dispatch", "server-properties-root-generation", "maintenance-edit"] as const,
        `${path}.mutationCommit.point`
      );
    } else if (commit.point !== undefined) {
      fail(`${path}.mutationCommit.point`, "must be omitted for a proven no-effect result");
    }
    if (object.status === "succeeded" && commit.committed !== true) {
      fail(`${path}.mutationCommit`, "a succeeded result must prove a committed effect");
    }
  }
  return object as unknown as ToolResult;
}

function parseToolCancellation(value: unknown): ToolCancellation {
  const path = "toolCancellation";
  const object = versioned(
    value,
    path,
    ["invocationId", "requestedAt", "reason"],
    ["invocationId", "requestedAt", "reason"]
  );
  id(object.invocationId, `${path}.invocationId`);
  timestamp(object.requestedAt, `${path}.requestedAt`);
  string(object.reason, `${path}.reason`);
  return object as unknown as ToolCancellation;
}

function parseSkillManifest(value: unknown): SkillManifest {
  const path = "skillManifest";
  const object = versioned(
    value,
    path,
    [
      "skillId",
      "version",
      "displayName",
      "description",
      "compatibility",
      "instructions",
      "resources",
      "requestedTools",
      "provenance",
    ],
    [
      "skillId",
      "version",
      "displayName",
      "description",
      "compatibility",
      "instructions",
      "resources",
      "requestedTools",
      "provenance",
    ]
  );
  id(object.skillId, `${path}.skillId`);
  string(object.version, `${path}.version`, { pattern: SEMVER });
  string(object.displayName, `${path}.displayName`);
  string(object.description, `${path}.description`);
  const compatibility = record(object.compatibility, `${path}.compatibility`, ["contractSchemaVersions", "platforms"]);
  required(compatibility, ["contractSchemaVersions", "platforms"], `${path}.compatibility`);
  array(compatibility.contractSchemaVersions, `${path}.compatibility.contractSchemaVersions`, (item, itemPath) =>
    number(item, itemPath, { integer: true, min: 1 })
  );
  array(compatibility.platforms, `${path}.compatibility.platforms`, string);
  string(object.instructions, `${path}.instructions`);
  array(object.resources, `${path}.resources`, string);
  array(object.requestedTools, `${path}.requestedTools`, id);
  const provenance = record(object.provenance, `${path}.provenance`, ["source", "reference", "integrity"]);
  required(provenance, ["source", "reference", "integrity"], `${path}.provenance`);
  oneOf(provenance.source, ["mc-aws", "operator", "third-party"] as const, `${path}.provenance.source`);
  string(provenance.reference, `${path}.provenance.reference`);
  string(provenance.integrity, `${path}.provenance.integrity`);
  return object as unknown as SkillManifest;
}

function parseHookDefinition(value: unknown): HookDefinition {
  const path = "hookDefinition";
  const object = versioned(
    value,
    path,
    ["hookId", "hookPoint", "priority", "failureBehavior", "handlerRef"],
    ["hookId", "hookPoint", "priority", "failureBehavior", "handlerRef"]
  );
  id(object.hookId, `${path}.hookId`);
  oneOf(
    object.hookPoint,
    ["before-invocation", "after-invocation", "approval", "backup", "event", "session-start", "session-end"] as const,
    `${path}.hookPoint`
  );
  number(object.priority, `${path}.priority`, { integer: true });
  oneOf(object.failureBehavior, ["fail-closed", "continue"] as const, `${path}.failureBehavior`);
  id(object.handlerRef, `${path}.handlerRef`);
  return object as unknown as HookDefinition;
}

function parseExtensionCompatibility(value: unknown, path: string): AgentExtensionBundle["compatibility"] {
  const compatibility = record(value, path, ["contractSchemaVersions", "platforms"]);
  required(compatibility, ["contractSchemaVersions", "platforms"], path);
  const contractSchemaVersions = array(
    compatibility.contractSchemaVersions,
    `${path}.contractSchemaVersions`,
    (item, itemPath) => number(item, itemPath, { integer: true, min: 1 })
  );
  if (contractSchemaVersions.length === 0 || new Set(contractSchemaVersions).size !== contractSchemaVersions.length) {
    fail(`${path}.contractSchemaVersions`, "must contain unique supported schema versions");
  }
  const platforms = array(compatibility.platforms, `${path}.platforms`, string);
  if (platforms.length === 0 || new Set(platforms).size !== platforms.length) {
    fail(`${path}.platforms`, "must contain unique supported platforms");
  }
  return { contractSchemaVersions, platforms };
}

function parseAgentExtensionBundle(value: unknown): AgentExtensionBundle {
  const path = "agentExtensionBundle";
  const object = versioned(
    value,
    path,
    ["extensionId", "version", "compatibility", "provenance", "tools", "skills", "hooks"],
    ["extensionId", "version", "compatibility", "provenance", "tools", "skills", "hooks"]
  );
  id(object.extensionId, `${path}.extensionId`);
  string(object.version, `${path}.version`, { pattern: SEMVER });
  parseExtensionCompatibility(object.compatibility, `${path}.compatibility`);
  const provenance = record(object.provenance, `${path}.provenance`, ["source", "reference", "integrity"]);
  required(provenance, ["source", "reference", "integrity"], `${path}.provenance`);
  oneOf(provenance.source, ["mc-aws", "operator", "third-party"] as const, `${path}.provenance.source`);
  string(provenance.reference, `${path}.provenance.reference`);
  string(provenance.integrity, `${path}.provenance.integrity`, { pattern: /^sha256:[a-f0-9]{64}$/ });
  const tools = array(object.tools, `${path}.tools`, (item) => parseToolDefinition(item));
  const skills = array(object.skills, `${path}.skills`, (item) => parseSkillManifest(item));
  const hooks = array(object.hooks, `${path}.hooks`, (item) => parseHookDefinition(item));
  if (tools.length === 0 || skills.length === 0 || hooks.length === 0) {
    fail(path, "must contain at least one tool, skill, and hook");
  }
  return object as unknown as AgentExtensionBundle;
}

function parseProviderDefinition(value: unknown): ProviderDefinition {
  const path = "providerDefinition";
  const object = versioned(
    value,
    path,
    ["providerId", "kind", "displayName", "endpoint", "supportedFeatures"],
    ["providerId", "kind", "displayName", "endpoint", "supportedFeatures"]
  );
  id(object.providerId, `${path}.providerId`);
  oneOf(object.kind, ["openrouter", "openai-compatible", "fake"] as const, `${path}.kind`);
  string(object.displayName, `${path}.displayName`);
  const endpoint = string(object.endpoint, `${path}.endpoint`);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail(`${path}.endpoint`, "must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") fail(`${path}.endpoint`, "must use HTTPS");
  array(object.supportedFeatures, `${path}.supportedFeatures`, (item, itemPath) =>
    oneOf(item, ["streaming", "tools", "reasoning-summary"] as const, itemPath)
  );
  return object as unknown as ProviderDefinition;
}

function parseProviderConfiguration(value: unknown): ProviderConfiguration {
  const path = "providerConfiguration";
  const object = versioned(
    value,
    path,
    ["profileId", "providerId", "model", "credentialRef", "timeoutMs"],
    ["profileId", "providerId", "model", "credentialRef", "timeoutMs"]
  );
  id(object.profileId, `${path}.profileId`);
  id(object.providerId, `${path}.providerId`);
  string(object.model, `${path}.model`);
  string(object.credentialRef, `${path}.credentialRef`, { pattern: CREDENTIAL_REF });
  number(object.timeoutMs, `${path}.timeoutMs`, { integer: true, min: 1 });
  return object as unknown as ProviderConfiguration;
}

function parsePermissionPolicy(value: unknown): PermissionPolicy {
  const path = "permissionPolicy";
  const object = versioned(
    value,
    path,
    ["policyId", "revision", "preset", "rules", "backupMode"],
    ["policyId", "revision", "preset", "rules", "backupMode"]
  );
  id(object.policyId, `${path}.policyId`);
  number(object.revision, `${path}.revision`, { integer: true, min: 1 });
  oneOf(object.preset, ["copilot", "maintainer", "autopilot", "custom"] as const, `${path}.preset`);
  parseRules(object.rules, `${path}.rules`);
  oneOf(
    object.backupMode,
    ["never", "before-destructive", "before-risky", "before-any-mutation"] as const,
    `${path}.backupMode`
  );
  return object as unknown as PermissionPolicy;
}

function parsePermissionPreset(value: unknown): PermissionPreset {
  const path = "permissionPreset";
  const object = versioned(
    value,
    path,
    ["name", "displayName", "isDefault", "rules", "backupMode"],
    ["name", "displayName", "isDefault", "rules", "backupMode"]
  );
  oneOf(object.name, ["copilot", "maintainer", "autopilot", "custom"] as const, `${path}.name`);
  string(object.displayName, `${path}.displayName`);
  if (typeof object.isDefault !== "boolean") fail(`${path}.isDefault`, "must be a boolean");
  parseRules(object.rules, `${path}.rules`);
  oneOf(
    object.backupMode,
    ["never", "before-destructive", "before-risky", "before-any-mutation"] as const,
    `${path}.backupMode`
  );
  return object as unknown as PermissionPreset;
}

function parseApprovalScope(value: unknown, path = "approvalScope"): ApprovalScope {
  const object = versioned(
    value,
    path,
    ["kind", "capability", "targetScope", "risk"],
    ["kind", "capability", "targetScope", "risk"]
  );
  oneOf(object.kind, ["single-invocation", "session-capability"] as const, `${path}.kind`);
  oneOf(object.capability, AGENT_CAPABILITIES, `${path}.capability`);
  parseTargetScope(object.targetScope, `${path}.targetScope`);
  oneOf(object.risk, ["low", "risky", "destructive"] as const, `${path}.risk`);
  return object as unknown as ApprovalScope;
}

function parseProposedInvocationSummary(value: unknown, path = "proposedInvocationSummary"): ProposedInvocationSummary {
  const object = versioned(
    value,
    path,
    [
      "invocationId",
      "invocationDigest",
      "toolId",
      "capability",
      "targetScope",
      "risk",
      "sanitizedArguments",
      "diffSummary",
      "backupFailureStatus",
    ],
    ["invocationId", "invocationDigest", "toolId", "capability", "targetScope", "risk", "sanitizedArguments"]
  );
  id(object.invocationId, `${path}.invocationId`);
  string(object.invocationDigest, `${path}.invocationDigest`, { pattern: SHA256 });
  id(object.toolId, `${path}.toolId`);
  oneOf(object.capability, AGENT_CAPABILITIES, `${path}.capability`);
  parseTargetScope(object.targetScope, `${path}.targetScope`);
  oneOf(object.risk, ["low", "risky", "destructive"] as const, `${path}.risk`);
  jsonObject(object.sanitizedArguments, `${path}.sanitizedArguments`);
  optionalString(object, "diffSummary", path);
  if (object.backupFailureStatus !== undefined) {
    oneOf(object.backupFailureStatus, ["failed", "unavailable"] as const, `${path}.backupFailureStatus`);
  }
  return object as unknown as ProposedInvocationSummary;
}

function parseAgentApproval(value: unknown): AgentApproval {
  const path = "agentApproval";
  const object = versioned(
    value,
    path,
    [
      "approvalId",
      "actorId",
      "sessionId",
      "policyId",
      "policyRevision",
      "invocationDigest",
      "invocationSummary",
      "invocationSummaryDigest",
      "scope",
      "expiresAt",
      "decision",
      "reason",
      "decidedAt",
      "consumedAt",
    ],
    [
      "approvalId",
      "actorId",
      "sessionId",
      "policyId",
      "policyRevision",
      "invocationDigest",
      "invocationSummary",
      "invocationSummaryDigest",
      "scope",
      "expiresAt",
      "decision",
      "reason",
    ]
  );
  id(object.approvalId, `${path}.approvalId`);
  id(object.actorId, `${path}.actorId`);
  id(object.sessionId, `${path}.sessionId`);
  id(object.policyId, `${path}.policyId`);
  number(object.policyRevision, `${path}.policyRevision`, { integer: true, min: 1 });
  string(object.invocationDigest, `${path}.invocationDigest`, { pattern: SHA256 });
  const summary = parseProposedInvocationSummary(object.invocationSummary, `${path}.invocationSummary`);
  string(object.invocationSummaryDigest, `${path}.invocationSummaryDigest`, { pattern: SHA256 });
  if (summary.invocationDigest !== object.invocationDigest) {
    fail(`${path}.invocationSummary.invocationDigest`, "must match approval invocationDigest");
  }
  const scope = parseApprovalScope(object.scope, `${path}.scope`);
  if (
    summary.risk !== scope.risk ||
    summary.targetScope.kind !== scope.targetScope.kind ||
    summary.targetScope.normalizedTarget !== scope.targetScope.normalizedTarget ||
    (summary.backupFailureStatus
      ? scope.kind !== "single-invocation" || scope.capability !== "backup.create"
      : summary.capability !== scope.capability)
  ) {
    fail(`${path}.invocationSummary`, "must match the granted scope and risk");
  }
  timestamp(object.expiresAt, `${path}.expiresAt`);
  oneOf(object.decision, ["pending", "approved", "denied", "cancelled", "revoked"] as const, `${path}.decision`);
  string(object.reason, `${path}.reason`, { allowEmpty: object.decision === "pending" });
  optionalString(object, "decidedAt", path, ISO_TIMESTAMP);
  optionalString(object, "consumedAt", path, ISO_TIMESTAMP);
  if (object.decision === "pending" && (object.decidedAt !== undefined || object.consumedAt !== undefined)) {
    fail(path, "pending approvals cannot be decided or consumed");
  }
  if (object.decision !== "pending" && object.decidedAt === undefined)
    fail(`${path}.decidedAt`, "is required after a decision");
  if (object.consumedAt !== undefined && object.decision !== "approved")
    fail(`${path}.consumedAt`, "requires an approved decision");
  return object as unknown as AgentApproval;
}

function parseEvaluatedDecision(value: unknown): EvaluatedPermissionDecision {
  const path = "evaluatedPermissionDecision";
  const object = versioned(
    value,
    path,
    ["outcome", "capability", "targetScope", "risk", "reason", "approvalKind", "approvalId", "immutableBoundary"],
    ["outcome", "capability", "targetScope", "risk", "reason"]
  );
  oneOf(object.outcome, ["allow", "deny", "require-approval"] as const, `${path}.outcome`);
  oneOf(object.capability, AGENT_CAPABILITIES, `${path}.capability`);
  parseTargetScope(object.targetScope, `${path}.targetScope`);
  oneOf(object.risk, ["low", "risky", "destructive"] as const, `${path}.risk`);
  string(object.reason, `${path}.reason`);
  if ("approvalKind" in object) oneOf(object.approvalKind, ["ask-once", "ask-always"] as const, `${path}.approvalKind`);
  optionalString(object, "approvalId", path, ID);
  optionalString(object, "immutableBoundary", path);
  return object as unknown as EvaluatedPermissionDecision;
}

function parseHarnessMetadata(value: unknown, path: string): HarnessMetadata {
  const object = versioned(
    value,
    path,
    ["adapterId", "adapterVersion", "providerProfileId", "providerProfileFingerprint", "model"],
    ["adapterId", "adapterVersion", "providerProfileId", "providerProfileFingerprint", "model"]
  );
  id(object.adapterId, `${path}.adapterId`);
  string(object.adapterVersion, `${path}.adapterVersion`);
  id(object.providerProfileId, `${path}.providerProfileId`);
  string(object.providerProfileFingerprint, `${path}.providerProfileFingerprint`, { pattern: SHA256 });
  string(object.model, `${path}.model`);
  return object as unknown as HarnessMetadata;
}

function parseAgentTurn(value: unknown, path = "agentTurn"): AgentTurn {
  const parsed = versioned(
    value,
    path,
    ["turnId", "kind", "content", "createdAt"],
    ["turnId", "kind", "content", "createdAt"]
  );
  id(parsed.turnId, `${path}.turnId`);
  oneOf(parsed.kind, ["task", "user", "assistant"] as const, `${path}.kind`);
  string(parsed.content, `${path}.content`);
  timestamp(parsed.createdAt, `${path}.createdAt`);
  return parsed as unknown as AgentTurn;
}

function parseRedactedEventPayload(value: unknown, path = "redactedEventPayload"): RedactedEventPayload {
  const object = versioned(value, path, ["redacted", "data"], ["redacted", "data"]);
  if (object.redacted !== true) fail(`${path}.redacted`, "must be true");
  jsonObject(object.data, `${path}.data`);
  return object as unknown as RedactedEventPayload;
}

function parseAgentSession(value: unknown): AgentSession {
  const path = "agentSession";
  const object = versioned(
    value,
    path,
    ["sessionId", "actorId", "status", "createdAt", "updatedAt", "policyId", "policyRevision", "harness", "turns"],
    ["sessionId", "actorId", "status", "createdAt", "updatedAt", "policyId", "policyRevision", "harness", "turns"]
  );
  id(object.sessionId, `${path}.sessionId`);
  id(object.actorId, `${path}.actorId`);
  oneOf(
    object.status,
    ["pending", "running", "waiting-approval", "idle", "cancelled", "failed", "completed"] as const,
    `${path}.status`
  );
  timestamp(object.createdAt, `${path}.createdAt`);
  timestamp(object.updatedAt, `${path}.updatedAt`);
  id(object.policyId, `${path}.policyId`);
  number(object.policyRevision, `${path}.policyRevision`, { integer: true, min: 1 });
  parseHarnessMetadata(object.harness, `${path}.harness`);
  array(object.turns, `${path}.turns`, parseAgentTurn);
  return object as unknown as AgentSession;
}

function parseAgentEvent(value: unknown): AgentEvent {
  const path = "agentEvent";
  const object = versioned(
    value,
    path,
    ["eventId", "sessionId", "sequence", "timestamp", "kind", "payload", "replayCursor"],
    ["eventId", "sessionId", "sequence", "timestamp", "kind", "payload", "replayCursor"]
  );
  id(object.eventId, `${path}.eventId`);
  const sessionId = id(object.sessionId, `${path}.sessionId`);
  const sequence = number(object.sequence, `${path}.sequence`, { integer: true, min: 1 });
  timestamp(object.timestamp, `${path}.timestamp`);
  oneOf(object.kind, AGENT_EVENT_KINDS, `${path}.kind`);
  parseRedactedEventPayload(object.payload, `${path}.payload`);
  const replayCursor = string(object.replayCursor, `${path}.replayCursor`);
  boundedJson(object.payload, MAX_AGENT_EVENT_PAYLOAD_BYTES, `${path}.payload`);
  if (replayCursor !== `${sessionId}:${sequence}`) fail(`${path}.replayCursor`, "must match the session and sequence");
  return object as unknown as AgentEvent;
}

function schema<T>(parser: (value: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(value) {
      try {
        return { success: true, data: parser(value) };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof AgentContractValidationError
              ? error
              : new AgentContractValidationError("validation failed"),
        };
      }
    },
  };
}

export const agentSchemas = {
  evidenceReference: schema(parseEvidence),
  targetScope: schema(parseTargetScope),
  toolDefinition: schema(parseToolDefinition),
  toolInvocation: schema(parseToolInvocation),
  toolProgress: schema(parseToolProgress),
  toolResult: schema(parseToolResult),
  toolCancellation: schema(parseToolCancellation),
  skillManifest: schema(parseSkillManifest),
  hookDefinition: schema(parseHookDefinition),
  agentExtensionBundle: schema(parseAgentExtensionBundle),
  providerDefinition: schema(parseProviderDefinition),
  providerConfiguration: schema(parseProviderConfiguration),
  capabilityRule: schema(parseCapabilityRule),
  permissionPolicy: schema(parsePermissionPolicy),
  permissionPreset: schema(parsePermissionPreset),
  approvalScope: schema(parseApprovalScope),
  proposedInvocationSummary: schema(parseProposedInvocationSummary),
  agentApproval: schema(parseAgentApproval),
  evaluatedPermissionDecision: schema(parseEvaluatedDecision),
  harnessMetadata: schema((value) => parseHarnessMetadata(value, "harnessMetadata")),
  agentTurn: schema(parseAgentTurn),
  redactedEventPayload: schema(parseRedactedEventPayload),
  agentSession: schema(parseAgentSession),
  agentEvent: schema(parseAgentEvent),
} as const;

export function validateOrderedEvents(events: readonly AgentEvent[]): void {
  let previousSequence = 0;
  let sessionId: string | undefined;
  for (const event of events) {
    agentSchemas.agentEvent.parse(event);
    sessionId ??= event.sessionId;
    if (event.sessionId !== sessionId) fail("events", "must all belong to one session");
    if (event.sequence !== previousSequence + 1)
      fail("events", "must have contiguous monotonically increasing sequences");
    previousSequence = event.sequence;
  }
}
