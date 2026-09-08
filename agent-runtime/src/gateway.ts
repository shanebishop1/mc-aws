import { createHash } from "node:crypto";
import type { AgentHarnessAdapter, AgentToolExecutorAdapter } from "@/lib/agent/adapters";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type {
  AgentApproval,
  AgentEvent,
  AgentEventKind,
  BackupTerminalReceipt,
  JsonObject,
  JsonValue,
  ProviderConfiguration,
  RiskClass,
  TargetScope,
  TerminalPublicationAuthorization,
  ToolCancellation,
  ToolInvocation,
  ToolProgress,
  ToolResult,
} from "@/lib/agent/contracts";
import type {
  DirectLiveExecutor,
  GatewayApprovalAuthorization,
  GatewayBackupAuthorization,
  RuntimeExecutionContext,
} from "@/lib/agent/executor";
import { inspectMinecraftCommand, riskFacts } from "@/lib/agent/executor/guards";
import { DEFAULT_PERSISTENT_WORLD_ROOTS, canonicalPersistentWorldRoots } from "@/lib/agent/minecraft-security";
import { exactNetworkDownloadResource, networkDownloadApprovalScope } from "@/lib/agent/network-download";
import {
  classifyRisk,
  createInvocationDigest,
  createInvocationSummaryDigest,
  createProposedInvocationSummary,
  permissionDecisionForRisk,
} from "@/lib/agent/policy";
import { ConfiguredSecretDetector, redactSensitiveText } from "@/lib/agent/redaction";
import { BACKUP_FENCE_RENEW_INTERVAL_MS } from "@/lib/agent/runtime/backup-fence";
import {
  RUNTIME_GATEWAY_RESPONSE_MAX_BYTES,
  type RuntimeApprovalConsumptionRequest,
  type RuntimeApprovalPublicationRequest,
  type RuntimeBackupCreateRequest,
  type RuntimeBackupFinalizeRequest,
  type RuntimeBackupFinalizeResult,
  type RuntimeBackupRenewRequest,
  type RuntimeBackupRenewResult,
  type RuntimeBackupResult,
  type RuntimeDecisionPollRequest,
  type RuntimeDecisionSnapshot,
  type RuntimeEventPublicationRequest,
  type RuntimeInvocationAuthorizationRequest,
  type RuntimeInvocationAuthorizationResult,
  type RuntimeLeaseMutationRequest,
  type RuntimeRecoveryPublicationRequest,
  type RuntimeRecoveryPublicationResult,
  type RuntimeRenewRequest,
  type RuntimeStatusPublicationRequest,
  type RuntimeWorkLeaseDto,
  type RuntimeWorkLeaseRequest,
} from "@/lib/agent/runtime/contracts";
import type { RuntimeAgentEventDraft } from "@/lib/agent/state";
import { agentSchemas } from "@/lib/agent/validators";

const MAX_CONTROL_RESPONSE_BYTES = RUNTIME_GATEWAY_RESPONSE_MAX_BYTES;
const MAX_PUBLISH_ATTEMPTS = 5;
const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONTROL_RETRY_BASE_DELAY_MS = 250;
const APPROVAL_TTL_MS = 15 * 60_000;
const MAX_HARNESS_CONTEXT_BYTES = 64_000;
const MAX_ASSISTANT_TURN_CHARS = 32_000;

async function readBoundedControlResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_CONTROL_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new RuntimeTransportError(502, false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > MAX_CONTROL_RESPONSE_BYTES) throw new RuntimeTransportError(502, false);
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RuntimeTransportError) throw error;
    throw new RuntimeTransportError(502, false);
  } finally {
    reader.releaseLock();
  }
}

export class RuntimeTransportError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean
  ) {
    super("Agent runtime control transport failed.");
    this.name = "RuntimeTransportError";
  }
}

export interface RuntimeControlTransport {
  leaseWork(input: RuntimeWorkLeaseRequest, signal?: AbortSignal): Promise<RuntimeWorkLeaseDto | null>;
  acknowledge(leaseId: string, input: RuntimeLeaseMutationRequest): Promise<number>;
  renew(leaseId: string, input: RuntimeRenewRequest): Promise<{ revision: number; expiresAt: string }>;
  publishEvents(leaseId: string, input: RuntimeEventPublicationRequest): Promise<number>;
  publishRecovery?(
    leaseId: string,
    input: RuntimeRecoveryPublicationRequest
  ): Promise<RuntimeRecoveryPublicationResult>;
  publishApproval(leaseId: string, input: RuntimeApprovalPublicationRequest): Promise<number>;
  consumeApproval(
    leaseId: string,
    input: RuntimeApprovalConsumptionRequest
  ): Promise<{ revision: number; consumedAt: string }>;
  authorizeInvocation(
    leaseId: string,
    input: RuntimeInvocationAuthorizationRequest
  ): Promise<RuntimeInvocationAuthorizationResult>;
  publishStatus(leaseId: string, input: RuntimeStatusPublicationRequest): Promise<number>;
  waitForDecision(
    leaseId: string,
    input: RuntimeDecisionPollRequest,
    signal?: AbortSignal
  ): Promise<RuntimeDecisionSnapshot>;
}

export interface RuntimeProviderProfileResolver {
  /** Resolves provider configuration and exact redaction values only in the gateway process. */
  resolve(
    profileId: string,
    profileFingerprint: string,
    model: string
  ): Promise<{
    configuration: ProviderConfiguration;
    exactSecrets: readonly string[];
  }>;
}

export interface RuntimeHarnessFactory {
  create(input: {
    toolExecutor: AgentToolExecutorAdapter;
    exactSecrets: readonly string[];
  }): AgentHarnessAdapter;
}

export interface RuntimeGatewayBackupAdapter {
  evaluateAvailability(signal?: AbortSignal): Promise<"available" | "unavailable">;
  create(input: RuntimeBackupCreateRequest, signal?: AbortSignal): Promise<RuntimeBackupResult>;
  finalize(input: RuntimeBackupFinalizeRequest, signal?: AbortSignal): Promise<RuntimeBackupFinalizeResult>;
  renew?(input: RuntimeBackupRenewRequest, signal?: AbortSignal): Promise<RuntimeBackupRenewResult>;
}

export interface RuntimeGatewayOptions {
  control: RuntimeControlTransport;
  executor: DirectLiveExecutor;
  backup: RuntimeGatewayBackupAdapter;
  providers: RuntimeProviderProfileResolver;
  harnesses: RuntimeHarnessFactory;
  /** Exact gateway-only runtime secrets added to provider values for redaction and pre-execution rejection. */
  runtimeExactSecrets?: readonly string[];
  /** Must match the executor's authoritative canonical workspace-relative world roots. */
  persistentWorldRoots?: readonly string[];
  leaseDurationMs?: number;
  workWaitMs?: number;
  decisionWaitMs?: number;
  now?: () => Date;
  createId?: () => string;
  /** Test-only seam; production leaves lease/cancellation monitoring enabled. */
  monitorLease?: boolean;
  /** Test seam; production uses the bounded signed-permit renewal interval. */
  fenceRenewIntervalMs?: number;
}

function asRecord(value: JsonValue): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isWaitingResult(result: ToolResult): boolean {
  const output = asRecord(result.output);
  return (
    result.status === "failed" &&
    (output?.code === "approval-required" ||
      output?.code === "backup-required" ||
      output?.code === "invocation-authorization-required")
  );
}

function resultDigest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function failed(invocation: ToolInvocation, now: () => Date, summary: string, code: string): ToolResult {
  return {
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    status: "failed",
    completedAt: now().toISOString(),
    summary,
    output: { code },
    evidence: [],
  };
}

function indeterminate(invocation: ToolInvocation, now: () => Date, summary: string): ToolResult {
  return {
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    status: "indeterminate",
    completedAt: now().toISOString(),
    summary,
    output: { code: "backup-fence-finalization-indeterminate", reconciliation: "required" },
    evidence: [],
  };
}

function stableId(prefix: string, taskId: string, digest: string, attempt: number): string {
  const task = createHash("sha256").update(taskId).digest("hex").slice(0, 16);
  return `${prefix}-${task}-${digest.slice(0, 48)}-${attempt}`;
}

class LeaseSession {
  revision: number;
  approvals: AgentApproval[];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly work: RuntimeWorkLeaseDto,
    readonly workControl: RuntimeControlTransport
  ) {
    this.revision = work.revision;
    this.approvals = structuredClone(work.approvals);
  }

  mutationBase(idempotencyKey: string): RuntimeLeaseMutationRequest {
    return {
      schemaVersion: 1,
      sessionId: this.work.session.sessionId,
      taskId: this.work.task.taskId,
      expectedRevision: this.revision,
      idempotencyKey,
    };
  }

  async mutate(operation: (base: RuntimeLeaseMutationRequest) => Promise<number>, key: string): Promise<void> {
    let failure: unknown;
    const scopedKey = this.scopedIdempotencyKey(key);
    const run = this.queue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          this.revision = await operation(this.mutationBase(scopedKey));
          return;
        } catch (error) {
          failure = error;
          if (!(error instanceof RuntimeTransportError) || error.status !== 409 || attempt > 0) throw error;
          const snapshot = await this.workControl.waitForDecision(this.work.lease.leaseId, {
            schemaVersion: 1,
            sessionId: this.work.session.sessionId,
            taskId: this.work.task.taskId,
            afterRevision: 1,
            waitMs: 0,
          });
          this.revision = snapshot.revision;
          this.approvals = snapshot.approvals;
        }
      }
      throw failure;
    });
    this.queue = run.catch(() => undefined);
    await run;
  }

  private scopedIdempotencyKey(key: string): string {
    const task = createHash("sha256").update(this.work.task.taskId).digest("hex").slice(0, 32);
    const operation = createHash("sha256").update(key).digest("hex");
    return `runtime:${task}:${this.work.lease.generation}:${operation}`;
  }

  async decision(waitMs: number, signal?: AbortSignal): Promise<RuntimeDecisionSnapshot> {
    const snapshot = await this.workControl.waitForDecision(
      this.work.lease.leaseId,
      {
        schemaVersion: 1,
        sessionId: this.work.session.sessionId,
        taskId: this.work.task.taskId,
        afterRevision: this.revision,
        waitMs,
      },
      signal
    );
    if (snapshot.revision >= this.revision) {
      this.revision = snapshot.revision;
      this.approvals = snapshot.approvals;
    }
    return snapshot;
  }
}

