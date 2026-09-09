import path from "node:path";
import {
  AGENT_SCHEMA_VERSION,
  type AgentApproval,
  type EvidenceReference,
  type JsonObject,
  type JsonValue,
  type MutationCommit,
  type ToolDefinition,
  type ToolInvocation,
  type ToolProgress,
  type ToolResult,
} from "@/lib/agent/contracts";
import {
  ExecutorGuardError,
  assertScope,
  contained,
  inspectMinecraftCommand,
  isGenericImmutableAssetMutation,
  isShellImmutableTarget,
  parseShellCommand,
  resolveConfinedPath,
  riskFacts,
  scopeForDownload,
  scopeForPath,
  validateDownloadExpectation,
  validateDownloadUrl,
} from "@/lib/agent/executor/guards";
import type {
  ApprovalConsumer,
  DirectLiveExecutor,
  DirectLiveExecutorConfig,
  DirectLiveHostEffects,
  ExecuteInvocationRequest,
  HostEffectResult,
} from "@/lib/agent/executor/types";
import { EXECUTOR_EFFECT_MAX_BOUND_MS, IndeterminateHostEffectError } from "@/lib/agent/executor/types";
import { isImmutableAgentAssetPath } from "@/lib/agent/immutable-assets";
import { parseMaintenanceApplyArguments } from "@/lib/agent/maintenance";
import {
  canonicalPersistentWorldRoots,
  isPersistentWorldPath,
  isRootServerPropertiesMutation,
} from "@/lib/agent/minecraft-security";
import {
  NO_IMMUTABLE_BOUNDARY_VIOLATIONS,
  classifyRisk,
  createInvocationDigest,
  createInvocationSummaryDigest,
  evaluateBackup,
  evaluatePermission,
  findImmutableBoundaryViolation,
  permissionDecisionForRisk,
} from "@/lib/agent/policy";
import { boundToolResult } from "@/lib/agent/response-limits";
import {
  existingToolDefinitionForCapability,
  extensionToolMatchesExistingCapability,
} from "@/lib/agent/tool-definitions";
import { agentSchemas } from "@/lib/agent/validators";

const TOOL_CAPABILITIES = {
  "workspace.read": "workspace.read",
  "workspace.write": "workspace.write",
  "workspace.delete": "workspace.delete",
  "shell.execute": "shell.execute",
  "console.execute": "console.execute",
  "network.download": "network.outbound",
  "backup.request": "backup.create",
  "extension.load": "extension.load",
  "maintenance.apply": "maintenance.apply",
} as const;

type ToolId = keyof typeof TOOL_CAPABILITIES;
const TOOL_ARGUMENTS: Record<ToolId, readonly string[]> = {
  "workspace.read": ["path", "maxBytes"],
  "workspace.write": ["path", "content"],
  "workspace.delete": ["path", "recursive"],
  "shell.execute": ["mode", "command", "timeoutMs", "change"],
  "console.execute": ["command", "timeoutMs"],
  "network.download": ["url", "destination", "timeoutMs", "maxBytes", "expectedSha256", "expectedBytes"],
  "backup.request": ["label"],
  "extension.load": ["path"],
  "maintenance.apply": [
    "path",
    "key",
    "value",
    "expectedSha256",
    "expectedBytes",
    "resultSha256",
    "resultBytes",
    "serviceIntent",
    "expectedProtocol",
  ],
};

function assertKnownArguments(toolId: ToolId, args: JsonObject): void {
  const unknown = Object.keys(args).find((key) => !TOOL_ARGUMENTS[toolId].includes(key));
  if (unknown) throw new Error(`Unknown ${toolId} argument: ${unknown}`);
  if ("recursive" in args && typeof args.recursive !== "boolean") throw new Error("recursive must be a boolean");
}

function shellOutput(hostResult: HostEffectResult): JsonObject {
  if (hostResult.output === null || typeof hostResult.output !== "object" || Array.isArray(hostResult.output)) {
    throw new ExecutorGuardError("Shell runner returned a non-object result.", "targetOutsideAllowedRoots");
  }
  return hostResult.output as JsonObject;
}

function stringArg(args: JsonObject, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${name} must be a non-empty bounded string`);
  return value;
}

function integerArg(args: JsonObject, name: string, fallback: number, max: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} is outside its allowed bound`);
  return value;
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
}

