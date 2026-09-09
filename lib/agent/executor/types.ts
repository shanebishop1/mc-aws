import type {
  AgentApproval,
  BackupFenceAuthorization,
  EvidenceReference,
  InvocationAuthorization,
  JsonValue,
  MutationCommit,
  PermissionPolicy,
  ShellCommand,
  ShellMode,
  ToolDefinition,
  ToolInvocation,
  ToolProgress,
  ToolResult,
} from "@/lib/agent/contracts";
import type { MaintenanceApplyRequest, MaintenanceInvocationIdentity } from "@/lib/agent/maintenance";
export type ExecutorEntryKind = "file" | "directory" | "symlink" | "special" | "missing";

/** Hard ceiling shared by executor tools; the lifecycle safety horizon must remain strictly longer. */
export const EXECUTOR_EFFECT_MAX_BOUND_MS = 120_000;

/** A host mutation crossed its commit point but could not prove durable completion; callers must fence retries. */
export class IndeterminateHostEffectError extends Error {
  constructor(readonly point?: MutationCommit["point"]) {
    super("Host effect completion is indeterminate and requires reconciliation.");
    this.name = "IndeterminateHostEffectError";
  }
}

export interface GatewayDownloadAuthorization {
  schemaVersion: 1;
  authorizationId: string;
  invocationId: string;
  sessionId: string;
  /** Exact canonical ToolInvocation digest. */
  invocationDigest: string;
  /** Exact executor payload fingerprint, excluding this signed relay capability. */
  requestFingerprint: string;
  url: string;
  /** Operator-supplied immutable content identity; URL identity alone is insufficient. */
  expectedSha256: string;
  expectedBytes: number;
  maxBytes: number;
  timeoutMs: number;
  expiresAt: string;
  token: string;
  signature: string;
}

export interface CanonicalPath {
  path: string;
  kind: ExecutorEntryKind;
}

export interface HostEffectResult {
  output: JsonValue;
  summary: string;
  evidence: EvidenceReference[];
  /** Present only after a mutation has crossed its defined irreversible commit point. */
  mutationCommit?: MutationCommit;
  /** Runner data is deliberately not part of the signed JSON result until validated by the executor. */
  stagedResult?: UntrustedStagedResult;
}

export interface UntrustedStagedResult {
  regularFile: boolean;
  noLink: boolean;
  bytes: Uint8Array;
  sha256: string;
}

export interface ProcessRequest {
  mode: ShellMode;
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  onProgress(bytesProduced: number): void;
  /** Strictly bounded staged output returned by the credentialless runner. */
  change?: ShellCommand["change"];
}

export interface DownloadRequest {
  invocationId: string;
  sessionId: string;
  url: string;
  destination: string;
  timeoutMs: number;
  maxBytes: number;
  expectedSha256: string;
  expectedBytes: number;
  rejectPrivateAddresses: true;
  authorization?: GatewayDownloadAuthorization;
  signal: AbortSignal;
  onProgress(bytesReceived: number): void;
  assertCommitAllowed?: () => Promise<void>;
}

/** Security properties enforced inside the host adapter, beyond lexical executor guards. */
export interface HostEffectSecurityCapabilities {
  /** File effects resolve and operate relative to an already-open root descriptor without path re-resolution races. */
  descriptorRelativeWorkspaceConfinement?: true;
  /** Allowlisted commands are independently revalidated and can address only the mounted workspace root. */
  workspaceRootedCommandBoundary?: true;
  /** Downloads pin validated DNS answers and re-validate every redirect before connecting. */
  pinnedDnsRedirectEgressEnforcement?: true;
}

/**
 * The production implementation is the OS-boundary adapter. It must resolve every
 * symlink component (including the parent of a missing leaf), execute processes in
 * the workspace namespace, strip the environment, and enforce download policy on
 * every DNS answer and redirect. Tests inject an in-memory implementation.
 */
export interface DirectLiveHostEffects {
  readonly securityCapabilities?: HostEffectSecurityCapabilities;
  canonicalize(path: string): Promise<CanonicalPath>;
  readFile(path: string, maxBytes: number, signal: AbortSignal): Promise<HostEffectResult>;
  writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult>;
  deletePath(
    path: string,
    recursive: boolean,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult>;
  executeProcess(request: ProcessRequest): Promise<HostEffectResult>;
  executeConsole(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>,
    invocation?: MaintenanceInvocationIdentity
  ): Promise<HostEffectResult>;
  applyMaintenance?(
    request: MaintenanceApplyRequest,
    signal: AbortSignal,
    assertCommitAllowed?: () => Promise<void>
  ): Promise<HostEffectResult>;
  download(request: DownloadRequest): Promise<HostEffectResult>;
  requestBackup(label: string, signal: AbortSignal): Promise<HostEffectResult>;
  loadExtension(path: string, signal: AbortSignal): Promise<HostEffectResult>;
}

export interface ApprovalConsumer {
  /** Atomically consumes an exact single-invocation approval. False means stale/replayed. */
  consume(approvalId: string, sessionId: string, invocationDigest: string, consumedAt: string): Promise<boolean>;
}

export interface DirectLiveExecutorConfig {
  workspaceRoot?: string;
  scratchRoot: string;
  /** Exact canonical workspace-relative roots containing persistent Minecraft world data. */
  persistentWorldRoots?: readonly string[];
  /** Legacy dispatcher configuration is ignored by the shell boundary. */
  allowedExecutables?: Readonly<Record<string, string>>;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxDownloadBytes?: number;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  /** Applies cancellation to filesystem reads, writes, deletes, and extension loads. */
  maxFilesystemEffectMs?: number;
  maxProgressEvents?: number;
  /** Only enable behind the authenticated local gateway protocol. */
  acceptGatewayAuthorizations?: true;
  /** Production executors must receive the gateway-issued, content-bound download grant. */
  requireDownloadAuthorization?: true;
  /** Returns backup-required so the gateway can use the typed backup adapter. */
  externalBackupCoordinator?: true;
  /** Validated data-only aliases loaded from the immutable runtime release. */
  extensionTools?: readonly ToolDefinition[];
}

export type GatewayApprovalAuthorization = InvocationAuthorization;

export type GatewayBackupAuthorization =
  | BackupFenceAuthorization
  | {
      schemaVersion: 1;
      invocationDigest: string;
      status: "proceed-without-backup";
      approvalId: string;
      consumedAt: string;
    };

export interface RuntimeExecutionContext {
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  taskId: string;
}

export interface ExecuteInvocationRequest {
  actorId: string;
  invocation: ToolInvocation;
  policy: PermissionPolicy;
  approvals: AgentApproval[];
  approvalAuthorization?: GatewayApprovalAuthorization;
  backupAuthorization?: GatewayBackupAuthorization;
  runtimeContext?: RuntimeExecutionContext;
  /** Gateway-signed, one-use capability for the credential-less HTTPS relay. */
  downloadAuthorization?: GatewayDownloadAuthorization;
  signal?: AbortSignal;
  onProgress?(progress: ToolProgress): void | Promise<void>;
  /** Executor-protocol server callback; never serialized onto the wire. */
  assertCommitAllowed?: () => Promise<void>;
}

export interface DirectLiveExecutor {
  execute(request: ExecuteInvocationRequest): Promise<ToolResult>;
}