class RuntimeDraftPublisher {
  private ordinal: number;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private cancellationFenced = false;
  private readonly proposals = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: unknown) => void;
      publicationStarted: boolean;
    }
  >();

  constructor(private readonly lease: LeaseSession) {
    this.ordinal = lease.work.task.runtimeEventOrdinal ?? 0;
  }

  publish(kind: AgentEventKind, payload: JsonObject, timestamp: string, draftId: string): Promise<void> {
    const publication = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      if (this.cancellationFenced) throw new Error("Runtime event publication is fenced after cancellation.");
      const draft: RuntimeAgentEventDraft = {
        schemaVersion: 1,
        draftId,
        ordinal: this.ordinal + 1,
        timestamp,
        kind,
        payload,
      };
      try {
        await this.publishDraft(draft);
        this.ordinal = draft.ordinal;
      } catch (error) {
        this.failure = error;
        throw error;
      }
    });
    this.queue = publication;
    return publication;
  }

  fenceForCancellation(): void {
    this.cancellationFenced = true;
  }

  async publishCancellationResult(event: AgentEvent): Promise<void> {
    const result = event.kind === "tool-result" ? agentSchemas.toolResult.safeParse(event.payload.data) : undefined;
    if (!result?.success || isWaitingResult(result.data))
      throw new Error("Cancellation reconciliation requires an exact terminal result.");
    this.fenceForCancellation();
    await this.queue.catch(() => undefined);
    const draft: RuntimeAgentEventDraft = {
      schemaVersion: 1,
      draftId: event.eventId,
      ordinal: this.ordinal + 1,
      timestamp: event.timestamp,
      kind: event.kind,
      payload: event.payload.data,
    };
    await this.publishDraft(draft);
    this.ordinal = draft.ordinal;
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  private async publishDraft(draft: RuntimeAgentEventDraft): Promise<void> {
    await this.lease.mutate(
      async (base) =>
        await this.lease.workControl.publishEvents(this.lease.work.lease.leaseId, {
          ...base,
          drafts: [draft],
        }),
      `event:${draft.draftId}`
    );
  }

  async publishHarness(event: AgentEvent): Promise<void> {
    let payload = event.payload.data;
    if (event.kind === "tool-proposal" && typeof payload.invocationDigest !== "string") {
      const invocation = agentSchemas.toolInvocation.parse({
        schemaVersion: 1,
        invocationId: payload.invocationId,
        sessionId: event.sessionId,
        toolId: payload.toolId,
        capability: payload.capability,
        targetScope: payload.targetScope,
        arguments: payload.arguments,
        requestedAt: payload.requestedAt,
      });
      payload = { ...payload, invocationDigest: await createInvocationDigest(invocation) };
    }
    const publication = this.publish(event.kind, payload, event.timestamp, event.eventId);
    if (event.kind === "tool-proposal") {
      const invocationId = event.payload.data.invocationId;
      if (typeof invocationId === "string") {
        const proposal = this.proposal(invocationId);
        if (!proposal.publicationStarted) {
          proposal.publicationStarted = true;
          publication.then(proposal.resolve, proposal.reject);
        }
      }
    }
    await publication;
  }

  async waitForProposal(invocationId: string): Promise<void> {
    await this.proposal(invocationId).promise;
  }

  private proposal(invocationId: string) {
    const existing = this.proposals.get(invocationId);
    if (existing) return existing;
    let resolve: (() => void) | undefined;
    let reject: ((error: unknown) => void) | undefined;
    const proposal = {
      promise: new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      }),
      resolve: () => resolve?.(),
      reject: (error: unknown) => reject?.(error),
      publicationStarted: false,
    };
    this.proposals.set(invocationId, proposal);
    return proposal;
  }
}

class OrchestratedToolExecutor implements AgentToolExecutorAdapter {
  readonly reconciliationTimeoutMs: number;
  private readonly backupAuthorizations = new Map<string, GatewayBackupAuthorization>();
  private readonly approvalAuthorizations = new Map<string, GatewayApprovalAuthorization>();
  private readonly terminalStates = new Map<
    string,
    {
      request: import("@/lib/agent/executor").ExecuteInvocationRequest;
      result: ToolResult;
      terminalReceipt: BackupTerminalReceipt;
      authorization?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>;
    }
  >();
  private readonly secretDetector: ConfiguredSecretDetector;