function result(
  invocationId: string,
  status: ToolResult["status"],
  summary: string,
  output: JsonValue,
  evidence: EvidenceReference[] = [],
  mutationCommit?: MutationCommit
): ToolResult {
  return {
    schemaVersion: 1,
    invocationId,
    status,
    completedAt: new Date().toISOString(),
    summary,
    output,
    evidence,
    ...(mutationCommit ? { mutationCommit } : {}),
  };
}

function failure(invocationId: string, error: unknown): ToolResult {
  if (error instanceof DOMException && error.name === "AbortError")
    return result(invocationId, "cancelled", "Invocation cancelled.", { code: "cancelled" }, [], { committed: false });
  const code =
    error instanceof ExecutorGuardError
      ? "immutable-boundary"
      : error instanceof Error && error.message.startsWith("Unknown shell.execute argument")
        ? "denied"
        : "executor-failed";
  return result(invocationId, "failed", "Executor failed closed.", { code }, [], { committed: false });
}

function assertHostSecurityCapabilities(effects: DirectLiveHostEffects, toolId: ToolId): void {
  const capabilities = effects.securityCapabilities;
  if (
    (toolId.startsWith("workspace.") || toolId === "extension.load" || toolId === "network.download") &&
    capabilities?.descriptorRelativeWorkspaceConfinement !== true
  ) {
    throw new ExecutorGuardError(
      "Host adapter cannot attest descriptor-relative workspace confinement.",
      "targetOutsideAllowedRoots"
    );
  }
  if (toolId === "shell.execute" && capabilities?.workspaceRootedCommandBoundary !== true) {
    throw new ExecutorGuardError(
      "Host adapter cannot attest a workspace-rooted command boundary.",
      "targetOutsideAllowedRoots"
    );
  }
  if (toolId === "network.download" && capabilities?.pinnedDnsRedirectEgressEnforcement !== true) {
    throw new ExecutorGuardError(
      "Host adapter cannot attest pinned-DNS redirect egress enforcement.",
      "targetOutsideAllowedRoots"
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Alias validation is part of the one-time executor construction boundary.
export function createDirectLiveExecutor(
  effects: DirectLiveHostEffects,
  config: DirectLiveExecutorConfig,
  approvalConsumer?: ApprovalConsumer
): DirectLiveExecutor {
  const configuredMaxTimeoutMs = config.maxTimeoutMs ?? 30_000;
  const configuredFilesystemEffectMs = config.maxFilesystemEffectMs ?? configuredMaxTimeoutMs;
  if (
    !Number.isSafeInteger(configuredMaxTimeoutMs) ||
    configuredMaxTimeoutMs < 1 ||
    configuredMaxTimeoutMs > EXECUTOR_EFFECT_MAX_BOUND_MS ||
    !Number.isSafeInteger(configuredFilesystemEffectMs) ||
    configuredFilesystemEffectMs < 1 ||
    configuredFilesystemEffectMs > EXECUTOR_EFFECT_MAX_BOUND_MS
  ) {
    throw new TypeError("Executor effect timeout bound is invalid.");
  }
  const limits = {
    workspaceRoot: config.workspaceRoot ?? "/opt/minecraft/server",
    maxReadBytes: config.maxReadBytes ?? 1024 * 1024,
    maxWriteBytes: config.maxWriteBytes ?? 1024 * 1024,
    maxDownloadBytes: config.maxDownloadBytes ?? 32 * 1024 * 1024,
    maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
    maxTimeoutMs: configuredMaxTimeoutMs,
    maxFilesystemEffectMs: configuredFilesystemEffectMs,
    maxProgressEvents: config.maxProgressEvents ?? 32,
  };
  const persistentWorldRoots = canonicalPersistentWorldRoots(config.persistentWorldRoots);
  const extensionToolIds = new Map<string, ToolId>();
  for (const definition of config.extensionTools ?? []) {
    agentSchemas.toolDefinition.parse(definition);
    if (!extensionToolMatchesExistingCapability(definition)) {
      throw new TypeError(`Extension tool ${definition.toolId} does not use an existing capability schema.`);
    }
    if (definition.toolId in TOOL_CAPABILITIES || extensionToolIds.has(definition.toolId)) {
      throw new TypeError(`Extension tool ${definition.toolId} collides with an existing tool.`);
    }
    extensionToolIds.set(
      definition.toolId,
      existingToolDefinitionForCapability(definition.capability).toolId as ToolId
    );
  }

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Security sequencing is intentionally linear so every tool shares one fail-closed policy/backup/approval gate.
    async execute(request: ExecuteInvocationRequest): Promise<ToolResult> {
      const invocationId = request.invocation?.invocationId ?? "invalid-invocation";
      const signal = request.signal ?? new AbortController().signal;
      let sequence = 0;
      const progress = async (message: string, percent?: number): Promise<void> => {
        if (!request.onProgress || sequence >= limits.maxProgressEvents) return;
        const event: ToolProgress = {
          schemaVersion: 1,
          invocationId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          message: message.slice(0, 256),
          ...(percent === undefined ? {} : { percent }),
        };
        await request.onProgress(event);
      };

      try {
        const invocation = agentSchemas.toolInvocation.parse(request.invocation);
        const policy = agentSchemas.permissionPolicy.parse(request.policy);
        const declaredToolId = invocation.toolId as ToolId;
        const toolId = declaredToolId in TOOL_CAPABILITIES ? declaredToolId : extensionToolIds.get(invocation.toolId);
        if (!toolId || TOOL_CAPABILITIES[toolId] !== invocation.capability)
          throw new Error("Tool and capability do not match");
        assertHostSecurityCapabilities(effects, toolId);
        assertKnownArguments(toolId, invocation.arguments);
        cancelled(signal);

        const workspace = await effects.canonicalize(limits.workspaceRoot);
        const scratchBase = await effects.canonicalize(config.scratchRoot);
        const scratch = await effects.canonicalize(path.posix.join(config.scratchRoot, invocation.sessionId));
        if (
          workspace.kind !== "directory" ||
          scratchBase.kind !== "directory" ||
          scratch.kind !== "directory" ||
          !contained(scratchBase.path, scratch.path)
        )
          throw new ExecutorGuardError(
            "Configured executor roots must be canonical directories and session scratch cannot escape its root.",
            "targetOutsideAllowedRoots"
          );

        let effect: ((effectSignal: AbortSignal) => Promise<HostEffectResult>) | undefined;
        let effectTimeoutMs = limits.maxFilesystemEffectMs;
        let mutation = false;
        let consoleMutation = false;
        const immutable = { ...NO_IMMUTABLE_BOUNDARY_VIOLATIONS };
        let shellMode: "read-only" | "staged-write" | undefined;
        if (isGenericImmutableAssetMutation(invocation)) immutable.targetImmutableAsset = true;
        let permissionScope = invocation.targetScope;
        const args = invocation.arguments;
        const pathKind = invocation.targetScope.kind;
        const root =
          pathKind === "workspace" ? workspace.path : pathKind === "session-scratch" ? scratch.path : undefined;

        if (toolId.startsWith("workspace.") || toolId === "extension.load") {
          if (!root)
            throw new ExecutorGuardError(
              "File tools require workspace or session-scratch scope.",
              "targetOutsideAllowedRoots"
            );
          const target = await resolveConfinedPath(
            effects,
            root,
            stringArg(args, "path", 4096),
            toolId === "workspace.write"
              ? ["file", "missing"]
              : toolId === "workspace.delete"
                ? ["file", "directory"]
                : ["file"]
          );
          assertScope(invocation.targetScope, scopeForPath(pathKind, root, target.path));
          if (toolId === "workspace.read")
            effect = (effectSignal) =>
              effects.readFile(
                target.path,
                integerArg(args, "maxBytes", limits.maxReadBytes, limits.maxReadBytes),
                effectSignal
              );
          if (toolId === "workspace.write") {
            const content = new TextEncoder().encode(stringArg(args, "content", limits.maxWriteBytes));
            mutation = true;
            effect = (effectSignal) =>
              effects.writeFile(target.path, content, effectSignal, request.assertCommitAllowed);
          }
          if (toolId === "workspace.delete") {
            mutation = true;
            effect = (effectSignal) =>
              effects.deletePath(target.path, args.recursive === true, effectSignal, request.assertCommitAllowed);
          }
          if (toolId === "extension.load") effect = (effectSignal) => effects.loadExtension(target.path, effectSignal);
        } else if (toolId === "shell.execute") {
          if (invocation.targetScope.kind !== "workspace")
            throw new ExecutorGuardError(
              "Shell scope must be the workspace root or exact staged target.",
              "targetOutsideAllowedRoots"
            );
          const shell = parseShellCommand(args);
          if (shell.mode === "read-only" && invocation.targetScope.normalizedTarget !== ".")
            throw new ExecutorGuardError(
              "Read-only shell scope must be the workspace root.",
              "targetOutsideAllowedRoots"
            );
          shellMode = shell.mode;
          effectTimeoutMs = shell.timeoutMs;
          mutation = shell.mode === "staged-write";
          if (shell.mode === "read-only") {
            effect = (effectSignal) =>
              effects.executeProcess({
                ...shell,
                cwd: workspace.path,
                maxOutputBytes: limits.maxOutputBytes,
                signal: effectSignal,
                onProgress: (bytes) =>
                  void progress(`Command produced ${Math.min(bytes, limits.maxOutputBytes)} bytes.`),
              });
          } else {
            const change = shell.change;
            if (!change)
              throw new ExecutorGuardError("Staged-write shell requires a change.", "targetOutsideAllowedRoots");
            const target = await resolveConfinedPath(
              effects,
              workspace.path,
              change.path,
              change.operation === "replace" ? ["file", "missing"] : ["file"]
            );
            assertScope(invocation.targetScope, scopeForPath("workspace", workspace.path, target.path));
            if (isImmutableAgentAssetPath(change.path) || isShellImmutableTarget(change.path))
              immutable.targetImmutableAsset = true;
            const targetInvocation: ToolInvocation = {
              ...invocation,
              targetScope: scopeForPath("workspace", workspace.path, target.path),
              arguments: {
                path: change.path,
                ...(change.operation === "replace" ? { content: "[runner result]" } : { recursive: false }),
              },
            };
            if (
              isRootServerPropertiesMutation(targetInvocation) ||
              isPersistentWorldPath(change.path, persistentWorldRoots)
            ) {
              return result(
                invocationId,
                "failed",
                "This shell change requires the stopped-host maintenance boundary.",
                {
                  code: "maintenance-required",
                  change: { operation: change.operation, path: change.path },
                }
              );
            }
            // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Staged shell execution must validate and commit the untrusted runner result in one fail-closed boundary.
            effect = async (effectSignal) => {
              const runnerResult = await effects.executeProcess({
                ...shell,
                cwd: workspace.path,
                maxOutputBytes: limits.maxOutputBytes,
                signal: effectSignal,
                onProgress: (bytes) =>
                  void progress(`Command produced ${Math.min(bytes, limits.maxOutputBytes)} bytes.`),
              });
              const runnerOutput = shellOutput(runnerResult);
              if (runnerOutput.exitCode !== 0) return runnerResult;
              let committed: HostEffectResult;
              if (change.operation === "replace") {
                const staged = runnerResult.stagedResult;
                if (
                  !staged ||
                  staged.regularFile !== true ||
                  staged.noLink !== true ||
                  staged.bytes.byteLength > limits.maxWriteBytes ||
                  !/^[a-f0-9]{64}$/.test(staged.sha256) ||
                  (await digestBytes(staged.bytes)) !== staged.sha256
                ) {
                  throw new ExecutorGuardError(
                    "Shell runner staged output failed regular-file validation.",
                    "targetOutsideAllowedRoots"
                  );
                }
                committed = await effects.writeFile(
                  target.path,
                  staged.bytes,
                  effectSignal,
                  request.assertCommitAllowed
                );
              } else {
                committed = await effects.deletePath(target.path, false, effectSignal, request.assertCommitAllowed);
              }
              return {
                summary: `Staged shell ${change.operation} committed after runner validation.`,
                output: { runner: runnerResult.output, change: committed.output },
                evidence: [...runnerResult.evidence, ...committed.evidence].slice(0, 32),
                mutationCommit: committed.mutationCommit,
              };
            };
          }
        } else if (toolId === "console.execute") {
          if (invocation.targetScope.kind !== "console")
            throw new ExecutorGuardError("Console tool requires console scope.", "targetOutsideAllowedRoots");
          const command = stringArg(args, "command", 4096);
          if (/[\r\n\0]/.test(command))
            throw new ExecutorGuardError(
              "Console commands must contain exactly one line.",
              "targetOutsideAllowedRoots"
            );
          const console = inspectMinecraftCommand(command);
          if (console.permissionAdministration)
            throw new ExecutorGuardError("Console privilege administration is immutable.", "requestsRoot");
          consoleMutation = !console.readOnly;
          mutation = consoleMutation;
          effectTimeoutMs = integerArg(args, "timeoutMs", limits.maxTimeoutMs, limits.maxTimeoutMs);
          effect = async (effectSignal) =>
            effects.executeConsole(
              command,
              effectTimeoutMs,
              effectSignal,
              request.assertCommitAllowed,
              request.runtimeContext
                ? {
                    schemaVersion: 1,
                    runtimeId: request.runtimeContext.runtimeId,
                    leaseId: request.runtimeContext.leaseId,
                    leaseGeneration: request.runtimeContext.leaseGeneration,
                    taskId: request.runtimeContext.taskId,
                    sessionId: invocation.sessionId,
                    invocationId: invocation.invocationId,
                    invocationDigest: await createInvocationDigest(invocation),
                  }
                : undefined
            );
        } else if (toolId === "maintenance.apply") {
          if (
            invocation.targetScope.kind !== "workspace" ||
            invocation.targetScope.normalizedTarget !== "server.properties"
          )
            throw new ExecutorGuardError(
              "Maintenance scope must be the exact server.properties file.",
              "targetOutsideAllowedRoots"
            );
          const maintenance = parseMaintenanceApplyArguments(args);
          mutation = true;
          effectTimeoutMs = EXECUTOR_EFFECT_MAX_BOUND_MS;
          effect = async (effectSignal) => {
            const backup = request.backupAuthorization;
            if (backup?.status !== "succeeded") throw new Error("Maintenance requires a completed backup fence.");
            const runtimeContext = request.runtimeContext;
            if (!runtimeContext) throw new Error("Maintenance requires an authenticated runtime context.");
            if (!effects.applyMaintenance) throw new Error("Narrow maintenance host broker is unavailable.");
            return await effects.applyMaintenance(
              {
                schemaVersion: 1,
                operation: "maintenance.apply",
                invocation: {
                  schemaVersion: 1,
                  runtimeId: runtimeContext.runtimeId,
                  leaseId: runtimeContext.leaseId,
                  leaseGeneration: runtimeContext.leaseGeneration,
                  taskId: runtimeContext.taskId,
                  sessionId: invocation.sessionId,
                  invocationId: invocation.invocationId,
                  invocationDigest: await createInvocationDigest(invocation),
                },
                backup,
                ...maintenance,
              },
              effectSignal,
              request.assertCommitAllowed
            );
          };
        } else if (toolId === "network.download") {
          if (!root)
            throw new ExecutorGuardError(
              "Download destination requires workspace or session-scratch scope.",
              "targetOutsideAllowedRoots"
            );
          const destination = await resolveConfinedPath(effects, root, stringArg(args, "destination", 4096), [
            "file",
            "missing",
          ]);
          assertScope(invocation.targetScope, scopeForPath(pathKind, root, destination.path));
          const url = validateDownloadUrl(stringArg(args, "url", 8192));
          const maxBytes = integerArg(args, "maxBytes", limits.maxDownloadBytes, limits.maxDownloadBytes);
          const expectation = validateDownloadExpectation({
            expectedSha256: args.expectedSha256,
            expectedBytes: args.expectedBytes,
          });
          if (expectation.expectedBytes > maxBytes) {
            throw new ExecutorGuardError(
              "Expected download size exceeds the requested byte bound.",
              "targetOutsideAllowedRoots"
            );
          }
          permissionScope = scopeForDownload(url, invocation.targetScope, expectation);
          mutation = true;
          effectTimeoutMs = integerArg(args, "timeoutMs", limits.maxTimeoutMs, limits.maxTimeoutMs);
          effect = (effectSignal) =>
            effects.download({
              invocationId: invocation.invocationId,
              sessionId: invocation.sessionId,
              url: url.toString(),
              destination: destination.path,
              timeoutMs: effectTimeoutMs,
              maxBytes,
              expectedSha256: expectation.expectedSha256,
              expectedBytes: expectation.expectedBytes,
              rejectPrivateAddresses: true,
              ...(request.downloadAuthorization ? { authorization: request.downloadAuthorization } : {}),
              signal: effectSignal,
              onProgress: (bytes) => void progress(`Downloaded ${Math.min(bytes, limits.maxDownloadBytes)} bytes.`),
              assertCommitAllowed: request.assertCommitAllowed,
            });
        } else if (toolId === "backup.request") {
          if (invocation.targetScope.kind !== "workspace" || invocation.targetScope.normalizedTarget !== ".")
            throw new ExecutorGuardError("Backup scope must be the workspace root.", "targetOutsideAllowedRoots");
          effect = (effectSignal) => effects.requestBackup(stringArg(args, "label", 128), effectSignal);
        }
        if (!effect) throw new Error("Unsupported tool invocation");

        const risk = classifyRisk(invocation.capability, riskFacts(invocation, consoleMutation, persistentWorldRoots));
        const digest = await createInvocationDigest(invocation);
        const suppliedBackupAuthorization = request.backupAuthorization;
        if (toolId === "shell.execute" && shellMode === "staged-write") {
          const deniedCapability = (["workspace.write", "workspace.delete"] as const).find(
            (capability) => permissionDecisionForRisk(policy, capability, "destructive") === "deny"
          );
          if (deniedCapability) {
            return result(
              invocationId,
              "failed",
              `${deniedCapability} is denied by policy; staged shell cannot bypass it.`,
              {
                code: "denied",
                capability: deniedCapability,
              }
            );
          }
        }
        if (
          suppliedBackupAuthorization?.status === "succeeded" &&
          (!request.runtimeContext ||
            suppliedBackupAuthorization.runtimeId !== request.runtimeContext.runtimeId ||
            suppliedBackupAuthorization.leaseId !== request.runtimeContext.leaseId ||
            suppliedBackupAuthorization.leaseGeneration !== request.runtimeContext.leaseGeneration ||
            suppliedBackupAuthorization.taskId !== request.runtimeContext.taskId ||
            suppliedBackupAuthorization.sessionId !== invocation.sessionId ||
            suppliedBackupAuthorization.invocationId !== invocation.invocationId ||
            suppliedBackupAuthorization.invocationDigest !== digest ||
            !Number.isFinite(Date.parse(suppliedBackupAuthorization.issuedAt)) ||
            Date.parse(suppliedBackupAuthorization.expiresAt) <= Date.now())
        ) {
          return result(invocationId, "failed", "Backup fence authorization did not match the exact invocation.", {
            code: "backup-authorization-invalid",
          });
        }
        if (
          request.downloadAuthorization &&
          (request.downloadAuthorization.invocationId !== invocation.invocationId ||
            request.downloadAuthorization.sessionId !== invocation.sessionId ||
            request.downloadAuthorization.invocationDigest !== digest ||
            request.downloadAuthorization.expectedSha256 !== args.expectedSha256 ||
            request.downloadAuthorization.expectedBytes !== args.expectedBytes)
        ) {
          return result(invocationId, "failed", "Download authorization did not match the exact invocation.", {
            code: "download-authorization-invalid",
          });
        }
        if (
          toolId === "network.download" &&
          config.requireDownloadAuthorization === true &&
          !request.downloadAuthorization
        ) {
          return result(invocationId, "failed", "A gateway download grant is required for network effects.", {
            code: "download-authorization-required",
          });
        }
        for (const approval of request.approvals) {
          if ((await createInvocationSummaryDigest(approval.invocationSummary)) !== approval.invocationSummaryDigest) {
            throw new Error("Approval summary integrity check failed");
          }
        }
        const suppliedApprovalAuthorization = request.approvalAuthorization;
        const authorizationMatches = (approval: AgentApproval): boolean =>
          config.acceptGatewayAuthorizations === true &&
          !!request.runtimeContext &&
          suppliedApprovalAuthorization?.runtimeId === request.runtimeContext.runtimeId &&
          suppliedApprovalAuthorization.leaseId === request.runtimeContext.leaseId &&
          suppliedApprovalAuthorization.leaseGeneration === request.runtimeContext.leaseGeneration &&
          suppliedApprovalAuthorization.taskId === request.runtimeContext.taskId &&
          suppliedApprovalAuthorization?.approvalId === approval.approvalId &&
          suppliedApprovalAuthorization.invocationId === invocation.invocationId &&
          suppliedApprovalAuthorization.invocationDigest === digest &&
          suppliedApprovalAuthorization.sessionId === invocation.sessionId &&
          suppliedApprovalAuthorization.actorId === request.actorId &&
          suppliedApprovalAuthorization.policyId === policy.policyId &&
          suppliedApprovalAuthorization.policyRevision === policy.revision &&
          suppliedApprovalAuthorization.capability === invocation.capability &&
          suppliedApprovalAuthorization.targetScope.kind === permissionScope.kind &&
          suppliedApprovalAuthorization.targetScope.normalizedTarget === permissionScope.normalizedTarget &&
          suppliedApprovalAuthorization.risk === risk &&
          suppliedApprovalAuthorization.approvalKind ===
            (approval.scope.kind === "session-capability" ? "ask-once" : "ask-always") &&
          Number.isFinite(Date.parse(suppliedApprovalAuthorization.issuedAt)) &&
          Date.parse(suppliedApprovalAuthorization.expiresAt) > Date.now();
        const evaluationApprovals = request.approvals.map((approval) => {
          if (
            authorizationMatches(approval) &&
            approval.scope.kind === "single-invocation" &&
            approval.invocationDigest === digest &&
            approval.decision === "approved"
          ) {
            const { consumedAt: _consumedAt, ...activeApproval } = approval;
            return activeApproval;
          }
          return approval;
        });
        const decision = evaluatePermission({
          policy,
          actorId: request.actorId,
          sessionId: invocation.sessionId,
          invocationDigest: digest,
          capability: invocation.capability,
          targetScope: permissionScope,
          risk,
          immutableBoundary: immutable,
          approvals: evaluationApprovals,
          now: new Date().toISOString(),
        });
        if (decision.outcome !== "allow")
          return result(invocationId, "failed", decision.reason, {
            code: decision.outcome === "deny" ? "denied" : "approval-required",
            decision: decision as unknown as JsonValue,
            invocationDigest: digest,
            sessionId: invocation.sessionId,
            policyId: policy.policyId,
            policyRevision: policy.revision,
          });
        const boundary = findImmutableBoundaryViolation(immutable);
        if (boundary)
          throw new ExecutorGuardError(`Immutable boundary denied ${boundary}.`, "targetOutsideAllowedRoots");
        await progress("Policy checks passed.", 20);
        cancelled(signal);

        if (decision.approvalId) {
          const approval = request.approvals.find((item) => item.approvalId === decision.approvalId) as
            | AgentApproval
            | undefined;
          if (approval && config.acceptGatewayAuthorizations === true && !authorizationMatches(approval)) {
            return result(invocationId, "failed", "An authoritative invocation authorization is required.", {
              code: "invocation-authorization-required",
              approvalId: approval.approvalId,
              invocationDigest: digest,
              capability: invocation.capability,
              targetKind: permissionScope.kind,
              normalizedTarget: permissionScope.normalizedTarget,
              risk,
            });
          }
          if (approval?.scope.kind === "single-invocation") {
            const authorizedByGateway = authorizationMatches(approval);
            if (
              !authorizedByGateway &&
              (!approvalConsumer ||
                !(await approvalConsumer.consume(
                  approval.approvalId,
                  invocation.sessionId,
                  digest,
                  new Date().toISOString()
                )))
            )
              return result(
                invocationId,
                "failed",
                "Single-invocation approval was stale or already consumed; replay rejected.",
                { code: "approval-replay" }
              );
          }
        }
        cancelled(signal);

        if (toolId === "backup.request" && config.externalBackupCoordinator === true) {
          const authorization = request.backupAuthorization;
          if (!authorization) {
            return result(invocationId, "failed", "A gateway-coordinated backup is required.", {
              code: "backup-required",
              invocationDigest: digest,
              risk,
            });
          }
          if (authorization.invocationDigest !== digest) {
            return result(invocationId, "failed", "Backup authorization did not match the invocation.", {
              code: "backup-authorization-invalid",
            });
          }
          if (authorization.status === "proceed-without-backup") {
            const proceedApproval = request.approvals.find(
              (approval) =>
                approval.approvalId === authorization.approvalId &&
                approval.scope.kind === "single-invocation" &&
                approval.scope.capability === "backup.create" &&
                approval.invocationDigest === digest &&
                approval.decision === "approved" &&
                approval.consumedAt !== undefined &&
                approval.consumedAt === authorization.consumedAt
            );
            if (!proceedApproval) {
              return result(invocationId, "failed", "Backup failure requires a consumed operator decision.", {
                code: "backup-decision-invalid",
              });
            }
            return result(invocationId, "succeeded", "Operator approved proceeding without a backup.", {
              status: "proceed-without-backup",
              approvalId: proceedApproval.approvalId,
            });
          }
          return result(invocationId, "succeeded", "Gateway-coordinated backup completed.", {
            status: "succeeded",
            backupId: authorization.backupId,
          });
        }

        const backup = evaluateBackup(policy.backupMode, risk, mutation);
        if (backup.outcome === "create-backup") {
          if (config.externalBackupCoordinator === true) {
            const authorization = request.backupAuthorization;
            if (!authorization) {
              return result(invocationId, "failed", backup.reason, {
                code: "backup-required",
                invocationDigest: digest,
                risk,
              });
            }
            if (authorization.invocationDigest !== digest) {
              return result(invocationId, "failed", "Backup authorization did not match the invocation.", {
                code: "backup-authorization-invalid",
              });
            }
            if (authorization.status === "proceed-without-backup") {
              const proceedApproval = request.approvals.find(
                (approval) =>
                  approval.approvalId === authorization.approvalId &&
                  approval.scope.kind === "single-invocation" &&
                  approval.scope.capability === "backup.create" &&
                  approval.invocationDigest === digest &&
                  approval.decision === "approved" &&
                  approval.consumedAt !== undefined &&
                  approval.consumedAt === authorization.consumedAt
              );
              if (!proceedApproval) {
                return result(invocationId, "failed", "Backup failure requires a consumed operator decision.", {
                  code: "backup-decision-invalid",
                });
              }
            }
          } else {
            await progress("Creating required backup.", 35);
            let backupResult: HostEffectResult;
            try {
              backupResult = await effects.requestBackup(`before-${invocation.invocationId}`, signal);
            } catch {
              return result(
                invocationId,
                "failed",
                evaluateBackup(policy.backupMode, risk, mutation, "failed").reason,
                {
                  code: "backup-paused",
                  backupStatus: "failed",
                }
              );
            }
            if ((backupResult.output as { status?: unknown }).status !== "succeeded")
              return result(
                invocationId,
                "failed",
                evaluateBackup(policy.backupMode, risk, mutation, "unavailable").reason,
                { code: "backup-paused", backupStatus: "unavailable" },
                backupResult.evidence.slice(0, 32)
              );
          }
        }
        cancelled(signal);

        if (toolId === "maintenance.apply" && suppliedBackupAuthorization?.status !== "succeeded") {
          return result(
            invocationId,
            "failed",
            "Maintenance requires a completed backup; automatic proceed without backup is not supported.",
            { code: "maintenance-backup-required" }
          );
        }

        await progress("Executing guarded host effect.", 60);
        if (
          mutation &&
          suppliedBackupAuthorization?.status === "succeeded" &&
          config.externalBackupCoordinator === true &&
          !request.assertCommitAllowed
        ) {
          return result(invocationId, "failed", "Renewable lifecycle fence validation is unavailable.", {
            code: "backup-fence-validator-required",
          });
        }
        const timeoutController = new AbortController();
        const timer = setTimeout(
          () => timeoutController.abort(new DOMException("Executor effect timed out", "TimeoutError")),
          effectTimeoutMs
        );
        timer.unref?.();
        const effectSignal = AbortSignal.any([signal, timeoutController.signal]);
        let hostResult: HostEffectResult;
        try {
          hostResult = await effect(effectSignal);
        } finally {
          clearTimeout(timer);
        }
        const committed = hostResult.mutationCommit?.committed === true;
        if (!committed) cancelled(signal);
        const evidence = hostResult.evidence.slice(0, 32).map((item) => agentSchemas.evidenceReference.parse(item));
        if (committed) await progress("Host effect committed.", 100).catch(() => undefined);
        else await progress("Host effect completed.", 100);
        return await boundToolResult(
          result(
            invocationId,
            "succeeded",
            hostResult.summary.slice(0, 512),
            hostResult.output,
            evidence,
            hostResult.mutationCommit
          )
        );
      } catch (error) {
        if (error instanceof IndeterminateHostEffectError) throw error;
        return failure(invocationId, error);
      }
    },
  };
}

export const DIRECT_LIVE_TOOL_IDS = Object.freeze(Object.keys(TOOL_CAPABILITIES) as ToolId[]);
export { AGENT_SCHEMA_VERSION };