  constructor(
    private readonly lease: LeaseSession,
    private readonly executor: DirectLiveExecutor,
    private readonly backup: RuntimeGatewayBackupAdapter,
    private readonly publisher: RuntimeDraftPublisher,
    private readonly decisionWaitMs: number,
    private readonly fenceRenewIntervalMs: number,
    private readonly now: () => Date,
    private readonly exactSecrets: readonly string[],
    private readonly persistentWorldRoots: readonly string[]
  ) {
    this.reconciliationTimeoutMs =
      (executor as DirectLiveExecutor & { reconciliationTimeoutMs?: number }).reconciliationTimeoutMs ?? 120_000;
    this.secretDetector = new ConfiguredSecretDetector(exactSecrets);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Approval, backup, and exact retry gates stay linear and fail closed around one invocation.
  async invoke(
    invocation: ToolInvocation,
    onProgress: (progress: ToolProgress) => void,
    signal: AbortSignal
  ): Promise<ToolResult> {
    await this.publisher.waitForProposal(invocation.invocationId);
    if (this.secretDetector.contains(invocation as unknown as JsonValue)) {
      await this.synthetic("policy", {
        invocationId: invocation.invocationId,
        outcome: "deny",
        code: "configured-secret-material",
        reason: "Configured secret material was rejected before executor dispatch.",
      });
      return failed(
        invocation,
        this.now,
        "Configured secret material was rejected before executor dispatch.",
        "configured-secret-material"
      );
    }
    for (let pass = 0; pass < 6; pass++) {
      const backupAuthorization = this.backupAuthorizations.get(invocation.invocationId);
      if (signal.aborted) {
        if (backupAuthorization?.status === "succeeded") {
          return indeterminate(
            invocation,
            this.now,
            "Cancellation arrived before an authoritative executor journal terminal; lifecycle fence retained."
          );
        }
        return failed(invocation, this.now, "Tool execution cancelled.", "cancelled");
      }
      const executionRequest = {
        actorId: this.lease.work.session.actorId,
        invocation,
        policy: this.lease.work.policySnapshot,
        approvals: this.lease.approvals,
        signal,
        onProgress,
        approvalAuthorization: this.approvalAuthorizations.get(invocation.invocationId),
        backupAuthorization,
        runtimeContext: {
          runtimeId: this.lease.work.lease.runtimeId,
          leaseId: this.lease.work.lease.leaseId,
          leaseGeneration: this.lease.work.lease.generation,
          taskId: this.lease.work.task.taskId,
        },
      };
      const durableExecutor = this.executor as DirectLiveExecutor & {
        prepareExecutionHandoff?(request: typeof executionRequest, runtimeId: string): Promise<void>;
      };
      await durableExecutor.prepareExecutionHandoff?.(executionRequest, this.lease.work.lease.runtimeId);
      let result =
        backupAuthorization?.status === "succeeded"
          ? await this.executeWithFenceRenewal(executionRequest, backupAuthorization)
          : await this.executor.execute(executionRequest);
      if (backupAuthorization?.status === "succeeded") {
        if (result.status === "indeterminate") {
          const reconciler = this.executor as DirectLiveExecutor & {
            reconcile?(request: typeof executionRequest): Promise<ToolResult>;
          };
          if (reconciler.reconcile) result = await reconciler.reconcile(executionRequest);
        }
        const finalAuthorization = this.backupAuthorizations.get(invocation.invocationId);
        if (finalAuthorization?.status !== "succeeded") {
          return indeterminate(
            invocation,
            this.now,
            "Host effect finished without the latest lifecycle fence generation."
          );
        }
        await this.rememberTerminal(executionRequest, result, finalAuthorization);
        return result;
      }
      const output = asRecord(result.output);
      const code = output?.code;
      if (code === "invocation-authorization-required") {
        const digest = await createInvocationDigest(invocation);
        const approvalId = output?.approvalId;
        const targetScope = this.expectedDecisionScope(invocation);
        const risk = classifyRisk(
          invocation.capability,
          riskFacts(
            invocation,
            invocation.capability === "console.execute" &&
              !inspectMinecraftCommand(String(invocation.arguments.command)).readOnly,
            this.persistentWorldRoots
          )
        );
        if (
          typeof approvalId !== "string" ||
          output?.invocationDigest !== digest ||
          output?.risk !== risk ||
          output?.capability !== invocation.capability ||
          output?.targetKind !== targetScope.kind ||
          output?.normalizedTarget !== targetScope.normalizedTarget
        ) {
          return failed(
            invocation,
            this.now,
            "Invocation authorization request failed closed.",
            "authorization-invalid"
          );
        }
        await this.publishExactProposal(invocation, digest, risk, targetScope);
        const authorization = await this.authorize(invocation, digest, approvalId, risk, targetScope);
        this.approvalAuthorizations.set(invocation.invocationId, authorization);
        continue;
      }
      if (code === "approval-required") {
        const digest = await createInvocationDigest(invocation);
        const parsedDecision = agentSchemas.evaluatedPermissionDecision.safeParse(output?.decision);
        const decision = parsedDecision.success ? parsedDecision.data : undefined;
        const expectedScope = this.expectedDecisionScope(invocation);
        const expectedRisk = classifyRisk(
          invocation.capability,
          riskFacts(
            invocation,
            invocation.capability === "console.execute" &&
              !inspectMinecraftCommand(String(invocation.arguments.command)).readOnly,
            this.persistentWorldRoots
          )
        );
        const expectedApprovalKind = permissionDecisionForRisk(
          this.lease.work.policySnapshot,
          invocation.capability,
          expectedRisk
        );
        if (
          !decision ||
          decision.outcome !== "require-approval" ||
          decision.capability !== invocation.capability ||
          (decision.approvalKind !== "ask-once" && decision.approvalKind !== "ask-always") ||
          decision.approvalKind !== expectedApprovalKind ||
          decision.risk !== expectedRisk ||
          decision.targetScope.kind !== expectedScope.kind ||
          decision.targetScope.normalizedTarget !== expectedScope.normalizedTarget ||
          output?.invocationDigest !== digest ||
          output?.sessionId !== invocation.sessionId ||
          output?.policyId !== this.lease.work.policySnapshot.policyId ||
          output?.policyRevision !== this.lease.work.policySnapshot.revision
        ) {
          return failed(invocation, this.now, "Approval request failed closed.", "approval-invalid");
        }
        const approval = await this.requestDecision(
          invocation,
          digest,
          decision.risk,
          decision.approvalKind,
          decision.targetScope,
          signal,
          pass
        );
        if (!approval || approval.decision !== "approved") {
          return failed(invocation, this.now, "Operator approval was not granted.", "approval-denied");
        }
        await this.resume();
        this.approvalAuthorizations.set(
          invocation.invocationId,
          await this.authorize(invocation, digest, approval.approvalId, decision.risk, decision.targetScope)
        );
        continue;
      }
      if (code === "backup-required") {
        const digest = output?.invocationDigest;
        const risk = output?.risk;
        if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || !this.isRisk(risk)) {
          return failed(invocation, this.now, "Backup request failed closed.", "backup-invalid");
        }
        const existing = this.backupAuthorizations.get(invocation.invocationId);
        if (existing) continue;
        const handoff = this.executor as DirectLiveExecutor & {
          prepareBackupHandoff?(request: typeof executionRequest, runtimeId: string): Promise<void>;
          authorizeBackupHandoff?(
            request: typeof executionRequest,
            authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
          ): Promise<void>;
          abandonBackupHandoff?(
            invocationId: string,
            runtimeContext: NonNullable<typeof executionRequest.runtimeContext>
          ): Promise<void>;
        };
        let backupFailure: "failed" | undefined;
        await this.synthetic("backup", {
          invocationId: invocation.invocationId,
          invocationDigest: digest,
          status: "requested",
        });
        try {
          if ((await this.backup.evaluateAvailability(signal)) !== "available") {
            await this.synthetic("backup", { invocationId: invocation.invocationId, status: "unavailable" });
            return failed(invocation, this.now, "Required backup is unavailable.", "backup-unavailable");
          }
          const backupRequest: RuntimeBackupCreateRequest = {
            schemaVersion: 1,
            action: "create",
            leaseId: this.lease.work.lease.leaseId,
            leaseGeneration: this.lease.work.lease.generation,
            sessionId: invocation.sessionId,
            taskId: this.lease.work.task.taskId,
            invocationId: invocation.invocationId,
            invocationDigest: digest,
          };
          await handoff.prepareBackupHandoff?.(executionRequest, this.lease.work.lease.runtimeId);
          const created = await this.backup.create(backupRequest, signal);
          if (created.status !== "succeeded") {
            if (created.status === "failed") {
              backupFailure = "failed";
              await handoff.abandonBackupHandoff?.(invocation.invocationId, executionRequest.runtimeContext);
              throw new Error("Runtime backup reached a terminal failure.");
            }
            if (created.status === "cancelled" || created.status === "unavailable") {
              await handoff.abandonBackupHandoff?.(invocation.invocationId, executionRequest.runtimeContext);
            }
            await this.synthetic("backup", { invocationId: invocation.invocationId, status: created.status });
            return failed(
              invocation,
              this.now,
              created.status === "cancelled"
                ? "Required backup was cancelled."
                : "Required backup did not reach a safe terminal result.",
              `backup-${created.status}`
            );
          }
          if (
            !created.backupId ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(created.backupId) ||
            !created.createdAt ||
            !Number.isFinite(Date.parse(created.createdAt)) ||
            !created.fenceAuthorization ||
            created.leaseId !== backupRequest.leaseId ||
            created.leaseGeneration !== backupRequest.leaseGeneration ||
            created.sessionId !== backupRequest.sessionId ||
            created.taskId !== backupRequest.taskId ||
            created.invocationId !== backupRequest.invocationId ||
            created.invocationDigest !== backupRequest.invocationDigest
          ) {
            throw new Error("Runtime backup result did not match its invocation binding.");
          }
          const fence = created.fenceAuthorization;
          if (
            fence.runtimeId !== this.lease.work.lease.runtimeId ||
            fence.leaseId !== backupRequest.leaseId ||
            fence.leaseGeneration !== backupRequest.leaseGeneration ||
            fence.sessionId !== backupRequest.sessionId ||
            fence.taskId !== backupRequest.taskId ||
            fence.invocationId !== backupRequest.invocationId ||
            fence.invocationDigest !== backupRequest.invocationDigest ||
            fence.backupId !== created.backupId ||
            Date.parse(fence.expiresAt) <= this.now().getTime()
          ) {
            throw new Error("Runtime backup fence did not match its invocation binding.");
          }
          if (!handoff.prepareBackupHandoff || !handoff.authorizeBackupHandoff) {
            return indeterminate(invocation, this.now, "Durable backup-to-executor handoff protocol is unavailable.");
          }
          await handoff.authorizeBackupHandoff({ ...executionRequest, backupAuthorization: fence }, fence);
          this.backupAuthorizations.set(invocation.invocationId, fence);
          await this.synthetic("backup", {
            invocationId: invocation.invocationId,
            status: "succeeded",
            backupId: created.backupId,
          });
          continue;
        } catch {
          if (backupFailure !== "failed") {
            await this.synthetic("backup", { invocationId: invocation.invocationId, status: "ambiguous" });
            return failed(invocation, this.now, "Required backup state is ambiguous.", "backup-ambiguous");
          }
        }
        await this.synthetic("backup", { invocationId: invocation.invocationId, status: backupFailure });
        const approval = await this.requestBackupDecision(invocation, digest, risk, backupFailure, signal, pass);
        if (!approval || approval.decision !== "approved") {
          return failed(invocation, this.now, "Operator cancelled after backup failure.", "backup-cancelled");
        }
        await this.resume();
        const consumedAt = await this.consume(approval, digest);
        this.backupAuthorizations.set(invocation.invocationId, {
          schemaVersion: 1,
          invocationDigest: digest,
          status: "proceed-without-backup",
          approvalId: approval.approvalId,
          consumedAt,
        });
        continue;
      }
      await this.rememberTerminal(executionRequest, result);
      return result;
    }
    return failed(invocation, this.now, "Runtime retry bound was reached.", "runtime-retry-bound");
  }

  private async executeWithFenceRenewal(
    executionRequest: Parameters<DirectLiveExecutor["execute"]>[0],
    initialAuthorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<ToolResult> {
    const managed = this.executor as DirectLiveExecutor & {
      probeFence?(
        request: Parameters<DirectLiveExecutor["execute"]>[0]
      ): Promise<"active" | "pending" | "reserved" | "terminal" | "not-started">;
      renewFence?(
        request: Parameters<DirectLiveExecutor["execute"]>[0],
        authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
      ): Promise<void>;
      revokeFence?(invocationId: string, runtimeContext?: RuntimeExecutionContext): Promise<void>;
    };
    if (!managed.probeFence || !managed.renewFence || !managed.revokeFence || !this.backup.renew) {
      return indeterminate(executionRequest.invocation, this.now, "Renewable executor fence protocol is unavailable.");
    }
    const stop = new AbortController();
    let authorization = initialAuthorization;
    let renewalFailed = false;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Renewal polling and executor journal fencing intentionally share one lifecycle.
    const renewal = (async () => {
      while (!stop.signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            stop.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, this.fenceRenewIntervalMs);
          timer.unref?.();
          stop.signal.addEventListener("abort", done, { once: true });
        });
        if (stop.signal.aborted) return;
        const journal = await managed.probeFence!(executionRequest);
        if (journal === "terminal" || journal === "not-started") return;
        const renewed = await this.backup.renew!({ schemaVersion: 1, action: "renew", authorization });
        if (renewed.status !== "renewed" || !renewed.authorization) {
          throw new Error("Lifecycle fence ownership was lost during executor activity.");
        }
        authorization = renewed.authorization;
        executionRequest.backupAuthorization = authorization;
        this.backupAuthorizations.set(executionRequest.invocation.invocationId, authorization);
        if (journal === "active") {
          try {
            await managed.renewFence!(executionRequest, authorization);
          } catch {
            const afterDeliveryLoss = await managed.probeFence!(executionRequest);
            if (afterDeliveryLoss === "terminal" || afterDeliveryLoss === "not-started") return;
            if (afterDeliveryLoss === "active") {
              // A lost response is safe to retry: the executor accepts the same
              // generation/signature idempotently and rejects changed bindings.
              await managed.renewFence!(executionRequest, authorization);
            }
          }
        }
      }
    })().catch(async () => {
      renewalFailed = true;
      await managed.revokeFence!(executionRequest.invocation.invocationId, executionRequest.runtimeContext).catch(
        () => undefined
      );
    });
    const result = await this.executor.execute(executionRequest);
    stop.abort();
    await renewal;
    if (renewalFailed) {
      return indeterminate(
        executionRequest.invocation,
        this.now,
        "Lifecycle fence renewal failed; executor commit remained fenced."
      );
    }
    return result;
  }

  async cancel(cancellation: ToolCancellation): Promise<void> {
    const cancellable = this.executor as DirectLiveExecutor & {
      cancel?(
        invocationId: string,
        runtimeContext?: RuntimeExecutionContext,
        request?: import("@/lib/agent/executor").ExecuteInvocationRequest
      ): Promise<{ result?: ToolResult; terminalReceipt?: BackupTerminalReceipt }>;
    };
    await cancellable.cancel?.(cancellation.invocationId, {
      runtimeId: this.lease.work.lease.runtimeId,
      leaseId: this.lease.work.lease.leaseId,
      leaseGeneration: this.lease.work.lease.generation,
      taskId: this.lease.work.task.taskId,
    });
  }

  terminalState(invocationId: string) {
    const state = this.terminalStates.get(invocationId);
    return state ? structuredClone(state) : undefined;
  }

  markTerminalComplete(invocationId: string): void {
    this.terminalStates.delete(invocationId);
    this.backupAuthorizations.delete(invocationId);
  }

  private async rememberTerminal(
    request: import("@/lib/agent/executor").ExecuteInvocationRequest,
    result: ToolResult,
    authorization?: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<void> {
    if (isWaitingResult(result)) return;
    const terminalReceipt = await (
      this.executor as DirectLiveExecutor & {
        terminalReceiptFor?(
          request: import("@/lib/agent/executor").ExecuteInvocationRequest,
          result: ToolResult
        ): Promise<BackupTerminalReceipt | undefined>;
      }
    ).terminalReceiptFor?.(request, result);
    if (!terminalReceipt) return;
    this.terminalStates.set(result.invocationId, {
      request: { ...request, signal: undefined, onProgress: undefined },
      result: structuredClone(result),
      terminalReceipt: structuredClone(terminalReceipt),
      ...(authorization ? { authorization: structuredClone(authorization) } : {}),
    });
  }

  async finalizeFence(
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>,
    outcome: RuntimeBackupFinalizeRequest["outcome"],
    terminalReceipt?: BackupTerminalReceipt
  ): Promise<void> {
    const result = await this.backup.finalize({
      schemaVersion: 1,
      action: "finalize",
      authorization,
      outcome,
      ...(terminalReceipt ? { terminalReceipt } : {}),
    });
    const expected =
      outcome === "indeterminate"
        ? result.status === "reconciliation-needed" && result.released === false
        : result.released === true;
    if (result.authorizationId !== authorization.authorizationId || !expected) {
      throw new Error("Runtime backup lifecycle fence was not released.");
    }
  }

  private async requestDecision(
    invocation: ToolInvocation,
    digest: string,
    risk: RiskClass,
    kind: "ask-once" | "ask-always",
    targetScope: TargetScope,
    signal: AbortSignal,
    attempt: number
  ): Promise<AgentApproval | null> {
    const invocationSummary = await createProposedInvocationSummary(invocation, risk, {
      exactSecrets: this.exactSecrets,
      targetScope,
      persistentWorldRoots: this.persistentWorldRoots,
    });
    const invocationSummaryDigest = await createInvocationSummaryDigest(invocationSummary);
    const matching = this.lease.approvals.find(
      (approval) =>
        approval.actorId === this.lease.work.session.actorId &&
        approval.sessionId === invocation.sessionId &&
        approval.policyId === this.lease.work.policySnapshot.policyId &&
        approval.policyRevision === this.lease.work.policySnapshot.revision &&
        approval.invocationDigest === digest &&
        approval.scope.kind === (kind === "ask-always" ? "single-invocation" : "session-capability") &&
        approval.scope.capability === invocation.capability &&
        approval.scope.risk === risk &&
        approval.scope.targetScope.kind === targetScope.kind &&
        approval.scope.targetScope.normalizedTarget === targetScope.normalizedTarget &&
        approval.invocationSummaryDigest === invocationSummaryDigest
    );
    if (matching) return await this.waitBoundApproval(matching.approvalId, digest, invocationSummaryDigest, signal);
    await this.publishInvocationSummary(invocationSummary, invocationSummaryDigest);
    const approval: AgentApproval = {
      schemaVersion: 1,
      approvalId: stableId("approval", this.lease.work.task.taskId, digest, attempt),
      actorId: this.lease.work.session.actorId,
      sessionId: invocation.sessionId,
      policyId: this.lease.work.policySnapshot.policyId,
      policyRevision: this.lease.work.policySnapshot.revision,
      invocationDigest: digest,
      invocationSummary,
      invocationSummaryDigest,
      scope: {
        schemaVersion: 1,
        kind: kind === "ask-always" ? "single-invocation" : "session-capability",
        capability: invocation.capability,
        targetScope,
        risk,
      },
      expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
      decision: "pending",
      reason: "Runtime requested an exact operator decision.",
    };
    await this.putApproval(approval);
    await this.synthetic("approval", {
      approvalId: approval.approvalId,
      invocationId: invocation.invocationId,
      decision: "pending",
      capability: invocation.capability,
    });
    return await this.waitBoundApproval(approval.approvalId, digest, invocationSummaryDigest, signal);
  }

  private async requestBackupDecision(
    invocation: ToolInvocation,
    digest: string,
    risk: RiskClass,
    status: "failed" | "unavailable",
    signal: AbortSignal,
    attempt: number
  ): Promise<AgentApproval | null> {
    const invocationSummary = await createProposedInvocationSummary(invocation, risk, {
      exactSecrets: this.exactSecrets,
      backupFailureStatus: status,
      persistentWorldRoots: this.persistentWorldRoots,
    });
    const invocationSummaryDigest = await createInvocationSummaryDigest(invocationSummary);
    await this.publishInvocationSummary(invocationSummary, invocationSummaryDigest);
    const approval: AgentApproval = {
      schemaVersion: 1,
      approvalId: stableId("backup-approval", this.lease.work.task.taskId, digest, attempt),
      actorId: this.lease.work.session.actorId,
      sessionId: invocation.sessionId,
      policyId: this.lease.work.policySnapshot.policyId,
      policyRevision: this.lease.work.policySnapshot.revision,
      invocationDigest: digest,
      invocationSummary,
      invocationSummaryDigest,
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: "backup.create",
        targetScope: invocation.targetScope,
        risk,
      },
      expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
      decision: "pending",
      reason: `Required backup ${status}; approve to proceed without it or deny to cancel.`,
    };
    await this.putApproval(approval);
    await this.synthetic("approval", {
      approvalId: approval.approvalId,
      invocationId: invocation.invocationId,
      decision: "pending",
      purpose: "backup-failure",
      backupStatus: status,
      invocationDigest: digest,
    });
    return await this.waitBoundApproval(approval.approvalId, digest, invocationSummaryDigest, signal);
  }

  private async putApproval(approval: AgentApproval): Promise<void> {
    agentSchemas.agentApproval.parse(approval);
    await this.lease.mutate(
      async (base) =>
        await this.lease.workControl.publishApproval(this.lease.work.lease.leaseId, { ...base, approval }),
      `approval:${approval.approvalId}`
    );
    this.lease.approvals = [...this.lease.approvals, approval];
  }

  private async waitApproval(approvalId: string, signal: AbortSignal): Promise<AgentApproval | null> {
    while (!signal.aborted) {
      const snapshot = await this.lease.decision(this.decisionWaitMs, signal);
      if (snapshot.cancellation || snapshot.sessionStatus === "cancelled") return null;
      const approval = snapshot.approvals.find((candidate) => candidate.approvalId === approvalId);
      if (!approval) return null;
      if (approval.decision !== "pending") return approval;
      if (Date.parse(approval.expiresAt) <= this.now().getTime()) return null;
    }
    return null;
  }

  private async waitBoundApproval(
    approvalId: string,
    invocationDigest: string,
    invocationSummaryDigest: string,
    signal: AbortSignal
  ): Promise<AgentApproval | null> {
    const approval = await this.waitApproval(approvalId, signal);
    if (
      !approval ||
      approval.invocationDigest !== invocationDigest ||
      approval.invocationSummary.invocationDigest !== invocationDigest ||
      approval.invocationSummaryDigest !== invocationSummaryDigest ||
      (await createInvocationSummaryDigest(approval.invocationSummary)) !== invocationSummaryDigest
    ) {
      return null;
    }
    return approval;
  }

  private async consume(approval: AgentApproval, digest: string): Promise<string> {
    let consumedAt = "";
    await this.lease.mutate(async (base) => {
      const result = await this.lease.workControl.consumeApproval(this.lease.work.lease.leaseId, {
        ...base,
        approvalId: approval.approvalId,
        invocationDigest: digest,
      });
      consumedAt = result.consumedAt;
      return result.revision;
    }, `consume:${approval.approvalId}`);
    this.lease.approvals = this.lease.approvals.map((candidate) =>
      candidate.approvalId === approval.approvalId ? { ...candidate, consumedAt } : candidate
    );
    return consumedAt;
  }

  private async authorize(
    invocation: ToolInvocation,
    digest: string,
    approvalId: string,
    risk: RiskClass,
    targetScope: TargetScope
  ): Promise<GatewayApprovalAuthorization> {
    let authorization: GatewayApprovalAuthorization | undefined;
    await this.lease.mutate(async (base) => {
      const result = await this.lease.workControl.authorizeInvocation(this.lease.work.lease.leaseId, {
        ...base,
        authorizationId: stableId("invoke-auth", this.lease.work.task.taskId, digest, this.lease.work.lease.generation),
        invocationId: invocation.invocationId,
        invocationDigest: digest,
        approvalId,
        capability: invocation.capability,
        targetScope,
        risk,
      });
      authorization = result.authorization;
      return result.revision;
    }, `authorize:${invocation.invocationId}`);
    if (!authorization) throw new Error("Authoritative invocation authorization was not returned.");
    return authorization;
  }

  private async publishExactProposal(
    invocation: ToolInvocation,
    digest: string,
    risk: RiskClass,
    targetScope: TargetScope
  ): Promise<void> {
    const summary = await createProposedInvocationSummary(invocation, risk, {
      exactSecrets: this.exactSecrets,
      targetScope,
      persistentWorldRoots: this.persistentWorldRoots,
    });
    if (summary.invocationDigest !== digest) throw new Error("Exact invocation proposal digest changed.");
    await this.publishInvocationSummary(summary, await createInvocationSummaryDigest(summary));
  }

  private async resume(): Promise<void> {
    await this.lease.mutate(
      async (base) =>
        await this.lease.workControl.publishStatus(this.lease.work.lease.leaseId, {
          ...base,
          status: "running",
          reason: "Operator decision received; resuming exact invocation.",
        }),
      `resume:${this.lease.revision}`
    );
  }

  private async synthetic(kind: AgentEventKind, payload: JsonObject): Promise<void> {
    const hash = createHash("sha256")
      .update(JSON.stringify([kind, payload, this.lease.revision]))
      .digest("hex")
      .slice(0, 48);
    await this.publisher.publish(kind, payload, this.now().toISOString(), `runtime-${hash}`);
  }

  private async publishInvocationSummary(
    summary: import("@/lib/agent/contracts").ProposedInvocationSummary,
    summaryDigest: string
  ): Promise<void> {
    await this.synthetic("tool-proposal", {
      invocationId: summary.invocationId,
      invocationDigest: summary.invocationDigest,
      invocationSummaryDigest: summaryDigest,
      toolId: summary.toolId,
      capability: summary.capability,
      targetScope: summary.targetScope as unknown as JsonObject,
      risk: summary.risk,
      sanitizedArguments: summary.sanitizedArguments,
      ...(summary.diffSummary ? { diffSummary: summary.diffSummary } : {}),
      ...(summary.backupFailureStatus ? { backupFailureStatus: summary.backupFailureStatus } : {}),
    });
  }

  private isRisk(value: JsonValue | undefined): value is RiskClass {
    return value === "low" || value === "risky" || value === "destructive";
  }

  private expectedDecisionScope(invocation: ToolInvocation): TargetScope {
    if (invocation.toolId !== "network.download" || invocation.capability !== "network.outbound") {
      return invocation.targetScope;
    }
    const rawUrl = invocation.arguments.url;
    const expectedSha256 = invocation.arguments.expectedSha256;
    const expectedBytes = invocation.arguments.expectedBytes;
    if (typeof rawUrl !== "string" || typeof expectedSha256 !== "string" || typeof expectedBytes !== "number") {
      throw new Error("Network approval requires an operator-supplied expected SHA-256 and exact byte size.");
    }
    const resource = exactNetworkDownloadResource(rawUrl);
    if (redactSensitiveText(resource, this.exactSecrets) !== resource) {
      throw new Error("Network approval resource contains secret material.");
    }
    return networkDownloadApprovalScope(resource, invocation.targetScope, { expectedSha256, expectedBytes });
  }
}

export class AgentRuntimeGateway {
  private readonly leaseDurationMs: number;
  private readonly workWaitMs: number;
  private readonly decisionWaitMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly persistentWorldRoots: readonly string[];
  private runInFlight = false;

  constructor(private readonly options: RuntimeGatewayOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.workWaitMs = options.workWaitMs ?? 25_000;
    this.decisionWaitMs = options.decisionWaitMs ?? 25_000;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.persistentWorldRoots = canonicalPersistentWorldRoots(
      options.persistentWorldRoots ?? DEFAULT_PERSISTENT_WORLD_ROOTS
    );
  }

  async runOnce(signal?: AbortSignal): Promise<boolean> {
    if (this.runInFlight) return false;
    this.runInFlight = true;
    try {
      return await this.runOnceExclusive(signal);
    } finally {
      this.runInFlight = false;
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One bounded run owns lease, harness, publication, cancellation, and terminalization cleanup.
  private async runOnceExclusive(signal?: AbortSignal): Promise<boolean> {
    if (!(await this.resumeExecutorReconciliations())) return false;
    const work = await this.options.control.leaseWork(
      {
        schemaVersion: 1,
        claimId: `claim-${this.createId()}`,
        leaseDurationMs: this.leaseDurationMs,
        waitMs: this.workWaitMs,
      },
      signal
    );
    if (!work) return false;
    const lease = new LeaseSession(work, this.options.control);
    await lease.mutate(
      async (base) => await this.options.control.acknowledge(work.lease.leaseId, base),
      `ack:${work.lease.claimId}`
    );
    const publisher = new RuntimeDraftPublisher(lease);
    const controller = new AbortController();
    const fencePublisher = () => publisher.fenceForCancellation();
    controller.signal.addEventListener("abort", fencePublisher, { once: true });
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const monitorController = new AbortController();
    const monitor =
      this.options.monitorLease === false
        ? Promise.resolve()
        : this.monitorLease(lease, controller, monitorController.signal);
    let terminal: "completed" | "failed" = "completed";
    let effectIndeterminate = false;
    let assistantContent = "";
    const publishedTerminalInvocationIds = new Set<string>();
    let toolExecutor: OrchestratedToolExecutor | undefined;
    try {
      if (work.providerProfileFingerprint !== work.session.harness.providerProfileFingerprint) {
        throw new Error("Runtime work profile fingerprint does not match its persisted session.");
      }
      const provider = await this.options.providers.resolve(
        work.session.harness.providerProfileId,
        work.providerProfileFingerprint,
        work.session.harness.model
      );
      if (
        provider.configuration.profileId !== work.session.harness.providerProfileId ||
        provider.configuration.model !== work.session.harness.model
      ) {
        throw new Error("Gateway provider resolution did not match pinned work.");
      }
      const exactSecrets = [
        ...new Set([...(this.options.runtimeExactSecrets ?? []), ...provider.exactSecrets].filter(Boolean)),
      ];
      toolExecutor = new OrchestratedToolExecutor(
        lease,
        this.options.executor,
        this.options.backup,
        publisher,
        this.decisionWaitMs,
        this.options.fenceRenewIntervalMs ?? BACKUP_FENCE_RENEW_INTERVAL_MS,
        this.now,
        exactSecrets,
        this.persistentWorldRoots
      );
      const harness = this.options.harnesses.create({ toolExecutor, exactSecrets });
      for await (const event of harness.run({
        session: work.session,
        provider: provider.configuration,
        prompt: buildHarnessContinuationPrompt(work.session, work.task.content),
        signal: controller.signal,
      })) {
        if (controller.signal.aborted && event.kind === "cancellation") continue;
        if (controller.signal.aborted) {
          const reconciled =
            event.kind === "tool-result" ? agentSchemas.toolResult.safeParse(event.payload.data) : undefined;
          if (!reconciled?.success || (reconciled.data.status === "failed" && isWaitingResult(reconciled.data))) {
            continue;
          }
          if (toolExecutor.terminalState(reconciled.data.invocationId)) {
            await this.completeLiveTerminal(toolExecutor, reconciled.data.invocationId);
          } else {
            await publisher.publishCancellationResult(event);
            if (reconciled.data.status !== "indeterminate") {
              await this.completePublishedExecutorHandoff(reconciled.data.invocationId, work);
            }
          }
          if (reconciled.data.status === "indeterminate") effectIndeterminate = true;
          terminal = "failed";
          break;
        }
        await publisher.publishHarness(event);
        if (event.kind === "tool-result") {
          const publishedResult = agentSchemas.toolResult.safeParse(event.payload.data);
          if (publishedResult.success) publishedTerminalInvocationIds.add(publishedResult.data.invocationId);
        }
        if (event.kind === "model" && typeof event.payload.data.delta === "string") {
          assistantContent = `${assistantContent}${event.payload.data.delta}`.slice(-MAX_ASSISTANT_TURN_CHARS);
        }
        if (event.kind === "error") terminal = "failed";
        if (event.kind === "cancellation") controller.abort();
        if (event.kind === "tool-result" && event.payload.data.status === "indeterminate") {
          effectIndeterminate = true;
          terminal = "failed";
          controller.abort();
          break;
        }
      }
      if (!controller.signal.aborted || effectIndeterminate) {
        await lease.mutate(
          async (base) =>
            await this.options.control.publishStatus(work.lease.leaseId, {
              ...base,
              status: terminal,
              reason:
                terminal === "completed"
                  ? "Harness completed."
                  : effectIndeterminate
                    ? "An indeterminate host effect requires operator reconciliation."
                    : "Harness failed closed.",
              ...(terminal === "completed" && assistantContent.trim()
                ? {
                    assistantTurn: {
                      schemaVersion: 1 as const,
                      turnId: `turn-${this.createId()}`,
                      kind: "assistant" as const,
                      content: assistantContent,
                      createdAt: this.now().toISOString(),
                    },
                  }
                : {}),
            }),
          `terminal:${terminal}`
        );
        for (const invocationId of publishedTerminalInvocationIds) {
          if (toolExecutor.terminalState(invocationId)) {
            await this.completeLiveTerminal(toolExecutor, invocationId);
          } else {
            await this.completePublishedExecutorHandoff(invocationId, work);
          }
        }
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof RuntimeTransportError && error.status === 409)) {
        await publisher
          .publish(
            "error",
            { message: "Runtime orchestration failed closed." },
            this.now().toISOString(),
            `error-${this.createId()}`
          )
          .catch(() => undefined);
        await lease
          .mutate(
            async (base) =>
              await this.options.control.publishStatus(work.lease.leaseId, {
                ...base,
                status: "failed",
                reason: "Runtime orchestration failed closed.",
              }),
            "terminal:failed"
          )
          .catch(() => undefined);
      }
      return true;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      monitorController.abort();
      controller.abort();
      controller.signal.removeEventListener("abort", fencePublisher);
      await monitor.catch(() => undefined);
      await publisher.drain().catch(() => undefined);
    }
  }

  private async completePublishedExecutorHandoff(invocationId: string, work: RuntimeWorkLeaseDto): Promise<void> {
    const executor = this.options.executor as DirectLiveExecutor & {
      completeReconciliation?(invocationId: string, runtimeContext: RuntimeExecutionContext): void | Promise<void>;
    };
    await executor.completeReconciliation?.(invocationId, {
      runtimeId: work.lease.runtimeId,
      leaseId: work.lease.leaseId,
      leaseGeneration: work.lease.generation,
      taskId: work.task.taskId,
    });
  }

  private async completeLiveTerminal(toolExecutor: OrchestratedToolExecutor, invocationId: string): Promise<void> {
    const terminalState = toolExecutor.terminalState(invocationId);
    if (!terminalState) throw new Error("Published executor terminal evidence was not retained.");
    const runtimeContext = terminalState.request.runtimeContext;
    if (!runtimeContext) throw new Error("Published executor terminal evidence lost runtime context.");
    const acknowledgementAuthorization = await this.publishLateRecovery(
      {
        key: `${runtimeContext.runtimeId}:${runtimeContext.taskId}:${runtimeContext.leaseId}:${runtimeContext.leaseGeneration}:${invocationId}`,
        runtimeId: runtimeContext.runtimeId,
        request: terminalState.request,
      },
      runtimeContext,
      terminalState.result,
      terminalState.terminalReceipt
    );
    const outcome = terminalState.result.status === "succeeded" ? "committed" : terminalState.result.status;
    const fenceReleased = terminalState.authorization
      ? await this.finalizeRecoveredFence(terminalState.authorization, outcome, terminalState.terminalReceipt)
      : true;
    if (fenceReleased && terminalState.result.status !== "indeterminate") {
      if (!acknowledgementAuthorization) {
        throw new Error("Control plane omitted executor terminal acknowledgement authority.");
      }
      const executor = this.options.executor as DirectLiveExecutor & {
        completeReconciliation?(
          invocationId: string,
          runtimeContext: RuntimeExecutionContext,
          authorization?: TerminalPublicationAuthorization
        ): void | Promise<void>;
      };
      await executor.completeReconciliation?.(invocationId, runtimeContext, acknowledgementAuthorization);
      toolExecutor.markTerminalComplete(invocationId);
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Restart recovery deliberately validates authority, durable handoff phase, exact executor state, renewal, dispatch, publication, and finalization in one fail-closed loop.
  private async resumeExecutorReconciliations(): Promise<boolean> {
    const executor = this.options.executor as DirectLiveExecutor & {
      reconcilePending?(): Promise<
        Array<{
          key: string;
          runtimeId: string;
          sessionId?: string;
          taskId?: string;
          leaseId?: string;
          leaseGeneration?: number;
          invocationId?: string;
          invocationDigest?: string;
          state: "awaiting-backup" | "awaiting-executor" | "dispatching";
          request: import("@/lib/agent/executor").ExecuteInvocationRequest;
          executorStatus?: "active" | "pending" | "reserved" | "terminal" | "not-started";
          result?: ToolResult;
          terminalReceipt?: BackupTerminalReceipt;
        }>
      >;
      completeReconciliation?(invocationId: string, runtimeContext: RuntimeExecutionContext): void | Promise<void>;
      replacePendingFence?(
        request: import("@/lib/agent/executor").ExecuteInvocationRequest,
        authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
      ): Promise<void>;
      authorizeBackupHandoff?(
        request: import("@/lib/agent/executor").ExecuteInvocationRequest,
        authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
      ): Promise<void>;
      inspectEffectSlot?(): Promise<{
        invocationId: string;
        invocationDigest: string;
        taskId?: string;
        leaseGeneration?: number;
        status: "reserved" | "in-progress" | "indeterminate";
        updatedAt: string;
      } | null>;
      cancel?(
        invocationId: string,
        runtimeContext?: RuntimeExecutionContext,
        request?: import("@/lib/agent/executor").ExecuteInvocationRequest
      ): Promise<{ result?: ToolResult; terminalReceipt?: BackupTerminalReceipt }>;
    };
    if (!executor.reconcilePending) return true;
    if (!executor.inspectEffectSlot) {
      throw new Error("Executor runtime-wide effect status protocol is unavailable.");
    }
    const inFlight = await executor.inspectEffectSlot();
    let records = await executor.reconcilePending();
    if (
      inFlight &&
      !records.some(
        (entry) =>
          entry.request.invocation.invocationId === inFlight.invocationId &&
          entry.request.runtimeContext?.taskId === inFlight.taskId &&
          entry.request.runtimeContext?.leaseGeneration === inFlight.leaseGeneration
      )
    ) {
      throw new Error("Executor authenticated in-flight identity has no exact durable gateway handoff.");
    }
    const runtimeOwnerKey =
      records.find(
        (entry) =>
          inFlight !== null &&
          entry.request.invocation.invocationId === inFlight.invocationId &&
          entry.request.runtimeContext?.taskId === inFlight.taskId &&
          entry.request.runtimeContext?.leaseGeneration === inFlight.leaseGeneration
      )?.key ??
      records.find(
        (entry) =>
          entry.executorStatus === "active" ||
          entry.executorStatus === "pending" ||
          entry.executorStatus === "reserved" ||
          (entry.state === "dispatching" && entry.executorStatus === "not-started")
      )?.key;
    let blocked = false;
    for (let pending of records) {
      let authorization = pending.request.backupAuthorization;
      const runtimeContext = pending.request.runtimeContext;
      if (!runtimeContext) throw new Error("Persisted executor reconciliation lost its runtime binding.");
      const invocationDigest = await createInvocationDigest(pending.request.invocation);
      if (
        pending.sessionId !== undefined &&
        (pending.sessionId !== pending.request.invocation.sessionId ||
          pending.taskId !== runtimeContext.taskId ||
          pending.leaseId !== runtimeContext.leaseId ||
          pending.leaseGeneration !== runtimeContext.leaseGeneration ||
          pending.invocationId !== pending.request.invocation.invocationId ||
          pending.invocationDigest !== invocationDigest)
      ) {
        throw new Error("Executor durable handoff changed its exact runtime invocation binding.");
      }
      if (
        inFlight?.invocationId === pending.request.invocation.invocationId &&
        inFlight.taskId === runtimeContext.taskId &&
        inFlight.leaseGeneration === runtimeContext.leaseGeneration &&
        inFlight.invocationDigest !== invocationDigest
      ) {
        throw new Error("Executor authenticated in-flight digest changed its exact gateway binding.");
      }
      if (pending.runtimeId.length === 0 || pending.request.invocation.sessionId.length === 0) {
        throw new Error("Persisted backup handoff lost its runtime or session binding.");
      }
      let authoritative: RuntimeDecisionSnapshot | undefined;
      try {
        authoritative = await this.options.control.waitForDecision(runtimeContext.leaseId, {
          schemaVersion: 1,
          sessionId: pending.request.invocation.sessionId,
          taskId: runtimeContext.taskId,
          afterRevision: 1,
          waitMs: 0,
        });
      } catch (error) {
        if (!(error instanceof RuntimeTransportError) || error.status !== 409) throw error;
        authoritative = undefined;
      }
      const dispatchPermitted =
        authoritative !== undefined &&
        !authoritative.cancellation &&
        !authoritative.approvals.some(
          (approval) =>
            approval.invocationDigest === invocationDigest &&
            (approval.decision === "denied" ||
              approval.decision === "cancelled" ||
              approval.decision === "revoked" ||
              (approval.decision === "pending" && Date.parse(approval.expiresAt) <= this.now().getTime()))
        ) &&
        (authoritative.sessionStatus === "running" || authoritative.sessionStatus === "waiting-approval") &&
        (authoritative.taskStatus === "running" || authoritative.taskStatus === "waiting-approval") &&
        authoritative.leaseGeneration === runtimeContext.leaseGeneration &&
        authoritative.activeRuntimeInvocation !== undefined &&
        authoritative.activeRuntimeInvocation.runtimeId === pending.runtimeId &&
        authoritative.activeRuntimeInvocation.sessionId === pending.request.invocation.sessionId &&
        authoritative.activeRuntimeInvocation.taskId === runtimeContext.taskId &&
        authoritative.activeRuntimeInvocation.leaseId === runtimeContext.leaseId &&
        authoritative.activeRuntimeInvocation.leaseGeneration === runtimeContext.leaseGeneration &&
        authoritative.activeRuntimeInvocation.invocationId === pending.request.invocation.invocationId &&
        authoritative.activeRuntimeInvocation.invocationDigest === invocationDigest;

      const blockedByAnotherRuntimeOwner = runtimeOwnerKey !== undefined && runtimeOwnerKey !== pending.key;
      if (blockedByAnotherRuntimeOwner && pending.state === "awaiting-backup") {
        blocked = true;
        continue;
      }

      if (pending.state === "awaiting-backup") {
        if (!executor.authorizeBackupHandoff) {
          throw new Error("Recovered backup handoff cannot persist its executor authorization.");
        }
        let created: RuntimeBackupResult;
        try {
          created = await this.options.backup.create({
            schemaVersion: 1,
            action: "create",
            leaseId: runtimeContext.leaseId,
            leaseGeneration: runtimeContext.leaseGeneration,
            sessionId: pending.request.invocation.sessionId,
            taskId: runtimeContext.taskId,
            invocationId: pending.request.invocation.invocationId,
            invocationDigest,
          });
        } catch (error) {
          if (!dispatchPermitted && (error as { status?: unknown }).status === 409) {
            await executor.completeReconciliation?.(pending.request.invocation.invocationId, runtimeContext);
            continue;
          }
          throw error;
        }
        if (created.status !== "succeeded" || !created.fenceAuthorization) {
          if (created.status === "failed" || created.status === "cancelled" || created.status === "unavailable") {
            await executor.completeReconciliation?.(pending.request.invocation.invocationId, runtimeContext);
            continue;
          }
          throw new Error("Recovered backup handoff remains ambiguous.");
        }
        authorization = created.fenceAuthorization;
        pending = {
          ...pending,
          state: "awaiting-executor",
          request: { ...pending.request, backupAuthorization: authorization },
        };
        await executor.authorizeBackupHandoff(pending.request, authorization);
        records = await executor.reconcilePending();
        pending = records.find((entry) => entry.key === pending.key) ?? pending;
      }

      if (pending.state === "awaiting-backup" && authorization?.status !== "succeeded") {
        throw new Error("Recovered backup handoff lost its exact fence.");
      }
      const terminalReceipt = pending.terminalReceipt;
      // A durable terminal receipt is already the exact publication evidence,
      // including its old receipt-key identity. Never renew a fence merely
      // because that retained receipt uses a previous key: the fence may have
      // been finalized while publication was unavailable.
      if (
        authorization?.status === "succeeded" &&
        authorization.executorKeyId !== undefined &&
        pending.executorStatus === "terminal" &&
        !terminalReceipt &&
        executor.replacePendingFence !== undefined
      ) {
        authorization = await this.renewRecoveredFence(executor, pending.request, authorization);
        pending.request = { ...pending.request, backupAuthorization: authorization };
        records = await executor.reconcilePending();
        pending = records.find((entry) => entry.key === pending.key) ?? pending;
      }
      const unresolved =
        pending.executorStatus === "active" ||
        pending.executorStatus === "pending" ||
        (pending.state === "dispatching" && pending.executorStatus === "not-started");
      if (
        authorization?.status === "succeeded" &&
        ((unresolved && dispatchPermitted) || (!unresolved && dispatchPermitted && !pending.result))
      ) {
        authorization = await this.renewRecoveredFence(executor, pending.request, authorization);
        pending.request = { ...pending.request, backupAuthorization: authorization };
      }

      if (unresolved) {
        if (!dispatchPermitted) {
          const cancellation = await executor
            .cancel?.(pending.request.invocation.invocationId, runtimeContext, pending.request)
            .catch(() => undefined);
          if (cancellation?.result && cancellation.terminalReceipt) {
            await this.finishRecoveredHandoff(
              executor,
              pending,
              authorization?.status === "succeeded" ? authorization : undefined,
              cancellation.result,
              cancellation.terminalReceipt,
              authoritative
            );
            continue;
          }
        }
        blocked = true;
        continue;
      }
      if (pending.executorStatus === "not-started" || pending.executorStatus === "reserved") {
        if (blockedByAnotherRuntimeOwner) {
          blocked = true;
          continue;
        }
        if (dispatchPermitted) {
          const result = await executor.execute(pending.request);
          const terminalReceipt = await (
            executor as typeof executor & {
              terminalReceiptFor?(
                request: import("@/lib/agent/executor").ExecuteInvocationRequest,
                result: ToolResult
              ): Promise<BackupTerminalReceipt | undefined>;
            }
          ).terminalReceiptFor?.(pending.request, result);
          await this.finishRecoveredHandoff(
            executor,
            pending,
            authorization?.status === "succeeded" ? authorization : undefined,
            result,
            terminalReceipt,
            authoritative
          );
        } else {
          // Cancellation is the authority withdrawal boundary. It must reach
          // the executor before a lifecycle fence can be released; otherwise a
          // reserved request could still enter the host after finalization.
          const cancellation = await executor.cancel?.(
            pending.request.invocation.invocationId,
            runtimeContext,
            pending.request
          );
          if (!cancellation?.result || !cancellation.terminalReceipt) {
            throw new Error("Executor cancellation did not return authenticated no-effect terminal evidence.");
          }
          await this.finishRecoveredHandoff(
            executor,
            pending,
            authorization?.status === "succeeded" ? authorization : undefined,
            cancellation.result,
            cancellation.terminalReceipt,
            authoritative
          );
        }
        continue;
      }
      if (!pending.result)
        throw new Error("Recovered executor status did not include an authoritative terminal result.");
      await this.finishRecoveredHandoff(
        executor,
        pending,
        authorization?.status === "succeeded" ? authorization : undefined,
        pending.result,
        pending.terminalReceipt,
        authoritative
      );
    }
    if (blocked) return false;
    records = await executor.reconcilePending();
    return records.length === 0;
  }

  private async renewRecoveredFence(
    executor: DirectLiveExecutor & {
      replacePendingFence?(
        request: import("@/lib/agent/executor").ExecuteInvocationRequest,
        authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
      ): Promise<void>;
    },
    request: import("@/lib/agent/executor").ExecuteInvocationRequest,
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>
  ): Promise<Extract<GatewayBackupAuthorization, { status: "succeeded" }>> {
    if (!this.options.backup.renew || !executor.replacePendingFence) {
      throw new Error("Recovered executor handoff cannot renew its lifecycle fence.");
    }
    const renewed = await this.options.backup.renew({ schemaVersion: 1, action: "renew", authorization });
    if (renewed.status !== "renewed" || !renewed.authorization) {
      throw new Error("Recovered executor handoff lost lifecycle fence ownership.");
    }
    await executor.replacePendingFence(request, renewed.authorization);
    return renewed.authorization;
  }

  private async finishRecoveredHandoff(
    executor: DirectLiveExecutor & {
      completeReconciliation?(
        invocationId: string,
        runtimeContext: RuntimeExecutionContext,
        authorization?: TerminalPublicationAuthorization
      ): void | Promise<void>;
    },
    pending: {
      key: string;
      runtimeId: string;
      request: import("@/lib/agent/executor").ExecuteInvocationRequest;
      terminalReceipt?: BackupTerminalReceipt;
    },
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }> | undefined,
    result: ToolResult,
    terminalReceipt?: BackupTerminalReceipt,
    _authoritative?: RuntimeDecisionSnapshot
  ): Promise<void> {
    const outcome =
      result.status === "succeeded" ? "committed" : result.status === "indeterminate" ? "indeterminate" : result.status;
    const runtimeContext = pending.request.runtimeContext;
    if (!runtimeContext) throw new Error("Recovered publication lost runtime context.");
    // Every durable executor terminal uses the one terminal-only control-plane
    // mutation, even while the original lease is still live. That mutation
    // publishes exact evidence, records reconciliation, clears the lease, and
    // terminalizes task/session truth before minting acknowledgement authority.
    const acknowledgementAuthorization = await this.publishLateRecovery(
      pending,
      runtimeContext,
      result,
      terminalReceipt
    );
    const fenceReleased = authorization
      ? await this.finalizeRecoveredFence(authorization, outcome, terminalReceipt)
      : true;
    if (fenceReleased && result.status !== "indeterminate") {
      if (!acknowledgementAuthorization) {
        throw new Error("Control plane omitted executor terminal acknowledgement authority.");
      }
      await executor.completeReconciliation?.(
        pending.request.invocation.invocationId,
        runtimeContext,
        acknowledgementAuthorization
      );
    }
  }

  private async publishLateRecovery(
    pending: { key: string; runtimeId: string; request: import("@/lib/agent/executor").ExecuteInvocationRequest },
    runtimeContext: RuntimeExecutionContext,
    result: ToolResult,
    terminalReceipt?: BackupTerminalReceipt
  ): Promise<TerminalPublicationAuthorization | undefined> {
    if (!terminalReceipt) throw new Error("Late executor recovery requires an authenticated terminal receipt.");
    if (!this.options.control.publishRecovery) {
      throw new Error("Late executor recovery publication protocol is unavailable.");
    }
    if (
      terminalReceipt.runtimeId !== pending.runtimeId ||
      terminalReceipt.sessionId !== pending.request.invocation.sessionId ||
      terminalReceipt.taskId !== runtimeContext.taskId ||
      terminalReceipt.leaseId !== runtimeContext.leaseId ||
      terminalReceipt.leaseGeneration !== runtimeContext.leaseGeneration ||
      terminalReceipt.invocationId !== pending.request.invocation.invocationId ||
      terminalReceipt.resultDigest !== resultDigest(result as unknown as JsonValue)
    ) {
      throw new Error("Late executor recovery evidence changed its exact binding.");
    }
    const invocationDigest = await createInvocationDigest(pending.request.invocation);
    if (invocationDigest !== terminalReceipt.invocationDigest)
      throw new Error("Late executor recovery invocation digest changed.");
    const published = await this.options.control.publishRecovery(runtimeContext.leaseId, {
      schemaVersion: 1,
      sessionId: pending.request.invocation.sessionId,
      taskId: runtimeContext.taskId,
      runtimeId: pending.runtimeId,
      leaseId: runtimeContext.leaseId,
      leaseGeneration: runtimeContext.leaseGeneration,
      invocationId: pending.request.invocation.invocationId,
      invocationDigest,
      journalSequence: terminalReceipt.journalSequence,
      resultDigest: terminalReceipt.resultDigest,
      result,
      terminalReceipt,
      idempotencyKey: `recover-terminal:${createHash("sha256").update(pending.key).digest("hex")}`,
    });
    return published.acknowledgementAuthorization;
  }

  private async finalizeRecoveredFence(
    authorization: Extract<GatewayBackupAuthorization, { status: "succeeded" }>,
    outcome: RuntimeBackupFinalizeRequest["outcome"],
    terminalReceipt?: BackupTerminalReceipt
  ): Promise<boolean> {
    const finalized = await this.options.backup.finalize({
      schemaVersion: 1,
      action: "finalize",
      authorization,
      outcome,
      ...(terminalReceipt ? { terminalReceipt } : {}),
    });
    if (finalized.authorizationId !== authorization.authorizationId) {
      throw new Error("Recovered executor reconciliation changed its lifecycle authorization identity.");
    }
    if (outcome === "indeterminate") {
      if (finalized.status === "reconciliation-needed" && !finalized.released) {
        return false;
      }
      if (finalized.status === "finalized" && finalized.released) return true;
      throw new Error("Indeterminate executor reconciliation returned an invalid lifecycle fence state.");
    }
    if (!finalized.released) {
      throw new Error("Recovered executor reconciliation did not release its exact lifecycle fence.");
    }
    return true;
  }

  private async monitorLease(lease: LeaseSession, runController: AbortController, signal: AbortSignal): Promise<void> {
    const waitMs = Math.max(1_000, Math.min(this.decisionWaitMs, Math.floor(this.leaseDurationMs / 3)));
    let renewal = 0;
    while (!signal.aborted && !runController.signal.aborted) {
      try {
        const snapshot = await lease.decision(waitMs, signal);
        if (snapshot.cancellation || snapshot.sessionStatus === "cancelled") {
          runController.abort();
          return;
        }
        if (signal.aborted) return;
        await lease.mutate(async (base) => {
          const result = await this.options.control.renew(lease.work.lease.leaseId, {
            ...base,
            leaseDurationMs: this.leaseDurationMs,
          });
          return result.revision;
        }, `renew:${++renewal}`);
      } catch {
        if (!signal.aborted) runController.abort();
        return;
      }
    }
  }
}

export function buildHarnessContinuationPrompt(
  session: import("@/lib/agent/contracts").AgentSession,
  currentTask: string
): string {
  const entries = session.turns.map((turn) => `${turn.kind.toUpperCase()}: ${turn.content}`);
  if (session.turns.at(-1)?.content !== currentTask) entries.push(`USER: ${currentTask}`);
  const selected: string[] = [];
  let bytes = 0;
  for (const entry of entries.reverse()) {
    const size = new TextEncoder().encode(`${entry}\n`).byteLength;
    if (bytes + size > MAX_HARNESS_CONTEXT_BYTES) break;
    selected.unshift(entry);
    bytes += size;
  }
  return `Continue this persisted, redacted mc-aws conversation. Earlier omitted turns exceeded the context bound.\n\n${selected.join("\n\n")}`;
}

export interface HttpRuntimeControlTransportOptions {
  baseUrl: string;
  runtimeBearer: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class HttpRuntimeControlTransport implements RuntimeControlTransport {
  private readonly baseUrl: URL;
  private readonly request: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: HttpRuntimeControlTransportOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "https:" && this.baseUrl.hostname !== "localhost") {
      throw new TypeError("Runtime control URL must use HTTPS.");
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new TypeError("Runtime control URL cannot contain credentials, query, or fragment.");
    }
    if (options.runtimeBearer.length < 32 || /\s/.test(options.runtimeBearer)) {
      throw new TypeError("Runtime bearer is invalid.");
    }
    this.request = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_CONTROL_RETRY_BASE_DELAY_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 120_000) {
      throw new TypeError("Runtime control request timeout is invalid.");
    }
    if (!Number.isSafeInteger(this.retryBaseDelayMs) || this.retryBaseDelayMs < 1 || this.retryBaseDelayMs > 5_000) {
      throw new TypeError("Runtime control retry delay is invalid.");
    }
    this.pause = options.sleep ?? ((milliseconds, signal) => this.sleep(milliseconds, signal));
  }

  leaseWork(input: RuntimeWorkLeaseRequest, signal?: AbortSignal): Promise<RuntimeWorkLeaseDto | null> {
    return this.call("/api/agent/runtime/work", input, signal, this.requestTimeoutMs + input.waitMs);
  }
  acknowledge(leaseId: string, input: RuntimeLeaseMutationRequest): Promise<number> {
    return this.revision(leaseId, "ack", input);
  }
  async renew(leaseId: string, input: RuntimeRenewRequest): Promise<{ revision: number; expiresAt: string }> {
    return await this.call(this.path(leaseId, "renew"), input);
  }
  publishEvents(leaseId: string, input: RuntimeEventPublicationRequest): Promise<number> {
    return this.revision(leaseId, "events", input);
  }
  publishRecovery(
    leaseId: string,
    input: RuntimeRecoveryPublicationRequest
  ): Promise<RuntimeRecoveryPublicationResult> {
    return this.call(this.path(leaseId, "recovery"), input);
  }
  publishApproval(leaseId: string, input: RuntimeApprovalPublicationRequest): Promise<number> {
    return this.revision(leaseId, "approval", input);
  }
  async consumeApproval(
    leaseId: string,
    input: RuntimeApprovalConsumptionRequest
  ): Promise<{ revision: number; consumedAt: string }> {
    return await this.call(this.path(leaseId, "consume-approval"), input);
  }
  async authorizeInvocation(
    leaseId: string,
    input: RuntimeInvocationAuthorizationRequest
  ): Promise<RuntimeInvocationAuthorizationResult> {
    return await this.call(this.path(leaseId, "authorize-invocation"), input);
  }
  publishStatus(leaseId: string, input: RuntimeStatusPublicationRequest): Promise<number> {
    return this.revision(leaseId, "status", input);
  }
  waitForDecision(
    leaseId: string,
    input: RuntimeDecisionPollRequest,
    signal?: AbortSignal
  ): Promise<RuntimeDecisionSnapshot> {
    return this.call(this.path(leaseId, "decisions"), input, signal, this.requestTimeoutMs + input.waitMs);
  }

  private async revision(leaseId: string, action: string, input: unknown): Promise<number> {
    const result = await this.call<{ revision: number }>(this.path(leaseId, action), input);
    if (!Number.isSafeInteger(result.revision)) throw new RuntimeTransportError(502, false);
    return result.revision;
  }

  private path(leaseId: string, action: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(leaseId)) throw new TypeError("Runtime lease ID is invalid.");
    return `/api/agent/runtime/leases/${encodeURIComponent(leaseId)}/${action}`;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Transport retries must classify abort, HTTP, parse, and retryable network failures in one bounded loop.
  private async call<T>(
    pathName: string,
    body: unknown,
    signal?: AbortSignal,
    attemptTimeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    let last: unknown;
    const encodedBody = JSON.stringify(body);
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      try {
        const url = new URL(pathName, this.baseUrl);
        if (url.origin !== this.baseUrl.origin) throw new TypeError("Runtime control request changed origin.");
        const { response, text } = await this.requestWithTimeout(url, encodedBody, attemptTimeoutMs, signal);
        const envelope = JSON.parse(text) as { success?: unknown; data?: T };
        if (response.ok && envelope.success === true) return envelope.data as T;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === MAX_PUBLISH_ATTEMPTS - 1) {
          throw new RuntimeTransportError(response.status, retryable);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof RuntimeTransportError && !error.retryable) throw error;
        last = error;
      }
      if (attempt < MAX_PUBLISH_ATTEMPTS - 1) {
        await this.pause(this.retryBaseDelayMs * 2 ** attempt, signal);
        if (signal?.aborted) throw last;
      }
    }
    throw last instanceof RuntimeTransportError ? last : new RuntimeTransportError(503, true);
  }

  private async requestWithTimeout(
    url: URL,
    body: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new DOMException("Runtime control request timed out.", "TimeoutError"));
          reject(new RuntimeTransportError(504, true));
        }, timeoutMs);
        timer.unref?.();
      });
      return await Promise.race([
        this.request(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.runtimeBearer}`,
            "content-type": "application/json",
          },
          body,
          redirect: "error",
          signal: controller.signal,
        }).then(async (response) => ({ response, text: await readBoundedControlResponse(response) })),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
