#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { deriveBackupFencePublicKeyPem } from "../../lib/agent/runtime/backup-fence-key";
import { hasUnresolvedExecutorReceiptVerifierReference } from "../../lib/agent/runtime/executor-receipt";
import { bootstrapPinsFingerprint, validateBootstrapPins } from "../../lib/bootstrap-pins";
import {
  type ServerActionLock,
  acquireServerActionLock,
  assertServerActionLockOwned,
  isServerActionLockConflictError,
  releaseServerActionLock,
  renewServerActionLock,
} from "../../lib/server-action-lock";
import { deploymentReceiptSha256 } from "../cloudflare/deploy-env";
import {
  type CloudFormationTemplate,
  INSTANCE_LOGICAL_ID,
  assertStandardDeploymentInstanceSafe,
} from "./existing-deployment-migration";
import {
  type HostIdentity,
  type LifecycleFenceIdentity,
  assertApplicationBackupProof,
  assertCompletedRootSnapshot,
  assertExactReplacementConfirmations,
  assertInitiallyRunningHost,
  assertReviewedInstanceReplacementPlan,
  assertSafeToReleaseRuntimeRollout,
  assertSafeToReleaseUpgradeQuiescence,
  bindReplacementTransferAuthorization,
  classifyReviewedChangeSetExecution,
  envOutputLines,
  replacementConfirmationPhrase,
  requiresOldHostActivityCheckBeforeRecovery,
  runtimeFileDigest,
  validateLifecycleFenceIdentity,
  validateRequiredStackOutputs,
} from "./existing-host-upgrade";
import {
  type ReplacementFenceContext,
  ReplacementFenceHeartbeat,
  type ReplacementLifecycleOperation,
  claimReplacementLifecycleFence,
  createReplacementLifecycleOperation,
  finalizeReplacementLifecycleFence,
  initializeReplacementLifecycleOperation,
  parseReplacementLifecycleOperation,
  readReplacementLifecycleOperation,
  replacementTakeoverOwnerId,
  rollBackExpiredReplacementPreparation,
  takeOverExpiredReplacementFence,
} from "./replacement-lifecycle-operation";

// biome-ignore lint/suspicious/noExplicitAny: AWS CLI documents are intentionally open records.
type JsonRecord = Record<string, any>;
type Command =
  | "plan"
  | "rollout-runtime"
  | "reconcile-runtime-receipt"
  | "prepare-replacement"
  | "execute-replacement"
  | "recover";

interface Options {
  command: Command;
  region: string;
  stackName: string;
  confirmStackId?: string;
  confirmInstanceId?: string;
  confirmPins?: string;
  confirmSnapshotId?: string;
  confirmChangeSetId?: string;
  confirmReplacement?: string;
  confirmRecovery?: string;
  enableAgent: boolean;
  gatewayCredentialSource?: string;
  receiptRotationCutoffAt?: string;
}

interface UpgradeState {
  schemaVersion: 1;
  status: "preparing" | "prepared" | "executing" | "recovery-required" | "complete";
  changeKind: "replacement" | "in-place";
  identity: HostIdentity;
  snapshotId?: string;
  changeSetId?: string;
  backupName: string;
  restoreFloor?: { generation: number; backupId: string };
  backupProof?: {
    name: string;
    size: number;
    modifiedAt: string;
    backupId: string;
    generation: number;
    sourceInstanceId: string;
    operationKey: string;
    rootVolumeId: string;
    bootId: string;
    maintenanceOwner: string;
    quiescenceEpoch: string;
    terminalMode: "terminal-replacement";
  };
  transferOffer?: string;
  transferAuthorizationFence?: LifecycleFenceIdentity;
  newInstanceId?: string;
  lifecycleFence?: LifecycleFenceIdentity;
  replacementOperation?: ReplacementLifecycleOperation;
  oldHostActivityObservedAt?: string;
}

interface HostReleaseBuildEvidence {
  archive: string;
  sha256: string;
  bytes: number;
  releaseManifestSha256: string;
  releaseManifestBytes: number;
  agentRuntimeSha256: string;
  agentRuntimeBytes: number;
  agentRuntimeManifestSha256: string;
  agentRuntimeManifestBytes: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INFRA = path.join(ROOT, "infra");
const STATE_PATH = path.resolve(process.env.MC_AWS_HOST_UPGRADE_STATE || ".mc-aws-host-upgrade.json");
const RUNTIME_RECONCILIATION_PATH = path.resolve(
  process.env.MC_AWS_RUNTIME_RECONCILIATION_STATE || ".mc-aws-runtime-rollout.json"
);
const LIFECYCLE_OWNER_EMAIL = "host-upgrade@local.invalid";
const PINS = validateBootstrapPins(
  JSON.parse(readFileSync(path.join(ROOT, "config/bootstrap-pins.json"), "utf8")) as unknown
);
const PINS_SHA256 = bootstrapPinsFingerprint(PINS);

class CommandFailure extends Error {
  constructor(
    message: string,
    readonly output: string
  ) {
    super(message);
  }
}

function usage(): never {
  console.error(`Usage:
  pnpm host:upgrade -- plan [--region <region>] [--stack-name <name>]
  pnpm host:upgrade -- rollout-runtime --confirm-stack-id <arn> --confirm-instance-id <id> --confirm-pins <sha256> [--enable-agent --gateway-credential-source <host-dir>]
  pnpm host:upgrade -- reconcile-runtime-receipt --confirm-stack-id <arn> --confirm-instance-id <id> --confirm-pins <sha256>
  pnpm host:upgrade -- prepare-replacement --confirm-stack-id <arn> --confirm-instance-id <id>
  pnpm host:upgrade -- execute-replacement --confirm-stack-id <arn> --confirm-instance-id <old-id> \\
    --confirm-snapshot-id <snap-id> --confirm-change-set-id <arn> --confirm-replacement '<exact phrase>'
  pnpm host:upgrade -- recover --confirm-stack-id <arn> --confirm-instance-id <new-id> \\
    --confirm-recovery 'RESTORE <new-id> FROM <backup.tar.gz>'

plan is read-only. rollout-runtime is the supported idempotent existing-host path.
prepare creates a fresh Drive backup, stops EC2, creates a billed EBS snapshot,
publishes assets, and prepares (but does not execute) a replacement change set.`);
  process.exit(2);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict CLI parsing rejects unsupported confirmation combinations fail-closed.
function parseOptions(argv: string[]): Options {
  if (argv[0] === "--") argv.shift();
  const command = argv.shift() as Command;
  if (
    !new Set<Command>([
      "plan",
      "rollout-runtime",
      "reconcile-runtime-receipt",
      "prepare-replacement",
      "execute-replacement",
      "recover",
    ]).has(command)
  )
    usage();
  const options: Options = {
    command,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-1",
    stackName: "MinecraftStack",
    enableAgent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => argv[++index] ?? usage();
    if (argument === "--region") options.region = value();
    else if (argument === "--stack-name") options.stackName = value();
    else if (argument === "--confirm-stack-id") options.confirmStackId = value();
    else if (argument === "--confirm-instance-id") options.confirmInstanceId = value();
    else if (argument === "--confirm-pins") options.confirmPins = value();
    else if (argument === "--confirm-snapshot-id") options.confirmSnapshotId = value();
    else if (argument === "--confirm-change-set-id") options.confirmChangeSetId = value();
    else if (argument === "--confirm-replacement") options.confirmReplacement = value();
    else if (argument === "--confirm-recovery") options.confirmRecovery = value();
    else if (argument === "--enable-agent") options.enableAgent = true;
    else if (argument === "--gateway-credential-source") options.gatewayCredentialSource = value();
    else if (argument === "--receipt-rotation-cutoff-at") options.receiptRotationCutoffAt = value();
    else usage();
  }
  return options;
}

function run(command: string, args: string[], cwd = ROOT): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, AWS_PAGER: "" },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
      killSignal: "SIGTERM",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const output = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim();
    throw new CommandFailure(
      `${command} ${args.slice(0, 4).join(" ")} failed`,
      output || failure.message || "unknown error"
    );
  }
}

function runAsync(command: string, args: string[], cwd = ROOT, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, AWS_PAGER: "" },
        maxBuffer: 20 * 1024 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new CommandFailure(
              `${command} ${args.slice(0, 4).join(" ")} failed`,
              `${stderr ?? ""}${stdout ?? ""}`.trim() || error.message
            )
          );
          return;
        }
        resolve(String(stdout ?? "").trim());
      }
    );
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function aws(region: string, args: string[]): JsonRecord {
  const output = run("aws", ["--region", region, ...args, "--output", "json"]);
  return output ? JSON.parse(output) : {};
}

function writeState(state: UpgradeState): void {
  const temporary = `${STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  const temporaryDescriptor = openSync(temporary, "r");
  try {
    fsyncSync(temporaryDescriptor);
  } finally {
    closeSync(temporaryDescriptor);
  }
  renameSync(temporary, STATE_PATH);
  const parentDescriptor = openSync(path.dirname(STATE_PATH), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
}

interface RuntimeRolloutReconciliation {
  schemaVersion: 1;
  stackId: string;
  instanceId: string;
  pinsSha256: string;
  region: string;
  manifestPath: string;
  productionEnvPath: string;
  localEnvPath: string;
  lifecycleLockTableName: string;
  operationStateTableName: string;
  phase: "promoting" | "mutating" | "verifier-discovered" | "verifier-pinned" | "host-released";
  fence: LifecycleFenceIdentity;
  verifier?: JsonRecord;
  receiptVerifierRotated?: boolean;
}

function writeRuntimeReconciliation(state: RuntimeRolloutReconciliation): void {
  const temporary = `${RUNTIME_RECONCILIATION_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const descriptor = openSync(temporary, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, RUNTIME_RECONCILIATION_PATH);
  const parentDescriptor = openSync(path.dirname(RUNTIME_RECONCILIATION_PATH), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
}

function clearRuntimeReconciliation(): void {
  rmSync(RUNTIME_RECONCILIATION_PATH, { force: true });
  const parentDescriptor = openSync(path.dirname(RUNTIME_RECONCILIATION_PATH), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
}

function runtimeReconciliationBinding(
  options: Options
): Omit<
  RuntimeRolloutReconciliation,
  "schemaVersion" | "stackId" | "instanceId" | "pinsSha256" | "phase" | "fence" | "verifier" | "receiptVerifierRotated"
> {
  const lifecycleLockTableName = process.env.MC_LIFECYCLE_LOCK_TABLE_NAME?.trim();
  const operationStateTableName = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!lifecycleLockTableName || !operationStateTableName) {
    throw new Error("Runtime receipt reconciliation requires exact lifecycle and operation table bindings");
  }
  return {
    region: options.region,
    manifestPath: path.resolve(process.env.MC_AWS_DEPLOYMENT_MANIFEST || ".mc-aws-deployment.json"),
    productionEnvPath: path.resolve(".env.production"),
    localEnvPath: path.resolve(".env.local"),
    lifecycleLockTableName,
    operationStateTableName,
  };
}

function assertRuntimeReconciliationBinding(options: Options, state: RuntimeRolloutReconciliation): void {
  const expected = runtimeReconciliationBinding(options);
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (state[key] !== expected[key]) {
      throw new Error(`Runtime receipt reconciliation ${key} belongs to another deployment context`);
    }
  }
}

function readRuntimeReconciliation(
  identity?: Pick<HostIdentity, "stackId" | "instanceId">
): RuntimeRolloutReconciliation | null {
  if (!existsSync(RUNTIME_RECONCILIATION_PATH)) return null;
  const metadata = lstatSync(RUNTIME_RECONCILIATION_PATH);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error("Runtime rollout reconciliation state has unsafe metadata");
  }
  const state = JSON.parse(readFileSync(RUNTIME_RECONCILIATION_PATH, "utf8")) as RuntimeRolloutReconciliation;
  if (
    state.schemaVersion !== 1 ||
    (identity !== undefined && state.stackId !== identity.stackId) ||
    (identity !== undefined && state.instanceId !== identity.instanceId) ||
    state.pinsSha256 !== PINS_SHA256 ||
    !state.region ||
    !state.manifestPath ||
    !state.productionEnvPath ||
    !state.localEnvPath ||
    !state.lifecycleLockTableName ||
    !state.operationStateTableName ||
    !new Set(["promoting", "mutating", "verifier-discovered", "verifier-pinned", "host-released"]).has(state.phase)
  ) {
    throw new Error("Runtime rollout reconciliation state does not match this exact host and release");
  }
  state.fence = validateLifecycleFenceIdentity(state.fence);
  if (new Set(["verifier-discovered", "verifier-pinned", "host-released"]).has(state.phase) && !state.verifier) {
    throw new Error("Runtime rollout reconciliation state is missing its pinned verifier");
  }
  if (
    new Set(["verifier-discovered", "verifier-pinned", "host-released"]).has(state.phase) &&
    typeof state.receiptVerifierRotated !== "boolean"
  ) {
    throw new Error("Runtime rollout reconciliation state is missing its verifier rotation decision");
  }
  return state;
}

function normalizeTransferAuthorizationFence(state: UpgradeState): void {
  if (state.transferAuthorizationFence) {
    state.transferAuthorizationFence = validateLifecycleFenceIdentity(state.transferAuthorizationFence);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery state validation intentionally checks the full persisted trust boundary in one place.
function readState(): UpgradeState {
  const linkStatus = lstatSync(STATE_PATH);
  const status = statSync(STATE_PATH);
  if (
    linkStatus.isSymbolicLink() ||
    !linkStatus.isFile() ||
    status.nlink !== 1 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    (status.mode & 0o777) !== 0o600
  ) {
    throw new Error("Host-upgrade recovery state must be one current-user-owned 0600 regular file");
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Omit<UpgradeState, "changeKind"> & {
    changeKind?: UpgradeState["changeKind"];
  };
  if (state.schemaVersion !== 1) throw new Error("Unsupported host-upgrade recovery state");
  if (state.changeKind !== undefined && !new Set(["replacement", "in-place"]).has(state.changeKind)) {
    throw new Error("Host-upgrade recovery state has an unsupported change classification");
  }
  const normalized = { ...state, changeKind: state.changeKind ?? "replacement" } as UpgradeState;
  if (normalized.replacementOperation) {
    normalized.replacementOperation = parseReplacementLifecycleOperation(
      JSON.stringify(normalized.replacementOperation)
    );
    if (
      normalized.backupProof &&
      normalized.replacementOperation.backupProof &&
      JSON.stringify(normalized.backupProof) !== JSON.stringify(normalized.replacementOperation.backupProof)
    ) {
      throw new Error("Host-upgrade recovery state conflicts with durable terminal backup proof");
    }
    if (
      normalized.restoreFloor &&
      normalized.replacementOperation.restoreFloor &&
      JSON.stringify(normalized.restoreFloor) !== JSON.stringify(normalized.replacementOperation.restoreFloor)
    ) {
      throw new Error("Host-upgrade recovery state conflicts with durable restore-floor proof");
    }
  }
  normalizeTransferAuthorizationFence(normalized);
  if (normalized.status === "executing" || normalized.status === "recovery-required") {
    normalized.lifecycleFence = validateLifecycleFenceIdentity(normalized.lifecycleFence);
    if (!normalized.snapshotId || !normalized.changeSetId || !normalized.backupProof) {
      throw new Error("Host-upgrade recovery state is missing its reviewed backup/change-set evidence");
    }
    assertInitiallyRunningHost(normalized.identity);
  }
  if (
    new Set(["preparing", "prepared", "executing", "recovery-required"]).has(normalized.status) &&
    !normalized.replacementOperation
  ) {
    throw new Error("Host-upgrade recovery state is missing its durable replacement operation identity");
  }
  return normalized;
}

function describeStack(options: Options): JsonRecord {
  const response = aws(options.region, ["cloudformation", "describe-stacks", "--stack-name", options.stackName]);
  if (response.Stacks?.length !== 1) throw new Error("Expected exactly one target stack");
  return response.Stacks[0];
}

function stack(options: Options): JsonRecord {
  const found = describeStack(options);
  if (!new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]).has(found.StackStatus)) {
    throw new Error(`Host workflow requires a stable stack; found ${found.StackStatus}`);
  }
  return found;
}

function managedInstancePhysicalId(region: string, stackId: string): string {
  const detail = aws(region, [
    "cloudformation",
    "describe-stack-resource",
    "--stack-name",
    stackId,
    "--logical-resource-id",
    INSTANCE_LOGICAL_ID,
  ]).StackResourceDetail;
  if (
    detail?.StackId !== stackId ||
    detail?.LogicalResourceId !== INSTANCE_LOGICAL_ID ||
    detail?.ResourceType !== "AWS::EC2::Instance" ||
    !/^i-[a-f0-9]{8,17}$/.test(String(detail?.PhysicalResourceId ?? ""))
  ) {
    throw new Error(`CloudFormation did not prove the managed ${INSTANCE_LOGICAL_ID} physical instance`);
  }
  return String(detail.PhysicalResourceId);
}

function stackOutputs(found: JsonRecord): Record<string, unknown> {
  return Object.fromEntries((found.Outputs ?? []).map((output: JsonRecord) => [output.OutputKey, output.OutputValue]));
}

function liveTemplate(options: Options, found: JsonRecord): CloudFormationTemplate {
  const response = aws(options.region, [
    "cloudformation",
    "get-template",
    "--stack-name",
    found.StackId,
    "--template-stage",
    "Original",
  ]);
  return (
    typeof response.TemplateBody === "string" ? JSON.parse(response.TemplateBody) : response.TemplateBody
  ) as CloudFormationTemplate;
}

function hostIdentity(options: Options, found: JsonRecord): HostIdentity {
  const outputs = stackOutputs(found);
  const instanceId = outputs.InstanceId;
  if (typeof instanceId !== "string") throw new Error("Stack has no InstanceId output");
  const response = aws(options.region, ["ec2", "describe-instances", "--instance-ids", instanceId]);
  const instance = response.Reservations?.[0]?.Instances?.[0];
  const root = instance?.BlockDeviceMappings?.find(
    (mapping: JsonRecord) => mapping.DeviceName === instance.RootDeviceName
  );
  if (!instance || !root?.Ebs?.VolumeId || root.Ebs.DeleteOnTermination !== true) {
    throw new Error("Could not prove the live DeleteOnTermination root volume");
  }
  const initialInstanceState = instance.State?.Name;
  if (initialInstanceState !== "running" && initialInstanceState !== "stopped") {
    throw new Error(`Host workflow requires a stable running or stopped instance; found ${initialInstanceState}`);
  }
  const volume = aws(options.region, ["ec2", "describe-volumes", "--volume-ids", root.Ebs.VolumeId]).Volumes?.[0];
  if (
    !volume ||
    volume.Encrypted !== true ||
    volume.State !== "in-use" ||
    volume.Attachments?.length !== 1 ||
    volume.Attachments[0].InstanceId !== instanceId ||
    volume.Attachments[0].State !== "attached"
  ) {
    throw new Error("Could not prove one encrypted root volume attached only to the live instance");
  }
  const targetAmiId = (process.env.AL2023_ARM64_AMI_ID ?? "").trim();
  if (!/^ami-[a-f0-9]{8,17}$/.test(targetAmiId)) {
    throw new Error("AL2023_ARM64_AMI_ID must be loaded from the reviewed deployment environment");
  }
  return {
    stackId: found.StackId,
    instanceId,
    rootVolumeId: root.Ebs.VolumeId,
    currentAmiId: instance.ImageId,
    targetAmiId,
    initialInstanceState,
  };
}

function assertBasicConfirmation(options: Options, identity: HostIdentity): void {
  if (options.confirmStackId !== identity.stackId || options.confirmInstanceId !== identity.instanceId) {
    throw new Error(
      `Mutation refused. Pass --confirm-stack-id ${identity.stackId} --confirm-instance-id ${identity.instanceId}`
    );
  }
}

function waitForSsmCommand(region: string, commandId: string, instanceId: string): JsonRecord {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    let result: JsonRecord | undefined;
    try {
      result = aws(region, ["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId]);
    } catch (error) {
      if (!(error instanceof CommandFailure) || !/InvocationDoesNotExist/.test(error.output)) throw error;
    }
    if (result && new Set(["Success", "Cancelled", "TimedOut", "Failed", "Cancelling"]).has(result.Status)) {
      return result;
    }
    run("sleep", ["5"]);
  }
  throw new Error(`Host command ${commandId} did not reach a terminal state within 30 minutes`);
}

function ssmCommand(region: string, instanceId: string, commands: string[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-host-command-"));
  try {
    const input = path.join(directory, "request.json");
    writeFileSync(
      input,
      JSON.stringify({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands, executionTimeout: ["1800"] },
      }),
      { mode: 0o600 }
    );
    const sent = aws(region, ["ssm", "send-command", "--cli-input-json", `file://${input}`]);
    const commandId = sent.Command?.CommandId;
    if (typeof commandId !== "string") throw new Error("SSM did not return a command ID");
    const result = waitForSsmCommand(region, commandId, instanceId);
    if (result.Status !== "Success")
      throw new Error(`Host command failed: ${result.StandardErrorContent || result.Status}`);
    return String(result.StandardOutputContent ?? "").trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForSsmCommandWithFence(
  region: string,
  commandId: string,
  instanceId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<JsonRecord> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    await heartbeat.assertHealthy();
    let result: JsonRecord | undefined;
    try {
      result = aws(region, ["ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId]);
    } catch (error) {
      if (!(error instanceof CommandFailure) || !/InvocationDoesNotExist/.test(error.output)) throw error;
    }
    if (result && new Set(["Success", "Cancelled", "TimedOut", "Failed", "Cancelling"]).has(result.Status)) {
      return result;
    }
    await delay(5_000, heartbeat.signal);
  }
  throw new Error(`Host command ${commandId} did not reach a terminal state within 30 minutes`);
}

async function ssmCommandWithFence(
  region: string,
  instanceId: string,
  commands: string[],
  heartbeat: ReplacementFenceHeartbeat,
  checkpointBeforeDispatch = true
): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-host-command-"));
  try {
    if (checkpointBeforeDispatch) await heartbeat.checkpoint();
    const input = path.join(directory, "request.json");
    writeFileSync(
      input,
      JSON.stringify({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands, executionTimeout: ["1800"] },
      }),
      { mode: 0o600 }
    );
    const sent = aws(region, ["ssm", "send-command", "--cli-input-json", `file://${input}`]);
    const commandId = sent.Command?.CommandId;
    if (typeof commandId !== "string") throw new Error("SSM did not return a command ID");
    const result = await waitForSsmCommandWithFence(region, commandId, instanceId, heartbeat);
    if (result.Status !== "Success")
      throw new Error(`Host command failed: ${result.StandardErrorContent || result.Status}`);
    return String(result.StandardOutputContent ?? "").trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function reviewedBackupFencePublicKey(options: Options): { content: string } | undefined {
  if (!options.enableAgent) return undefined;
  if (!options.gatewayCredentialSource) {
    throw new Error(
      "--enable-agent requires --gateway-credential-source pointing to a root-only secure source on the host"
    );
  }
  const privateKey = process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8?.trim();
  if (!privateKey)
    throw new Error("--enable-agent requires the reviewed backup-fence authority in the deployment environment");
  const publicKey = deriveBackupFencePublicKeyPem(privateKey);
  return { content: Buffer.from(publicKey, "ascii").toString("base64") };
}

function configureLifecycleLockEnvironment(found: JsonRecord): void {
  const outputs = validateRequiredStackOutputs(stackOutputs(found));
  process.env.MC_LIFECYCLE_LOCK_TABLE_NAME = outputs.LifecycleLockTableName;
  process.env.MC_OPERATION_STATE_TABLE_NAME = outputs.OperationStateTableName;
}

function readResumeIntentPointer(region: string, table: string, pointerId: string): JsonRecord | undefined {
  const response = aws(region, [
    "dynamodb",
    "get-item",
    "--table-name",
    table,
    "--consistent-read",
    "--key",
    JSON.stringify({ operationId: { S: pointerId } }),
  ]);
  return response.Item as JsonRecord | undefined;
}

function inspectResumeIntentPointer(
  currentItem: JsonRecord | undefined,
  operationId: string,
  ownerToken: string,
  status: "active" | "completed"
): { current?: JsonRecord; expectedVersion: number; alreadyActive: boolean } {
  if (!currentItem) return { expectedVersion: 0, alreadyActive: false };
  let current: JsonRecord | undefined;
  let expectedVersion: number;
  try {
    current = JSON.parse(String(currentItem.payload?.S ?? "")) as JsonRecord;
    expectedVersion = Number(currentItem.version?.N ?? Number.NaN);
  } catch {
    throw new Error("Resume intent pointer is malformed");
  }
  if (
    !current ||
    current.kind !== "mc-aws-resume-intent" ||
    current.schemaVersion !== 1 ||
    !Number.isSafeInteger(expectedVersion) ||
    current.version !== expectedVersion
  ) {
    throw new Error("Resume intent pointer is malformed");
  }
  if (current.status === "active" && (current.operationId !== operationId || current.ownerToken !== ownerToken)) {
    throw new Error("Another resume intent is active; refusing successor replacement");
  }
  return {
    current,
    expectedVersion,
    alreadyActive:
      status === "active" &&
      current.status !== "active" &&
      current.operationId === operationId &&
      current.ownerToken === ownerToken,
  };
}

function writeResumeIntentPointer(
  region: string,
  table: string,
  pointerId: string,
  operationId: string,
  ownerToken: string,
  status: "active" | "completed",
  intent: JsonRecord,
  current: JsonRecord | undefined,
  expectedVersion: number
): void {
  const pointer = {
    schemaVersion: 1,
    kind: "mc-aws-resume-intent",
    operationId,
    ownerToken,
    status,
    intent,
    version: expectedVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  const values = {
    ":expected": { N: String(expectedVersion) },
    ":active": { S: "active" },
    ":operationId": { S: operationId },
    ":ownerToken": { S: ownerToken },
    ":payload": { S: JSON.stringify(pointer) },
    ":version": { N: String(pointer.version) },
    ":status": { S: status },
    ":updatedAt": { S: pointer.updatedAt },
  };
  const condition = current
    ? "#version = :expected AND (#status <> :active OR (operationIdOwner = :operationId AND ownerToken = :ownerToken))"
    : "attribute_not_exists(operationId)";
  try {
    aws(region, [
      "dynamodb",
      "update-item",
      "--table-name",
      table,
      "--key",
      JSON.stringify({ operationId: { S: pointerId } }),
      "--condition-expression",
      condition,
      "--update-expression",
      "SET payload = :payload, #version = :version, #status = :status, operationIdOwner = :operationId, ownerToken = :ownerToken, updatedAt = :updatedAt REMOVE ttlEpochSeconds",
      "--expression-attribute-names",
      JSON.stringify({ "#version": "version", "#status": "status" }),
      "--expression-attribute-values",
      JSON.stringify(values),
    ]);
  } catch (error) {
    throw new Error(`Resume intent pointer transition was not accepted: ${(error as Error).message}`);
  }
}

function transitionResumeIntentPointer(
  region: string,
  operationId: string,
  ownerToken: string,
  intent: JsonRecord,
  status: "active" | "completed"
): void {
  const table = process.env.MC_OPERATION_STATE_TABLE_NAME?.trim();
  if (!table || !/^[A-Za-z0-9_.:-]{3,255}$/.test(table)) {
    throw new Error("Resume intent pointer requires the authoritative operation-state table");
  }
  const pointerId = "mc-aws-resume-intent";
  const inspected = inspectResumeIntentPointer(
    readResumeIntentPointer(region, table, pointerId),
    operationId,
    ownerToken,
    status
  );
  if (inspected.alreadyActive) return;
  writeResumeIntentPointer(
    region,
    table,
    pointerId,
    operationId,
    ownerToken,
    status,
    intent,
    inspected.current,
    inspected.expectedVersion
  );
}

function fenceIdentity(lock: ServerActionLock): LifecycleFenceIdentity {
  if (!Number.isSafeInteger(lock.leaseGeneration) || (lock.leaseGeneration ?? 0) < 1) {
    throw new Error("Lifecycle lock did not return an exact lease generation");
  }
  return {
    lockId: lock.lockId,
    fencingToken: lock.fencingToken,
    leaseGeneration: lock.leaseGeneration as number,
    action: "backup",
    ownerEmail: LIFECYCLE_OWNER_EMAIL,
  };
}

async function acquireLifecycleFence(): Promise<LifecycleFenceIdentity> {
  return fenceIdentity(await acquireServerActionLock("backup", LIFECYCLE_OWNER_EMAIL));
}

async function assertLifecycleFenceOwned(fence: LifecycleFenceIdentity): Promise<ServerActionLock> {
  const current = await assertServerActionLockOwned(fence.lockId, fence.fencingToken, fence.action, {
    ownerEmail: fence.ownerEmail,
  });
  if (current.leaseGeneration !== fence.leaseGeneration || current.ownerEmail !== fence.ownerEmail) {
    throw new Error("Lifecycle fence generation or owner changed; refusing host mutation");
  }
  return current;
}

async function releaseLifecycleFence(fence: LifecycleFenceIdentity): Promise<void> {
  const released = await releaseServerActionLock(fence.lockId, {
    action: fence.action,
    ownerEmail: fence.ownerEmail,
    fencingToken: fence.fencingToken,
    leaseGeneration: fence.leaseGeneration,
  });
  if (!released) throw new Error("Lifecycle fence is no longer owned; refusing conditional release");
}

function contextFromReplacementOperation(operation: ReplacementLifecycleOperation): ReplacementFenceContext {
  if (
    !operation.lockId ||
    !Number.isSafeInteger(operation.fencingToken) ||
    !Number.isSafeInteger(operation.lockLeaseGeneration) ||
    !operation.lockLeaseExpiresAt
  ) {
    throw new Error("Replacement operation has no complete lifecycle fence identity");
  }
  return {
    operation,
    fence: {
      lockId: operation.lockId,
      fencingToken: operation.fencingToken as number,
      leaseGeneration: operation.lockLeaseGeneration as number,
      action: "backup",
      ownerEmail: LIFECYCLE_OWNER_EMAIL,
    },
  };
}

function persistReplacementContext(state: UpgradeState, context: ReplacementFenceContext): void {
  state.replacementOperation = context.operation;
  state.lifecycleFence = context.fence;
  writeState(state);
}

function replacementHeartbeat(state: UpgradeState, context: ReplacementFenceContext): ReplacementFenceHeartbeat {
  const heartbeat = new ReplacementFenceHeartbeat(context, {
    persist: (renewed) => persistReplacementContext(state, renewed),
  });
  heartbeat.start();
  return heartbeat;
}

async function finalizeInvalidatedReplacement(
  state: UpgradeState,
  heartbeat: ReplacementFenceHeartbeat,
  releaseHost?: () => Promise<void>
): Promise<void> {
  let terminal = await heartbeat.checkpoint({
    status: "failed",
    phase: "rolled-back",
    oldHostSafetyInvalidatedAt: heartbeat.context.operation.oldHostSafetyInvalidatedAt ?? new Date().toISOString(),
    ...(releaseHost ? { hostMaintenanceReleaseRequested: true } : {}),
  });
  if (releaseHost) {
    await releaseHost();
    terminal = await heartbeat.checkpoint({ hostMaintenanceReleased: true });
  }
  terminal = await heartbeat.stopAfterTerminal();
  state.replacementOperation = await finalizeReplacementLifecycleFence(terminal);
  state.status = "complete";
  writeState(state);
}

async function invalidateReplacementAfterHostActivity(
  options: Options,
  state: UpgradeState,
  context: ReplacementFenceContext,
  existingHeartbeat?: ReplacementFenceHeartbeat
): Promise<void> {
  const heartbeat = existingHeartbeat ?? replacementHeartbeat(state, context);
  if (!heartbeat.context.operation.oldHostSafetyInvalidatedAt) {
    await heartbeat.checkpoint({
      phase: "recovery-required",
      oldHostSafetyInvalidatedAt: new Date().toISOString(),
    });
  }
  let disposition = oldHostDisposition(options.region, state.identity.instanceId);
  if (disposition === "stopping") {
    await waitInstanceWithFence(options.region, state.identity.instanceId, "stopped", heartbeat);
    disposition = "stopped";
  }
  if (disposition === "pending") {
    await waitInstanceWithFence(options.region, state.identity.instanceId, "running", heartbeat);
    disposition = "running";
  }
  if (disposition === "running") {
    aws(options.region, ["ec2", "stop-instances", "--instance-ids", state.identity.instanceId]);
    await waitInstanceWithFence(options.region, state.identity.instanceId, "stopped", heartbeat);
    disposition = "stopped";
  }
  if (!new Set(["stopped", "terminated", "absent"]).has(disposition)) {
    throw new Error("Invalidated replacement host could not be returned to terminal quiescence");
  }
  if (disposition === "stopped") {
    if (
      !state.backupProof ||
      !state.replacementOperation?.operationId ||
      !state.replacementOperation.operationOwnerId
    ) {
      throw new Error("Invalidated replacement has no exact durable resume owner");
    }
    await heartbeat.checkpoint();
    aws(options.region, ["ec2", "start-instances", "--instance-ids", state.identity.instanceId]);
    await waitInstanceWithFence(options.region, state.identity.instanceId, "running", heartbeat);
    await waitSsmOnline(options, state.identity.instanceId, heartbeat);
    const output = await ssmCommandWithFence(
      options.region,
      state.identity.instanceId,
      [
        `sudo env MC_RESUME_OPERATION_ID=${shellQuote(state.replacementOperation.operationId)} MC_RESUME_OPERATION_OWNER_TOKEN=${shellQuote(state.replacementOperation.operationOwnerId)} MC_MAINTENANCE_PARENT_OPERATION=host-replacement /usr/local/bin/mc-resume.sh fresh`,
        "sudo /usr/local/bin/mc-wait-ready.sh raw_ip '' ''",
      ],
      heartbeat
    );
    if (!output.includes('"ready":true'))
      throw new Error("Invalidated original host did not return to protocol readiness");
    await finalizeInvalidatedReplacement(state, heartbeat, () =>
      releaseHostMaintenance(
        options,
        state.identity.instanceId,
        state.backupProof!.maintenanceOwner,
        "host-replacement",
        heartbeat
      )
    );
    return;
  }
  await finalizeInvalidatedReplacement(state, heartbeat);
}

function instanceState(region: string, instanceId: string): string | undefined {
  return aws(region, ["ec2", "describe-instances", "--instance-ids", instanceId]).Reservations?.[0]?.Instances?.[0]
    ?.State?.Name;
}

function oldHostDisposition(region: string, instanceId: string): string {
  try {
    const response = aws(region, ["ec2", "describe-instances", "--instance-ids", instanceId]);
    const instances = (response.Reservations ?? []).flatMap((reservation: JsonRecord) => reservation.Instances ?? []);
    const exact = instances.filter((instance: JsonRecord) => instance.InstanceId === instanceId);
    if (exact.length === 0) return "absent";
    if (exact.length !== 1 || typeof exact[0].State?.Name !== "string") {
      throw new Error("Old-host EC2 disposition is malformed or ambiguous");
    }
    return exact[0].State.Name;
  } catch (error) {
    if (error instanceof CommandFailure && /InvalidInstanceID\.NotFound/.test(error.output)) return "absent";
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Reconciliation keeps authoritative owner, expiry, physical-stop, invalidation, and mirror-repair decisions in one fail-closed boundary.
async function reconcileReplacementFence(options: Options, state: UpgradeState): Promise<ReplacementFenceContext> {
  const persisted = state.replacementOperation;
  if (!persisted) throw new Error("Replacement recovery state has no durable operation identity");
  const authoritative = await readReplacementLifecycleOperation(persisted.operationId);
  if (!authoritative) throw new Error("Replacement durable operation state is unavailable");
  if (
    authoritative.stackId !== state.identity.stackId ||
    authoritative.oldInstanceId !== state.identity.instanceId ||
    authoritative.rootVolumeId !== state.identity.rootVolumeId ||
    authoritative.currentAmiId !== state.identity.currentAmiId ||
    authoritative.targetAmiId !== state.identity.targetAmiId
  ) {
    throw new Error("Replacement durable operation identity changed");
  }
  const context = contextFromReplacementOperation(authoritative);
  const expired = Date.parse(authoritative.lockLeaseExpiresAt as string) <= Date.now();
  if (
    authoritative.operationOwnerId !== persisted.operationOwnerId &&
    authoritative.operationOwnerId === replacementTakeoverOwnerId(persisted)
  ) {
    const recoveredTakeover = await takeOverExpiredReplacementFence(
      persisted,
      oldHostDisposition(options.region, state.identity.instanceId),
      authoritative.operationOwnerId
    );
    persistReplacementContext(state, recoveredTakeover);
    return recoveredTakeover;
  }
  if (!expired) {
    if (authoritative.operationOwnerId !== persisted.operationOwnerId) {
      throw new Error(
        "Replacement lifecycle owner changed and remains unexpired; wait for the exact recovery lease boundary"
      );
    }
    await assertLifecycleFenceOwned(context.fence);
    persistReplacementContext(state, context);
    return context;
  }
  if (
    !authoritative.quiesceRequestedAt &&
    !authoritative.oldHostAgentDrained &&
    !authoritative.oldHostMasked &&
    !authoritative.stopRequestedAt
  ) {
    state.replacementOperation = await rollBackExpiredReplacementPreparation(authoritative);
    state.status = "complete";
    writeState(state);
    throw new Error("Expired pre-quiescence replacement preparation was rolled back; rerun prepare-replacement");
  }
  let stopped = oldHostDisposition(options.region, state.identity.instanceId);
  const hostWasActive = stopped === "running" || stopped === "pending";
  const stoppingAfterSafety =
    stopped === "stopping" &&
    new Set<ReplacementLifecycleOperation["phase"]>([
      "old-host-safe",
      "snapshot-requested",
      "snapshot-complete",
      "change-set-requested",
      "prepared",
      "execution-requested",
      "execution-complete",
      "executing",
      "restoring",
      "recovery-required",
    ]).has(authoritative.phase);
  if ((hostWasActive || stoppingAfterSafety) && !state.oldHostActivityObservedAt) {
    state.oldHostActivityObservedAt = new Date().toISOString();
    writeState(state);
  }
  const invalidateBackupEvidence =
    state.oldHostActivityObservedAt !== undefined ||
    authoritative.oldHostSafetyCheckPending === true ||
    !authoritative.oldHostAgentDrained ||
    !authoritative.oldHostMasked;
  if (stopped === "running" || stopped === "pending") {
    aws(options.region, ["ec2", "stop-instances", "--instance-ids", state.identity.instanceId]);
    aws(options.region, ["ec2", "wait", "instance-stopped", "--instance-ids", state.identity.instanceId]);
    stopped = oldHostDisposition(options.region, state.identity.instanceId);
  } else if (stopped === "stopping") {
    aws(options.region, ["ec2", "wait", "instance-stopped", "--instance-ids", state.identity.instanceId]);
    stopped = oldHostDisposition(options.region, state.identity.instanceId);
  }
  const taken = await takeOverExpiredReplacementFence(authoritative, stopped, undefined, invalidateBackupEvidence);
  persistReplacementContext(state, taken);
  if (taken.operation.oldHostSafetyInvalidatedAt) {
    await invalidateReplacementAfterHostActivity(options, state, taken);
    throw new Error(
      "Expired replacement safety uncertainty invalidated its backup evidence; run fresh prepare-replacement"
    );
  }
  const takeoverHeartbeat = replacementHeartbeat(state, taken);
  await takeoverHeartbeat.checkpoint({ oldHostSafetyCheckPending: true });
  const confirmed = oldHostDisposition(options.region, state.identity.instanceId);
  if (!new Set(["stopped", "terminated", "absent"]).has(confirmed)) {
    if (confirmed === "running" || confirmed === "pending" || confirmed === "stopping") {
      await invalidateReplacementAfterHostActivity(options, state, takeoverHeartbeat.context, takeoverHeartbeat);
      throw new Error("Replacement takeover observed renewed host activity; run fresh prepare-replacement");
    }
    throw new Error("Replacement takeover fenced a host whose stopped state changed; retaining the new fence");
  }
  const proven = await takeoverHeartbeat.checkpoint({
    oldHostStopped: true,
    oldHostDisposition: confirmed as "stopped" | "terminated" | "absent",
    oldHostSafetyCheckPending: false,
  });
  persistReplacementContext(state, proven);
  return proven;
}

function reviewedHostRelease(options: Options): {
  build: HostReleaseBuildEvidence;
  published: {
    uri: string;
    sha256: string;
    bytes: number;
    releaseManifestSha256: string;
    releaseManifestBytes: number;
    profile: {
      uri: string;
      sha256: string;
      fileCount: number;
      totalBytes: number;
      plugins: Array<{ name: string; destination: string; url: string; sha256: string; bytes?: number }>;
    };
  };
} {
  const build = JSON.parse(
    run(process.execPath, [path.join(ROOT, "scripts/setup/build-host-release.mjs"), "package"])
  ) as HostReleaseBuildEvidence;
  const archiveStatus = statSync(build.archive);
  if (
    !archiveStatus.isFile() ||
    archiveStatus.size !== build.bytes ||
    path.basename(build.archive) !== `${build.sha256}.zip` ||
    runtimeFileDigest(readFileSync(build.archive)) !== build.sha256 ||
    !/^[a-f0-9]{64}$/.test(build.releaseManifestSha256) ||
    !Number.isSafeInteger(build.releaseManifestBytes) ||
    build.releaseManifestBytes < 1
  ) {
    throw new Error("Current local agent runtime package evidence is invalid");
  }
  const publishedManifest = aws(options.region, [
    "ssm",
    "get-parameter",
    "--name",
    "/minecraft/server-profile-manifest",
  ]).Parameter?.Value;
  if (typeof publishedManifest !== "string") throw new Error("Published runtime manifest is missing");
  const manifest = JSON.parse(publishedManifest) as Record<string, unknown>;
  if (manifest.version !== 3 || Object.keys(manifest).sort().join(",") !== "hostRelease,profile,version") {
    throw new Error("Published runtime manifest is not the current atomic schema");
  }
  const published = manifest.hostRelease as {
    uri: string;
    sha256: string;
    bytes: number;
    releaseManifestSha256: string;
    releaseManifestBytes: number;
  };
  const profile = manifest.profile as {
    uri: string;
    sha256: string;
    fileCount: number;
    totalBytes: number;
    plugins: Array<{ name: string; destination: string; url: string; sha256: string; bytes?: number }>;
  };
  if (
    !published ||
    Object.keys(published).sort().join(",") !== "bytes,releaseManifestBytes,releaseManifestSha256,sha256,uri" ||
    !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9!_.*'()/-]+$/.test(published.uri) ||
    !/^[a-f0-9]{64}$/.test(published.sha256) ||
    !Number.isSafeInteger(published.bytes) ||
    published.bytes < 1 ||
    !/^[a-f0-9]{64}$/.test(published.releaseManifestSha256) ||
    !Number.isSafeInteger(published.releaseManifestBytes) ||
    published.releaseManifestBytes < 1 ||
    published.sha256 !== build.sha256 ||
    published.bytes !== build.bytes ||
    published.releaseManifestSha256 !== build.releaseManifestSha256 ||
    published.releaseManifestBytes !== build.releaseManifestBytes ||
    !profile ||
    Object.keys(profile).sort().join(",") !== "fileCount,plugins,sha256,totalBytes,uri" ||
    !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9!_.*'()\/-]+$/.test(profile.uri) ||
    !/^[a-f0-9]{64}$/.test(profile.sha256) ||
    !Number.isSafeInteger(profile.fileCount) ||
    profile.fileCount < 1 ||
    !Number.isSafeInteger(profile.totalBytes) ||
    profile.totalBytes < 1 ||
    !Array.isArray(profile.plugins)
  )
    throw new Error("Published host release does not match the current locally built/reviewed release");
  return { build, published: { ...published, profile } };
}

type ReviewedHostRelease = ReturnType<typeof reviewedHostRelease>;

function rolloutManifest(release: ReviewedHostRelease): string {
  return Buffer.from(
    JSON.stringify({
      version: 3,
      hostRelease: {
        uri: release.published.uri,
        sha256: release.published.sha256,
        bytes: release.published.bytes,
        releaseManifestSha256: release.published.releaseManifestSha256,
        releaseManifestBytes: release.published.releaseManifestBytes,
      },
      profile: release.published.profile,
    })
  ).toString("base64");
}

function rolloutHostCommands(
  options: Options,
  release: ReviewedHostRelease,
  adoptHostReplacement = false,
  retainedMaintenanceOwner?: string
): string[] {
  const backupFence = reviewedBackupFencePublicKey(options);
  const work = 'release_work="$(mktemp -d /tmp/mc-aws-host-release-transfer.XXXXXX)"';
  const cleanup = 'cleanup_transfer() { status=$?; rm -rf -- "$release_work"; exit "$status"; }';
  const agentOptions = options.enableAgent
    ? ` --enable-agent --gateway-credential-source ${shellQuote(options.gatewayCredentialSource as string)} --backup-fence-public-source "$backup_fence_source"`
    : "";
  return [
    "set -euo pipefail; umask 077",
    work,
    cleanup,
    "trap cleanup_transfer EXIT HUP INT TERM",
    `printf '%s' '${rolloutManifest(release)}' | base64 --decode > "$release_work/asset-manifest.json"`,
    `aws s3 cp --only-show-errors '${release.published.uri}' "$release_work/host-release.zip"`,
    `test "$(stat -c '%s' "$release_work/host-release.zip")" = '${release.build.bytes}'`,
    `printf '%s  %s\n' '${release.build.sha256}' "$release_work/host-release.zip" | sha256sum --check --status`,
    'mkdir "$release_work/extracted"; unzip -q "$release_work/host-release.zip" -d "$release_work/extracted"',
    `printf '%s  %s\n' '${release.build.releaseManifestSha256}' "$release_work/extracted/release-manifest.json" | sha256sum --check --status`,
    ...(backupFence
      ? [
          "install -d -o root -g root -m 0755 /run/mc-agent",
          'backup_fence_source="$(mktemp /run/mc-agent/.backup-fence-public.XXXXXX)"',
          `printf '%s' '${backupFence.content}' | base64 --decode > "$backup_fence_source"`,
          'chown root:root "$backup_fence_source" && chmod 0400 "$backup_fence_source"',
        ]
      : []),
    `${adoptHostReplacement ? "MC_RUNTIME_ROLLOUT_ADOPT_OPERATION=host-replacement " : ""}${retainedMaintenanceOwner ? `MC_RUNTIME_ROLLOUT_RETAIN_MAINTENANCE=1 MC_MAINTENANCE_OWNER=${shellQuote(retainedMaintenanceOwner)} ` : ""}bash "$release_work/extracted/host/mc-runtime-rollout.sh" --confirm-pins '${PINS_SHA256}' --release-root "$release_work/extracted" --manifest-file "$release_work/asset-manifest.json"${agentOptions}`,
    ...(backupFence ? ['rm -f -- "$backup_fence_source"'] : []),
    "trap - EXIT HUP INT TERM",
    'rm -rf -- "$release_work"',
  ];
}

function receiptVerifierFrom(output: string): JsonRecord {
  const line = output.split("\n").find((candidate) => candidate.startsWith("MC_EXECUTOR_RECEIPT_VERIFIER="));
  if (!line) throw new Error("Verified host rollout did not return executor receipt verifier authority");
  return JSON.parse(line.slice("MC_EXECUTOR_RECEIPT_VERIFIER=".length)) as JsonRecord;
}

interface ReceiptVerifierRecord {
  keyId: string;
  publicKeySpki: string;
  keyEpoch: number;
}

function localReceiptVerifiers(): ReceiptVerifierRecord[] {
  const manifestPath = path.resolve(process.env.MC_AWS_DEPLOYMENT_MANIFEST || ".mc-aws-deployment.json");
  const metadata = lstatSync(manifestPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Deployment manifest must remain an existing secure regular file during verifier reconciliation");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
  const verifiers = (manifest.executorReceipt as JsonRecord | undefined)?.verifiers;
  if (!Array.isArray(verifiers)) return [];
  return verifiers.map((item) => ({
    keyId: String(item.keyId ?? ""),
    publicKeySpki: String(item.publicKeySpki ?? ""),
    keyEpoch: Number(item.keyEpoch),
  }));
}

function workerDeploymentTrustsLocalReceiptAuthority(): boolean {
  const manifestPath = path.resolve(process.env.MC_AWS_DEPLOYMENT_MANIFEST || ".mc-aws-deployment.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
  const executorReceipt = manifest.executorReceipt;
  const worker = (manifest.cloudflare as JsonRecord | undefined)?.worker as JsonRecord | undefined;
  if (
    !executorReceipt ||
    typeof worker?.deploymentId !== "string" ||
    !/^[a-f0-9-]{8,64}$/i.test(worker.deploymentId) ||
    typeof worker.versionId !== "string" ||
    !/^[a-f0-9-]{8,64}$/i.test(worker.versionId) ||
    typeof worker.scriptEtag !== "string" ||
    !worker.scriptEtag ||
    /[\t\r\n]/.test(worker.scriptEtag) ||
    typeof worker.artifactMerkleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(worker.artifactMerkleSha256) ||
    typeof worker.receiptVerifierSetSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(worker.receiptVerifierSetSha256) ||
    typeof worker.uploadConfigSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(worker.uploadConfigSha256) ||
    typeof worker.deploymentReceiptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(worker.deploymentReceiptSha256)
  ) {
    return false;
  }
  const localAuthoritySha256 = createHash("sha256").update(JSON.stringify(executorReceipt)).digest("hex");
  if (worker.receiptVerifierSetSha256 !== localAuthoritySha256) return false;
  try {
    return (
      deploymentReceiptSha256({
        deploymentId: worker.deploymentId,
        versionId: worker.versionId,
        scriptEtag: worker.scriptEtag,
        artifactMerkleSha256: worker.artifactMerkleSha256,
        receiptVerifierSetSha256: worker.receiptVerifierSetSha256,
        uploadConfigSha256: worker.uploadConfigSha256,
      }) === worker.deploymentReceiptSha256
    );
  } catch {
    return false;
  }
}

function verifierIdentity(value: JsonRecord): ReceiptVerifierRecord {
  const keyId = String(value.keyId ?? "");
  const publicKeySpki = String(value.publicKeySpki ?? "");
  const keyEpoch = Number(value.keyEpoch);
  if (
    !/^executor-receipt-[a-f0-9]{64}$/.test(keyId) ||
    !/^[A-Za-z0-9+/]{59}=$/.test(publicKeySpki) ||
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1
  ) {
    throw new Error("Verified host rollout returned malformed executor receipt verifier authority");
  }
  return { keyId, publicKeySpki, keyEpoch };
}

function receiptVerifierWouldRotate(verifier: JsonRecord): boolean {
  const current = localReceiptVerifiers()[0];
  return (
    !current ||
    !sameVerifierIdentity(current, verifierIdentity(verifier)) ||
    !workerDeploymentTrustsLocalReceiptAuthority()
  );
}

function sameVerifierIdentity(left: ReceiptVerifierRecord, right: ReceiptVerifierRecord): boolean {
  return left.keyId === right.keyId && left.publicKeySpki === right.publicKeySpki && left.keyEpoch === right.keyEpoch;
}

function reconcileReceiptVerifierEnvironment(): void {
  const verifierSet = run("node", ["scripts/shared/deployment-manifest.mjs", "executor-receipt-state"]);
  JSON.parse(verifierSet);
  writeEnvValue(".env.production", "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS", verifierSet);
  writeEnvValue(".env.local", "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS", verifierSet);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the rotation boundary deliberately scans and validates every durable page before allowing history eviction.
function assertNoDurableVerifierReferences(options: Options, verifiers: ReceiptVerifierRecord[]): void {
  if (verifiers.length === 0) return;
  const table = stackOutputs(stack(options)).OperationStateTableName;
  if (typeof table !== "string" || !table) {
    throw new Error("Receipt verifier rotation refused: durable operation-state table is missing");
  }
  let exclusiveStartKey: JsonRecord | undefined;
  do {
    const response = aws(options.region, [
      "dynamodb",
      "scan",
      "--table-name",
      table,
      "--consistent-read",
      "--projection-expression",
      "payload",
      ...(exclusiveStartKey ? ["--exclusive-start-key", JSON.stringify(exclusiveStartKey)] : []),
    ]);
    for (const item of (response.Items ?? []) as JsonRecord[]) {
      const payload = item.payload?.S;
      if (typeof payload !== "string") throw new Error("Receipt verifier rotation refused: malformed operation state");
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new Error("Receipt verifier rotation refused: malformed operation state");
      }
      const referenced = verifiers.find((verifier) =>
        hasUnresolvedExecutorReceiptVerifierReference(parsed, verifier.keyId, verifier.keyEpoch)
      );
      if (referenced) {
        throw new Error(
          `Receipt verifier rotation refused: unresolved durable receipt reference for ${referenced.keyId} epoch ${referenced.keyEpoch}`
        );
      }
    }
    exclusiveStartKey = response.LastEvaluatedKey as JsonRecord | undefined;
  } while (exclusiveStartKey && Object.keys(exclusiveStartKey).length > 0);

  if (!options.confirmInstanceId) {
    throw new Error("Receipt verifier rotation refused: exact host identity is missing");
  }
  for (const verifier of verifiers) {
    const output = ssmCommand(options.region, options.confirmInstanceId, [
      "set -euo pipefail",
      `sudo /usr/local/bin/mc-host-operation.py executor-receipt-references --key-id ${shellQuote(verifier.keyId)} --key-epoch ${verifier.keyEpoch}`,
    ]);
    let scan: JsonRecord;
    try {
      scan = JSON.parse(output) as JsonRecord;
    } catch {
      throw new Error("Receipt verifier rotation refused: host durable-reference scan was malformed");
    }
    if (!Array.isArray(scan.references) || scan.references.length > 0) {
      throw new Error(
        `Receipt verifier rotation refused: host journal or gateway handoff still requires ${verifier.keyId} epoch ${verifier.keyEpoch}`
      );
    }
  }
}

function pinReceiptVerifier(options: Options, verifier: JsonRecord): "unchanged" | "rotated" {
  const discovered = verifierIdentity(verifier);
  const prior = localReceiptVerifiers();
  const priorCurrent = prior[0];
  if (priorCurrent && sameVerifierIdentity(priorCurrent, discovered)) {
    reconcileReceiptVerifierEnvironment();
    return "unchanged";
  }
  if (priorCurrent && !options.receiptRotationCutoffAt) {
    throw new Error("Rotating an executor receipt key requires --receipt-rotation-cutoff-at");
  }
  const rotating = Boolean(priorCurrent);
  // A service stop does not prove that a durable handoff is gone. Before
  // retiring the old current verifier (or evicting any older history), prove
  // that no durable operation still carries its exact fence identity.
  assertNoDurableVerifierReferences(options, prior);
  run("node", [
    "scripts/shared/deployment-manifest.mjs",
    "executor-receipt",
    "--key-id",
    discovered.keyId,
    "--public-key-spki",
    discovered.publicKeySpki,
    "--key-epoch",
    String(discovered.keyEpoch),
    ...(rotating ? ["--rotation-cutoff-at", options.receiptRotationCutoffAt as string] : []),
  ]);
  reconcileReceiptVerifierEnvironment();
  return "rotated";
}

async function pinDiscoveredRuntimeReceipt(
  options: Options,
  state: RuntimeRolloutReconciliation
): Promise<RuntimeRolloutReconciliation> {
  if (!new Set(["verifier-discovered", "verifier-pinned", "host-released"]).has(state.phase) || !state.verifier) {
    throw new Error("No host-independent pinned receipt-verifier reconciliation is pending");
  }
  assertRuntimeReconciliationBinding(options, state);
  if (state.phase !== "host-released") await assertLifecycleFenceOwned(state.fence);
  pinReceiptVerifier(options, state.verifier);
  if (state.phase === "verifier-discovered") {
    const pinned: RuntimeRolloutReconciliation = { ...state, phase: "verifier-pinned" };
    writeRuntimeReconciliation(pinned);
    return pinned;
  }
  return state;
}

async function reconcileRuntimeReceipt(options: Options): Promise<void> {
  const state = readRuntimeReconciliation();
  if (!state) throw new Error("No runtime receipt reconciliation state exists");
  if (
    options.confirmStackId !== state.stackId ||
    options.confirmInstanceId !== state.instanceId ||
    options.confirmPins !== state.pinsSha256
  ) {
    throw new Error(
      "Runtime receipt reconciliation requires the exact persisted stack, instance, and pins confirmations"
    );
  }
  await pinDiscoveredRuntimeReceipt(options, state);
  console.log("Reconciled the durably pinned receipt verifier; host and lifecycle maintenance ownership remain held.");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Crash reconciliation, protected-lock promotion, rollout, and verifier publication form one ordered transaction.
async function rolloutRuntime(options: Options, identity: HostIdentity): Promise<void> {
  assertBasicConfirmation(options, identity);
  if (options.confirmPins !== PINS_SHA256) throw new Error(`Pass --confirm-pins ${PINS_SHA256}`);
  assertInitiallyRunningHost(identity);
  let reconciliation = readRuntimeReconciliation(identity);
  if (reconciliation) assertRuntimeReconciliationBinding(options, reconciliation);
  if (
    reconciliation?.phase === "verifier-discovered" ||
    reconciliation?.phase === "verifier-pinned" ||
    reconciliation?.phase === "host-released"
  ) {
    reconciliation = await pinDiscoveredRuntimeReceipt(options, reconciliation);
    if (reconciliation.phase !== "host-released") {
      await assertLifecycleFenceOwned(reconciliation.fence);
      ssmCommand(
        options.region,
        identity.instanceId,
        hostMaintenanceReleaseCommands(
          reconciliation.fence.lockId,
          "runtime-rollout",
          reconciliation.receiptVerifierRotated !== true
        )
      );
      reconciliation = { ...reconciliation, phase: "host-released" };
      writeRuntimeReconciliation(reconciliation);
    }
    await assertLifecycleFenceOwned(reconciliation.fence);
    await releaseLifecycleFence(reconciliation.fence);
    clearRuntimeReconciliation();
    console.log("Reconciled the pinned receipt verifier and exact retained host/lifecycle maintenance ownership.");
    return;
  }
  if (reconciliation?.phase === "promoting") {
    try {
      const current = await assertServerActionLockOwned(
        reconciliation.fence.lockId,
        reconciliation.fence.fencingToken,
        reconciliation.fence.action,
        { ownerEmail: reconciliation.fence.ownerEmail }
      );
      if (current.agentFenceActive === true && current.leaseGeneration === reconciliation.fence.leaseGeneration + 1) {
        fenceIdentity(current);
        reconciliation = { ...reconciliation, phase: "mutating", fence: fenceIdentity(current) };
        writeRuntimeReconciliation(reconciliation);
      } else {
        await releaseLifecycleFence(reconciliation.fence);
        clearRuntimeReconciliation();
        reconciliation = null;
      }
    } catch (error) {
      if (!isServerActionLockConflictError(error)) throw error;
      clearRuntimeReconciliation();
      reconciliation = null;
    }
  }
  let fence = reconciliation?.fence ?? (await acquireLifecycleFence());
  if (!reconciliation) {
    writeRuntimeReconciliation({
      ...runtimeReconciliationBinding(options),
      schemaVersion: 1,
      stackId: identity.stackId,
      instanceId: identity.instanceId,
      pinsSha256: PINS_SHA256,
      phase: "promoting",
      fence,
    });
  }
  const renewed = await renewServerActionLock(fence.lockId, fence.fencingToken, {
    expectedLeaseGeneration: fence.leaseGeneration,
    retainForAgentEffect: true,
  });
  fence = fenceIdentity(renewed);
  writeRuntimeReconciliation({
    ...runtimeReconciliationBinding(options),
    schemaVersion: 1,
    stackId: identity.stackId,
    instanceId: identity.instanceId,
    pinsSha256: PINS_SHA256,
    phase: "mutating",
    fence,
  });
  let hostMutationStarted = false;
  try {
    await assertLifecycleFenceOwned(fence);
    const priorReceiptVerifiers = localReceiptVerifiers();
    // An explicit cutoff declares a rotation attempt. Inspect durable state
    // before the host transaction, not merely after a service-stop signal.
    if (options.receiptRotationCutoffAt && priorReceiptVerifiers.length > 0) {
      assertNoDurableVerifierReferences(options, priorReceiptVerifiers);
    }
    const release = reviewedHostRelease(options);
    await assertLifecycleFenceOwned(fence);
    hostMutationStarted = true;
    const output = ssmCommand(
      options.region,
      identity.instanceId,
      rolloutHostCommands(options, release, false, fence.lockId)
    );
    if (output.split("\n").includes("MC_RELEASE_RECOVERY=rolled-back")) {
      throw new Error(
        "The unresolved prior host release was exactly rolled back. Host and lifecycle maintenance remain held; rerun the reviewed rollout command."
      );
    }
    assertSafeToReleaseRuntimeRollout({
      rolloutSucceeded: true,
      transferSucceeded: true,
      helperHashesMatch: true,
      dependencyVersionsMatch: true,
      installedRuntimeMatches: true,
      installedManifestMatches: true,
    });
    await assertLifecycleFenceOwned(fence);
    const verifier = receiptVerifierFrom(output);
    const receiptVerifierRotated = receiptVerifierWouldRotate(verifier);
    writeRuntimeReconciliation({
      ...runtimeReconciliationBinding(options),
      schemaVersion: 1,
      stackId: identity.stackId,
      instanceId: identity.instanceId,
      pinsSha256: PINS_SHA256,
      phase: "verifier-discovered",
      fence,
      verifier,
      receiptVerifierRotated,
    });
    const verifierState = pinReceiptVerifier(options, verifier);
    writeRuntimeReconciliation({
      ...runtimeReconciliationBinding(options),
      schemaVersion: 1,
      stackId: identity.stackId,
      instanceId: identity.instanceId,
      pinsSha256: PINS_SHA256,
      phase: "verifier-pinned",
      fence,
      verifier,
      receiptVerifierRotated,
    });
    await assertLifecycleFenceOwned(fence);
    ssmCommand(
      options.region,
      identity.instanceId,
      hostMaintenanceReleaseCommands(fence.lockId, "runtime-rollout", !receiptVerifierRotated)
    );
    writeRuntimeReconciliation({
      ...runtimeReconciliationBinding(options),
      schemaVersion: 1,
      stackId: identity.stackId,
      instanceId: identity.instanceId,
      pinsSha256: PINS_SHA256,
      phase: "host-released",
      fence,
      verifier,
      receiptVerifierRotated,
    });
    await assertLifecycleFenceOwned(fence);
    await releaseLifecycleFence(fence);
    clearRuntimeReconciliation();
    console.log(output);
    console.log(
      verifierState === "unchanged"
        ? "Executor receipt verifier authority is unchanged; the exact lifecycle fence was released after verification."
        : "Executor receipt verifier authority was rotated and pinned locally; deploy the reviewed Worker environment before agent use."
    );
  } catch (error) {
    // Before the host transaction there is no rollback obligation. Once SSM
    // has been invoked, retain the exact fence for operator recovery.
    if (!hostMutationStarted) {
      try {
        await releaseLifecycleFence(fence);
        clearRuntimeReconciliation();
      } catch {
        console.error(
          "Runtime rollout did not mutate the host, but lifecycle release is unresolved; reconciliation state was retained."
        );
      }
    }
    throw error;
  }
}

function plan(options: Options, found: JsonRecord, identity: HostIdentity): void {
  const live = liveTemplate(options, found);
  const liveInstance = live.Resources?.[INSTANCE_LOGICAL_ID];
  if (!liveInstance) throw new Error(`Live template has no ${INSTANCE_LOGICAL_ID}`);
  console.log(`Stack: ${identity.stackId}`);
  console.log(`Instance/root: ${identity.instanceId} / ${identity.rootVolumeId}`);
  console.log(`Initial EC2 state: ${identity.initialInstanceState}`);
  console.log(`AMI: ${identity.currentAmiId} -> ${identity.targetAmiId}`);
  console.log(`Bootstrap pins: ${PINS_SHA256}`);
  if (identity.currentAmiId === identity.targetAmiId) {
    console.log("AMI is unchanged. Use rollout-runtime for artifact-only changes.");
    console.log("If launch-time UserData changed, use the backup-guarded replacement stages instead.");
  } else {
    console.log("AMI differs: CloudFormation replacement is required; UserData will run only on the new instance.");
    console.log("Next: prepare-replacement with exact StackId and instance confirmations shown above.");
  }
  console.log("No AWS resource was changed.");
}

async function waitInstanceWithFence(
  region: string,
  instanceId: string,
  expected: "running" | "stopped",
  heartbeat: ReplacementFenceHeartbeat
): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await heartbeat.assertHealthy();
    if (instanceState(region, instanceId) === expected) return;
    await delay(10_000, heartbeat.signal);
  }
  throw new Error(`Instance ${instanceId} did not become ${expected} while the lifecycle fence was renewable`);
}

async function waitSnapshotWithFence(
  region: string,
  snapshotId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<JsonRecord> {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    await heartbeat.assertHealthy();
    const snapshot = aws(region, ["ec2", "describe-snapshots", "--snapshot-ids", snapshotId]).Snapshots?.[0];
    if (snapshot?.State === "completed") return snapshot;
    if (snapshot?.State === "error") throw new Error(`Snapshot ${snapshotId} entered an error state`);
    await delay(10_000, heartbeat.signal);
  }
  throw new Error(`Snapshot ${snapshotId} did not complete while the lifecycle fence was renewable`);
}

async function waitReviewedChangeSetExecutionWithFence(
  options: Options,
  changeSetId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<{ outcome: "updated" | "rolled-back"; stack: JsonRecord; changeSet: JsonRecord }> {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    await heartbeat.assertHealthy();
    const changeSet = aws(options.region, [
      "cloudformation",
      "describe-change-set",
      "--stack-name",
      heartbeat.context.operation.stackId,
      "--change-set-name",
      changeSetId,
    ]);
    const execution = classifyReviewedChangeSetExecution(changeSet, changeSetId);
    if (execution === "complete") {
      const current = describeStack(options);
      if (current.StackId !== changeSet.StackId) {
        throw new Error("Reviewed replacement execution completed on a different stack identity");
      }
      if (current.StackStatus === "UPDATE_COMPLETE") {
        assertReviewedStackExecutionEvent(options, heartbeat.context.operation, "UPDATE_COMPLETE");
        return { outcome: "updated", stack: current, changeSet };
      }
      if (current.StackStatus === "UPDATE_ROLLBACK_COMPLETE") {
        assertReviewedStackExecutionEvent(options, heartbeat.context.operation, "UPDATE_ROLLBACK_COMPLETE");
        return { outcome: "rolled-back", stack: current, changeSet };
      }
    }
    await delay(10_000, heartbeat.signal);
  }
  throw new Error("Reviewed replacement change set did not complete while the lifecycle fence was renewable");
}

function assertReviewedStackExecutionEvent(
  options: Options,
  operation: ReplacementLifecycleOperation,
  expectedStatus: "UPDATE_COMPLETE" | "UPDATE_ROLLBACK_COMPLETE"
): void {
  if (!operation.executionClientToken) throw new Error("Reviewed replacement has no execution client token");
  const events = aws(options.region, [
    "cloudformation",
    "describe-stack-events",
    "--stack-name",
    operation.stackId,
  ]).StackEvents;
  const latestStable = events?.find(
    (event: JsonRecord) =>
      event.StackId === operation.stackId &&
      event.ResourceType === "AWS::CloudFormation::Stack" &&
      new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]).has(event.ResourceStatus)
  );
  if (
    latestStable?.ResourceStatus !== expectedStatus ||
    latestStable?.ClientRequestToken !== operation.executionClientToken
  ) {
    throw new Error(
      `Stable stack status is not causally bound to the reviewed ${operation.executionClientToken} execution`
    );
  }
}

async function waitSsmOnline(
  options: Options,
  instanceId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await heartbeat.assertHealthy();
    const response = aws(options.region, [
      "ssm",
      "describe-instance-information",
      "--filters",
      `Key=InstanceIds,Values=${instanceId}`,
    ]);
    if (
      response.InstanceInformationList?.some(
        (item: JsonRecord) => item.InstanceId === instanceId && item.PingStatus === "Online"
      )
    ) {
      return;
    }
    await delay(5_000, heartbeat.signal);
  }
  throw new Error(`Instance ${instanceId} did not become SSM-online`);
}

function readReviewedChangeSetExecution(options: Options, state: UpgradeState): JsonRecord {
  if (!state.changeSetId) throw new Error("Replacement recovery has no immutable reviewed change-set ARN");
  const changeSet = aws(options.region, [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    state.identity.stackId,
    "--change-set-name",
    state.changeSetId,
  ]);
  classifyReviewedChangeSetExecution(changeSet, state.changeSetId);
  return changeSet;
}

function readTerminalReplacementBackupProof(
  output: string,
  instanceId: string,
  backupName: string,
  expectedOperationKey: string,
  expectedRootVolumeId: string
): NonNullable<UpgradeState["backupProof"]> {
  const manifestLine = output
    .split("\n")
    .find((line) => line.startsWith("MC_BACKUP_MANIFEST_RESULT "))
    ?.slice("MC_BACKUP_MANIFEST_RESULT ".length);
  const quiescenceLine = output
    .split("\n")
    .find((line) => line.startsWith("MC_BACKUP_QUIESCENCE_RESULT "))
    ?.slice("MC_BACKUP_QUIESCENCE_RESULT ".length);
  if (!manifestLine || !quiescenceLine) throw new Error("Replacement terminal backup evidence is incomplete");
  const item = JSON.parse(manifestLine);
  const quiescence = JSON.parse(quiescenceLine);
  const proof: NonNullable<UpgradeState["backupProof"]> = {
    name: String(item?.archiveName ?? ""),
    size: Number(item?.archiveSize),
    modifiedAt: String(item?.createdAt ?? ""),
    backupId: String(item?.backupId ?? ""),
    generation: Number(item?.generation),
    sourceInstanceId: String(item?.instanceId ?? ""),
    operationKey: String(item?.operationKey ?? ""),
    rootVolumeId: String(quiescence?.rootVolumeId ?? ""),
    bootId: String(quiescence?.bootId ?? ""),
    maintenanceOwner: String(quiescence?.maintenanceOwner ?? ""),
    quiescenceEpoch: String(quiescence?.quiescenceEpoch ?? ""),
    terminalMode: String(quiescence?.mode ?? "") as "terminal-replacement",
  };
  assertApplicationBackupProof(backupName, proof);
  if (
    !/^[a-f0-9]{32}$/.test(proof.backupId) ||
    !Number.isSafeInteger(proof.generation) ||
    proof.generation < 1 ||
    !/^i-[a-f0-9]{8,17}$/.test(proof.sourceInstanceId) ||
    proof.sourceInstanceId !== instanceId ||
    proof.operationKey !== expectedOperationKey ||
    proof.rootVolumeId !== expectedRootVolumeId ||
    !proof.bootId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proof.maintenanceOwner) ||
    !/^[a-f0-9]{32}$/.test(proof.quiescenceEpoch) ||
    proof.terminalMode !== "terminal-replacement" ||
    quiescence?.schemaVersion !== 2 ||
    quiescence?.maintenanceFence !== "held" ||
    quiescence?.services !== "stopped-and-masked" ||
    quiescence?.minecraft !== "inactive" ||
    quiescence?.protocol !== "closed"
  ) {
    throw new Error("Replacement terminal backup evidence is malformed or belongs to another preservation operation");
  }
  return proof;
}

function replacementBackupOperationKey(operationId: string): string {
  return createHash("sha256").update(`${operationId}\0replacement-backup`).digest("hex");
}

async function readRemoteRestoreFloor(
  region: string,
  instanceId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<{ generation: number; backupId: string }> {
  const output = await ssmCommandWithFence(
    region,
    instanceId,
    ["sudo /usr/local/bin/mc-backup-auth.py floor-read --state-file /var/lib/mc-aws/restore-generation-floor.json"],
    heartbeat
  );
  const [generationText, backupId = ""] = output.split("\n").slice(-1)[0].split("\t");
  const generation = Number(generationText);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    (generation === 0 ? backupId !== "" : !/^[a-f0-9]{32}$/.test(backupId))
  ) {
    throw new Error("Remote restore floor is malformed");
  }
  return { generation, backupId };
}

async function provisionReplacementTransferOffer(
  region: string,
  instanceId: string,
  proof: NonNullable<UpgradeState["backupProof"]>,
  floor: { generation: number; backupId: string },
  operationId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<string> {
  const current = await heartbeat.checkpoint();
  const fence = current.fence;
  const issuedAt = new Date();
  const expiresAt = new Date(current.operation.lockLeaseExpiresAt ?? "");
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt) {
    throw new Error("Replacement transfer offer cannot outlive an unproven lifecycle lease");
  }
  const output = await ssmCommandWithFence(
    region,
    instanceId,
    [
      `sudo /usr/local/bin/mc-backup-auth.py transfer-create --operation-id ${shellQuote(operationId)} --archive-name ${shellQuote(proof.name)} --backup-id ${proof.backupId} --generation ${proof.generation} --floor-generation ${floor.generation} --floor-backup-id ${shellQuote(floor.backupId)} --lock-id ${shellQuote(fence.lockId)} --fencing-token ${fence.fencingToken} --lease-generation ${fence.leaseGeneration} --issued-at ${shellQuote(issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z"))} --expires-at ${shellQuote(expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"))}`,
    ],
    heartbeat,
    false
  );
  const offer = output.split("\n").slice(-1)[0];
  if (!offer || !offer.startsWith("{"))
    throw new Error("Source host did not return a signed replacement transfer offer");
  JSON.parse(offer);
  return offer;
}

async function provisionReplacementTransferAuthorization(
  region: string,
  authorization: string,
  operationId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<void> {
  await heartbeat.assertHealthy();
  let existing: JsonRecord | undefined;
  try {
    existing = aws(region, ["ssm", "get-parameter", "--name", "/minecraft/backup-transfer-authorization"]);
  } catch (error) {
    if (!(error instanceof CommandFailure) || !/ParameterNotFound/.test(error.output)) throw error;
  }
  const existingValue = existing?.Parameter?.Value;
  if (typeof existingValue === "string" && existingValue !== "UNINITIALIZED" && existingValue !== authorization) {
    let existingAuthorization: JsonRecord;
    let nextAuthorization: JsonRecord;
    try {
      existingAuthorization = JSON.parse(existingValue);
      nextAuthorization = JSON.parse(authorization);
    } catch {
      throw new Error("A malformed one-time replacement transfer authorization is already pending");
    }
    if (
      existingAuthorization.operationId !== operationId ||
      existingAuthorization.offer?.operationId !== operationId ||
      existingAuthorization.target?.accountId !== nextAuthorization.target?.accountId ||
      existingAuthorization.target?.instanceId !== nextAuthorization.target?.instanceId ||
      existingAuthorization.offer?.source?.instanceId !== nextAuthorization.offer?.source?.instanceId ||
      existingAuthorization.offer?.backup?.archiveName !== nextAuthorization.offer?.backup?.archiveName ||
      existingAuthorization.offer?.backup?.backupId !== nextAuthorization.offer?.backup?.backupId ||
      existingAuthorization.offer?.backup?.generation !== nextAuthorization.offer?.backup?.generation
    ) {
      throw new Error("A different replacement transfer authorization is already pending");
    }
  }
  aws(region, [
    "ssm",
    "put-parameter",
    "--name",
    "/minecraft/backup-transfer-authorization",
    "--type",
    "String",
    "--overwrite",
    "--value",
    authorization,
  ]);
  await heartbeat.assertHealthy();
}

async function refreshReplacementTransferAuthorization(
  options: Options,
  state: UpgradeState,
  targetInstanceId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<void> {
  if (!state.transferOffer || !state.backupProof || !state.replacementOperation) {
    throw new Error("Replacement transfer offer, operation, or exact backup proof is missing");
  }
  const offer = JSON.parse(state.transferOffer) as JsonRecord;
  const floor = offer.restoreFloor as JsonRecord;
  if (
    !floor ||
    !Number.isSafeInteger(floor.generation) ||
    typeof floor.backupId !== "string" ||
    offer.operationId !== state.replacementOperation.operationId
  ) {
    throw new Error("Replacement transfer offer lineage is malformed");
  }
  const current = await heartbeat.checkpoint();
  const renewalAuthorization = bindReplacementTransferAuthorization(state.transferOffer, targetInstanceId, {
    operationId: current.operation.operationId,
    archiveName: state.backupProof.name,
    backupId: state.backupProof.backupId,
    generation: state.backupProof.generation,
    sourceInstanceId: state.backupProof.sourceInstanceId,
    lockId: current.fence.lockId,
    fencingToken: current.fence.fencingToken,
    leaseGeneration: current.fence.leaseGeneration,
  });
  await provisionReplacementTransferAuthorization(
    options.region,
    renewalAuthorization,
    current.operation.operationId,
    heartbeat
  );
  const issuedAt = new Date();
  const expiresAt = new Date(current.operation.lockLeaseExpiresAt ?? "");
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt) {
    throw new Error("Replacement transfer renewal cannot outlive an unproven lifecycle lease");
  }
  const renewedOffer = await ssmCommandWithFence(
    options.region,
    targetInstanceId,
    [
      `sudo /usr/local/bin/mc-backup-auth.py transfer-renew --authorization-parameter /minecraft/backup-transfer-authorization --operation-id ${shellQuote(current.operation.operationId)} --archive-name ${shellQuote(state.backupProof.name)} --backup-id ${state.backupProof.backupId} --generation ${state.backupProof.generation} --floor-generation ${floor.generation} --floor-backup-id ${shellQuote(floor.backupId)} --lock-id ${shellQuote(current.fence.lockId)} --fencing-token ${current.fence.fencingToken} --lease-generation ${current.fence.leaseGeneration} --issued-at ${shellQuote(issuedAt.toISOString().replace(/\.\d{3}Z$/, "Z"))} --expires-at ${shellQuote(expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"))}`,
    ],
    heartbeat,
    false
  );
  state.transferOffer = renewedOffer.split("\n").slice(-1)[0];
  writeState(state);
  const rebound = await heartbeat.checkpoint();
  const authorization = bindReplacementTransferAuthorization(state.transferOffer, targetInstanceId, {
    operationId: rebound.operation.operationId,
    archiveName: state.backupProof.name,
    backupId: state.backupProof.backupId,
    generation: state.backupProof.generation,
    sourceInstanceId: state.backupProof.sourceInstanceId,
    lockId: rebound.fence.lockId,
    fencingToken: rebound.fence.fencingToken,
    leaseGeneration: rebound.fence.leaseGeneration,
  });
  await provisionReplacementTransferAuthorization(
    options.region,
    authorization,
    rebound.operation.operationId,
    heartbeat
  );
  state.transferAuthorizationFence = rebound.fence;
  writeState(state);
}

const PREPARATION_PHASES = [
  "preparing",
  "backup-requested",
  "backup-verified",
  "quiesce-requested",
  "quiesced",
  "stop-requested",
  "old-host-safe",
  "snapshot-requested",
  "snapshot-complete",
  "change-set-requested",
  "prepared",
] as const;

function preparationReached(
  operation: ReplacementLifecycleOperation,
  phase: (typeof PREPARATION_PHASES)[number]
): boolean {
  return (
    PREPARATION_PHASES.indexOf(operation.phase as (typeof PREPARATION_PHASES)[number]) >=
    PREPARATION_PHASES.indexOf(phase)
  );
}

function hydratePreparationState(state: UpgradeState, operation: ReplacementLifecycleOperation): void {
  if (operation.backupName && operation.backupName !== state.backupName) {
    throw new Error("Replacement preparation backup identity changed");
  }
  if (
    state.backupProof &&
    operation.backupProof &&
    JSON.stringify(state.backupProof) !== JSON.stringify(operation.backupProof)
  ) {
    throw new Error("Replacement preparation terminal backup proof changed");
  }
  state.backupProof ??= operation.backupProof;
  if (
    state.restoreFloor &&
    operation.restoreFloor &&
    JSON.stringify(state.restoreFloor) !== JSON.stringify(operation.restoreFloor)
  ) {
    throw new Error("Replacement preparation restore-floor proof changed");
  }
  state.restoreFloor ??= operation.restoreFloor;
  state.snapshotId ??= operation.snapshotId;
  state.changeSetId ??= operation.changeSetId;
  state.changeKind = operation.changeKind ?? state.changeKind;
}

async function describePreparedChangeSet(
  options: Options,
  stackId: string,
  changeSetName: string
): Promise<JsonRecord | undefined> {
  try {
    return aws(options.region, [
      "cloudformation",
      "describe-change-set",
      "--stack-name",
      stackId,
      "--change-set-name",
      changeSetName,
      "--include-property-values",
    ]);
  } catch (error) {
    if (error instanceof CommandFailure && /ChangeSetNotFound|does not exist/i.test(error.output)) return undefined;
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preparation deliberately keeps every durable crash checkpoint adjacent to its guarded host/cloud effect.
async function prepareReplacement(
  options: Options,
  found: JsonRecord,
  identity: HostIdentity,
  existingState?: UpgradeState
): Promise<void> {
  assertBasicConfirmation(options, identity);
  assertInitiallyRunningHost(identity);
  const backupName =
    existingState?.backupName ??
    `host-upgrade-${new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14)}.tar.gz`;
  const backupBase = backupName.replace(/\.tar\.gz$/, "");
  const state: UpgradeState =
    existingState ??
    (() => {
      const operation = initializeReplacementLifecycleOperation(identity, undefined, undefined, backupName);
      const initialized: UpgradeState = {
        schemaVersion: 1,
        status: "preparing",
        changeKind: identity.currentAmiId === identity.targetAmiId ? "in-place" : "replacement",
        identity,
        backupName,
        replacementOperation: operation,
      };
      writeState(initialized);
      return initialized;
    })();
  const persistedOperation = state.replacementOperation as ReplacementLifecycleOperation;
  let initialOperation = await readReplacementLifecycleOperation(persistedOperation.operationId);
  if (!initialOperation) {
    if (
      persistedOperation.version !== 1 ||
      persistedOperation.phase !== "preparing" ||
      persistedOperation.lockId !== undefined
    ) {
      throw new Error("Replacement durable operation disappeared after its initial preparing checkpoint");
    }
    initialOperation = await createReplacementLifecycleOperation(
      identity,
      persistedOperation.operationId,
      persistedOperation.operationOwnerId,
      backupName,
      persistedOperation.updatedAt
    );
  }
  if (!initialOperation) throw new Error("Replacement durable operation state is unavailable");
  hydratePreparationState(state, initialOperation);
  writeState(state);
  const claimed = initialOperation.lockId
    ? await reconcileReplacementFence(options, state)
    : await claimReplacementLifecycleFence(initialOperation);
  persistReplacementContext(state, claimed);
  const heartbeat = replacementHeartbeat(state, claimed);
  const backupOperationKey = replacementBackupOperationKey(heartbeat.context.operation.operationId);
  try {
    if (
      heartbeat.context.operation.oldHostSafetyInvalidatedAt ||
      heartbeat.context.operation.oldHostSafetyCheckPending === true
    ) {
      await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
      throw new Error("Replacement preparation cannot reuse backup evidence after old-host safety was invalidated");
    }
    if (!heartbeat.context.operation.restoreFloor) {
      const restoreFloor = await readRemoteRestoreFloor(options.region, identity.instanceId, heartbeat);
      state.restoreFloor = restoreFloor;
      writeState(state);
      await heartbeat.checkpoint({ restoreFloor });
    }
    const restoreFloor = state.restoreFloor ?? heartbeat.context.operation.restoreFloor;
    if (!restoreFloor) throw new Error("Replacement preparation has no durable restore-floor proof");
    if (!preparationReached(heartbeat.context.operation, "backup-requested")) {
      await heartbeat.checkpoint({
        phase: "backup-requested",
        backupName,
        backupRequestedAt: new Date().toISOString(),
        quiesceRequestedAt: new Date().toISOString(),
      });
    }
    if (!preparationReached(heartbeat.context.operation, "backup-verified")) {
      const backupOutput = await ssmCommandWithFence(
        options.region,
        identity.instanceId,
        [
          `sudo env MC_REMOTE_OPERATION_KEY=${backupOperationKey} MC_ROOT_VOLUME_ID=${identity.rootVolumeId} /usr/local/bin/mc-backup.sh --replacement '${backupBase}'`,
        ],
        heartbeat
      );
      const backupProof = readTerminalReplacementBackupProof(
        backupOutput,
        identity.instanceId,
        backupName,
        backupOperationKey,
        identity.rootVolumeId
      );
      state.backupProof = backupProof;
      writeState(state);
      await heartbeat.checkpoint({ phase: "backup-verified", backupProof });
    }
    const backupProof = state.backupProof ?? heartbeat.context.operation.backupProof;
    if (!backupProof) throw new Error("Replacement preparation has no authenticated backup proof");
    state.backupProof = backupProof;
    if (state.changeKind === "replacement" && !state.transferOffer) {
      state.transferOffer = await provisionReplacementTransferOffer(
        options.region,
        identity.instanceId,
        backupProof,
        restoreFloor,
        heartbeat.context.operation.operationId,
        heartbeat
      );
      writeState(state);
    }
    if (!preparationReached(heartbeat.context.operation, "quiesce-requested")) {
      await heartbeat.checkpoint({ phase: "quiesce-requested", quiesceRequestedAt: new Date().toISOString() });
    }
    if (!preparationReached(heartbeat.context.operation, "quiesced")) {
      if (
        backupProof.operationKey !== backupOperationKey ||
        backupProof.rootVolumeId !== identity.rootVolumeId ||
        backupProof.terminalMode !== "terminal-replacement"
      ) {
        throw new Error("Replacement backup did not preserve terminal old-host quiescence");
      }
      await heartbeat.checkpoint({ phase: "quiesced", oldHostAgentDrained: true, oldHostMasked: true });
    }
    if (!preparationReached(heartbeat.context.operation, "stop-requested")) {
      await heartbeat.checkpoint({ phase: "stop-requested", stopRequestedAt: new Date().toISOString() });
    }
    if (!preparationReached(heartbeat.context.operation, "old-host-safe")) {
      const disposition = oldHostDisposition(options.region, identity.instanceId);
      if (disposition === "running") {
        aws(options.region, ["ec2", "stop-instances", "--instance-ids", identity.instanceId]);
        await waitInstanceWithFence(options.region, identity.instanceId, "stopped", heartbeat);
      } else if (!new Set(["stopping", "stopped", "terminated", "absent"]).has(disposition)) {
        throw new Error(`Old host entered unsafe state ${disposition} after durable stop intent`);
      } else if (disposition === "stopping") {
        await waitInstanceWithFence(options.region, identity.instanceId, "stopped", heartbeat);
      }
      const safeDisposition = oldHostDisposition(options.region, identity.instanceId);
      if (!new Set(["stopped", "terminated", "absent"]).has(safeDisposition)) {
        throw new Error("Old host did not reach a safe disposition after durable stop intent");
      }
      await heartbeat.checkpoint({
        phase: "old-host-safe",
        oldHostStopped: true,
        oldHostDisposition: safeDisposition as "stopped" | "terminated" | "absent",
      });
    }
    if (preparationReached(heartbeat.context.operation, "old-host-safe")) {
      await heartbeat.checkpoint({ oldHostSafetyCheckPending: true });
      const confirmedDisposition = oldHostDisposition(options.region, identity.instanceId);
      if (confirmedDisposition === "running" || confirmedDisposition === "pending") {
        await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
        throw new Error("Old host became active after its safety checkpoint; fresh backup preparation is required");
      }
      if (confirmedDisposition === "stopping") {
        await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
        throw new Error("Old host stop activity after its safety checkpoint invalidated backup evidence");
      }
      if (!new Set(["stopped", "terminated", "absent"]).has(confirmedDisposition)) {
        throw new Error("Old host safety changed before snapshot preparation; retaining the replacement fence");
      }
      await heartbeat.checkpoint({
        oldHostStopped: true,
        oldHostDisposition: confirmedDisposition as "stopped" | "terminated" | "absent",
        oldHostSafetyCheckPending: false,
      });
    }
    const snapshotRequestToken =
      heartbeat.context.operation.snapshotRequestToken ?? `replacement-${heartbeat.context.operation.operationId}`;
    if (!preparationReached(heartbeat.context.operation, "snapshot-requested")) {
      await heartbeat.checkpoint({ phase: "snapshot-requested", snapshotRequestToken });
    }
    let snapshotId = state.snapshotId ?? heartbeat.context.operation.snapshotId;
    if (!snapshotId) {
      const created = aws(options.region, [
        "ec2",
        "create-snapshot",
        "--client-token",
        snapshotRequestToken,
        "--volume-id",
        identity.rootVolumeId,
        "--description",
        `mc-aws reviewed host upgrade ${identity.stackId}`,
        "--tag-specifications",
        `ResourceType=snapshot,Tags=[{Key=McAwsProject,Value=mc-aws},{Key=McAwsStack,Value=${options.stackName}},{Key=McAwsPurpose,Value=HostUpgradeRollback}]`,
      ]);
      snapshotId = created.SnapshotId;
    }
    if (typeof snapshotId !== "string") throw new Error("EC2 did not return a replacement snapshot ID");
    state.snapshotId = snapshotId;
    writeState(state);
    const snapshot = await waitSnapshotWithFence(options.region, snapshotId, heartbeat);
    assertCompletedRootSnapshot(identity, snapshot);
    if (!preparationReached(heartbeat.context.operation, "snapshot-complete")) {
      await heartbeat.checkpoint({ phase: "snapshot-complete", snapshotId });
    }

    const changeSetName =
      heartbeat.context.operation.changeSetName ?? `mc-aws-host-replacement-${heartbeat.context.operation.operationId}`;
    if (!preparationReached(heartbeat.context.operation, "change-set-requested")) {
      await heartbeat.checkpoint({ phase: "change-set-requested", changeSetName });
    }
    let changeSet = await describePreparedChangeSet(options, found.StackId, changeSetName);
    if (!changeSet) {
      await runAsync(
        "pnpm",
        [
          "exec",
          "cdk",
          "deploy",
          "MinecraftStack",
          "--method",
          "prepare-change-set",
          "--change-set-name",
          changeSetName,
          "--require-approval",
          "never",
        ],
        INFRA,
        heartbeat.signal
      );
      await heartbeat.assertHealthy();
      changeSet = await describePreparedChangeSet(options, found.StackId, changeSetName);
    }
    if (!changeSet) throw new Error("Prepared replacement change set is unavailable after idempotent creation");
    const changeKind = assertReviewedInstanceReplacementPlan(identity, changeSet, INSTANCE_LOGICAL_ID);
    const changeSetId = changeSet.ChangeSetId;
    if (typeof changeSetId !== "string") throw new Error("Prepared replacement change set has no immutable ARN");
    if (!preparationReached(heartbeat.context.operation, "prepared")) {
      await heartbeat.checkpoint({ phase: "prepared", changeSetName, changeSetId, changeKind });
    }
    state.status = "prepared";
    state.changeKind = changeKind;
    state.snapshotId = snapshotId;
    state.changeSetId = changeSetId;
    state.backupProof = backupProof;
    writeState(state);
    console.log(`Prepared and validated ${changeKind} host change: ${changeSetId}`);
    console.log(`Completed rollback snapshot (billed until deleted): ${snapshotId}`);
    console.log(`Verified Drive backup: ${backupName}`);
    console.log(`Confirmation: ${replacementConfirmationPhrase(identity, snapshotId)}`);
    console.log(
      "Old host remains drained, masked, and stopped. Run the exact reviewed execute-replacement command; after lease expiry that command performs the documented safe takeover checks."
    );
  } catch (error) {
    if (heartbeat.context.operation.phase === "rolled-back") {
      state.status = "complete";
      writeState(state);
    } else if (!heartbeat.context.operation.quiesceRequestedAt) {
      let terminal = await heartbeat.checkpoint({ status: "failed", phase: "rolled-back" });
      terminal = await heartbeat.stopAfterTerminal();
      state.replacementOperation = await finalizeReplacementLifecycleFence(terminal);
      state.status = "complete";
      writeState(state);
    } else {
      state.status = "preparing";
      writeState(state);
      console.error("Replacement preparation is durably resumable; rerun the exact prepare-replacement command.");
    }
    throw error;
  }
}

function writeEnvValue(file: string, name: string, value: string): void {
  const absolute = path.resolve(file);
  const linkStatus = lstatSync(absolute);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) throw new Error(`${file} must be a regular file`);
  const original = readFileSync(absolute, "utf8");
  const lines = original.split(/\r?\n/);
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:=|:)`);
  let found = false;
  const updated = lines.flatMap((line) => {
    if (!assignment.test(line)) return [line];
    if (found) return [];
    found = true;
    return [`${name}=${value}`];
  });
  if (!found) updated.push(`${name}=${value}`);
  const temporary = `${absolute}.tmp.${process.pid}`;
  writeFileSync(temporary, `${updated.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  const temporaryHandle = openSync(temporary, "r");
  try {
    fsyncSync(temporaryHandle);
  } finally {
    closeSync(temporaryHandle);
  }
  renameSync(temporary, absolute);
  const directoryHandle = openSync(path.dirname(absolute), "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

function persistOutputs(options: Options, state: UpgradeState): JsonRecord {
  const found = stack(options);
  if (found.StackId !== state.identity.stackId)
    throw new Error("Output persistence resolved a different stack identity");
  const outputs = validateRequiredStackOutputs(stackOutputs(found));
  if (managedInstancePhysicalId(options.region, found.StackId) !== outputs.InstanceId) {
    throw new Error("Stack output instance is not the current managed CloudFormation resource");
  }
  const manifestPath = path.resolve(process.env.MC_AWS_DEPLOYMENT_MANIFEST || ".mc-aws-deployment.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
  const stackClaim = manifest.aws?.stack as JsonRecord | undefined;
  const claimToken = typeof stackClaim?.claimToken === "string" ? stackClaim.claimToken : "";
  const observedClaims = (found.Tags ?? []).filter((tag: JsonRecord) => tag.Key === "McAwsClaimToken");
  if (
    !/^[a-f0-9-]{36}$/.test(claimToken) ||
    stackClaim?.id !== found.StackId ||
    observedClaims.length !== 1 ||
    observedClaims[0].Value !== claimToken
  ) {
    throw new Error("CloudFormation did not prove the exact persisted deployment claim");
  }
  for (const [name, value] of Object.entries(envOutputLines(outputs))) {
    writeEnvValue(".env.production", name, value);
    writeEnvValue(".env.local", name, value);
  }
  run("node", [
    "scripts/shared/deployment-manifest.mjs",
    "aws-deployed",
    "--stack-id",
    found.StackId,
    "--instance-id",
    outputs.InstanceId,
    "--runtime-user",
    outputs.WorkerRuntimeIamUserName,
    "--claim-token",
    claimToken,
    "--claim-observed",
    "true",
  ]);
  return found;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Replacement and same-host convergence share one fenced verification boundary.
async function postRestore(
  options: Options,
  state: UpgradeState,
  newInstanceId: string,
  heartbeat: ReplacementFenceHeartbeat
): Promise<void> {
  await waitInstanceWithFence(options.region, newInstanceId, "running", heartbeat);
  await waitSsmOnline(options, newInstanceId, heartbeat);
  await ssmCommandWithFence(
    options.region,
    newInstanceId,
    ["while [[ ! -f /var/lib/mc-aws/bootstrap-complete ]]; do sleep 5; done"],
    heartbeat
  );
  let inheritedReleaseRecovered = false;
  if (heartbeat.context.operation.hostMaintenanceReleaseRequested === true) {
    const ownership = await ssmCommandWithFence(
      options.region,
      newInstanceId,
      [
        "if sudo test ! -e /var/lib/mc-aws/maintenance-boot-hold.json && sudo test ! -e /run/mc-agent/maintenance-state.json; then printf released; else printf held; fi",
      ],
      heartbeat
    );
    inheritedReleaseRecovered = ownership.split("\n").at(-1) === "released";
  }
  const backupBase = state.backupName.replace(/\.tar\.gz$/, "");
  const hostRelease = reviewedHostRelease(options);
  if (state.changeKind === "in-place" && !inheritedReleaseRecovered) {
    const rolloutOutput = await ssmCommandWithFence(
      options.region,
      newInstanceId,
      rolloutHostCommands(options, hostRelease, true),
      heartbeat
    );
    if (rolloutOutput.split("\n").includes("MC_RELEASE_RECOVERY=rolled-back")) {
      throw new Error("The unresolved prior host release was rolled back; rerun to apply the reviewed release");
    }
  } else {
    if (!state.backupProof) throw new Error("Replacement exact backup proof is missing");
    const floor = await readRemoteRestoreFloor(options.region, newInstanceId, heartbeat);
    if (
      floor.generation > state.backupProof.generation ||
      (floor.generation === state.backupProof.generation && floor.backupId !== state.backupProof.backupId)
    ) {
      throw new Error("Replacement restore floor conflicts with the exact requested backup generation");
    }
    if (floor.generation < state.backupProof.generation) {
      await refreshReplacementTransferAuthorization(options, state, newInstanceId, heartbeat);
    }
  }
  const resumeOwner = state.replacementOperation?.operationId;
  const resumeOwnerToken = state.replacementOperation?.operationOwnerId;
  if (!resumeOwner || !resumeOwnerToken) throw new Error("Replacement resume has no exact durable operation owner");
  const restoreCommand =
    state.changeKind === "replacement"
      ? `sudo env MC_RETAIN_OUTER_MAINTENANCE=1 MC_RESUME_OPERATION_ID=${shellQuote(resumeOwner)} MC_RESUME_OPERATION_OWNER_TOKEN=${shellQuote(resumeOwnerToken)} MC_BACKUP_TRANSFER_EXPECTED_OPERATION_ID=${shellQuote(state.replacementOperation?.operationId ?? "")} MC_BACKUP_TRANSFER_EXPECTED_LOCK_ID=${shellQuote(state.transferAuthorizationFence?.lockId ?? "")} MC_BACKUP_TRANSFER_EXPECTED_FENCING_TOKEN=${shellQuote(String(state.transferAuthorizationFence?.fencingToken ?? 0))} MC_BACKUP_TRANSFER_EXPECTED_LEASE_GENERATION=${shellQuote(String(state.transferAuthorizationFence?.leaseGeneration ?? 0))} /usr/local/bin/mc-resume.sh replacement-convergence ${shellQuote(`${backupBase}.tar.gz`)} ${state.backupProof?.generation ?? 0} ${shellQuote(state.backupProof?.backupId ?? "")} `
      : `sudo env MC_RETAIN_OUTER_MAINTENANCE=1 MC_RESUME_OPERATION_ID=${shellQuote(resumeOwner)} MC_RESUME_OPERATION_OWNER_TOKEN=${shellQuote(resumeOwnerToken)} MC_MAINTENANCE_PARENT_OPERATION=host-replacement /usr/local/bin/mc-resume.sh named ${shellQuote(`${backupBase}.tar.gz`)}`;
  const commands = [
    ...(inheritedReleaseRecovered ? [] : [restoreCommand]),
    "sudo /usr/local/bin/mc-wait-ready.sh raw_ip '' ''",
    `grep -Fx 'pins ${PINS_SHA256}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -Fx 'paper ${PINS.artifacts.paper.sha256}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -F 'release-manifest ${hostRelease.build.releaseManifestSha256} ${hostRelease.build.releaseManifestBytes}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -F 'agent-runtime ${hostRelease.build.agentRuntimeSha256} ${hostRelease.build.agentRuntimeBytes}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -F 'agent-runtime-manifest ${hostRelease.build.agentRuntimeManifestSha256} ${hostRelease.build.agentRuntimeManifestBytes}' /var/lib/mc-aws/runtime-hashes.sha256`,
    "printf 'MC_EXECUTOR_RECEIPT_VERIFIER='; sudo cat /etc/mc-agent/executor-receipt-verifier.json",
  ];
  const output = await ssmCommandWithFence(
    options.region,
    newInstanceId,
    commands,
    heartbeat,
    state.changeKind !== "replacement"
  );
  if (!output.includes('"ready":true')) throw new Error("Replacement readiness output was not successful");
  if (heartbeat.context.operation.resumeIntent) {
    transitionResumeIntentPointer(
      options.region,
      heartbeat.context.operation.operationId,
      heartbeat.context.operation.operationOwnerId,
      heartbeat.context.operation.resumeIntent as unknown as JsonRecord,
      "completed"
    );
  }
  const verifier = receiptVerifierFrom(output);
  if (heartbeat.context.operation.receiptVerifierRotated === undefined) {
    await heartbeat.checkpoint({ receiptVerifierRotated: receiptVerifierWouldRotate(verifier) });
  }
  pinReceiptVerifier(options, verifier);
}

function hostMaintenanceReleaseCommands(
  owner: string,
  operation: "restore" | "host-replacement" | "runtime-rollout",
  activateAgentServices = true
): string[] {
  const marker = "/var/lib/mc-aws/maintenance-boot-hold.json";
  const fence = "/run/mc-agent/maintenance-state.json";
  const commands = [
    "sudo systemctl stop crond.service",
    "if systemctl is-active --quiet crond.service; then exit 72; fi",
    ...(activateAgentServices
      ? [
          "systemctl is-enabled --quiet mc-agent-executor.socket || exit 73",
          "systemctl is-enabled --quiet mc-agent-gateway.service || exit 74",
          "systemctl is-active --quiet mc-agent-executor.socket || exit 75",
          "systemctl is-active --quiet mc-agent-gateway.service || exit 76",
        ]
      : [
          "sudo systemctl stop mc-agent-gateway.service mc-agent-executor.service mc-agent-executor.socket",
          "if systemctl is-active --quiet mc-agent-gateway.service; then exit 77; fi",
          "if systemctl is-active --quiet mc-agent-executor.service; then exit 78; fi",
          "if systemctl is-active --quiet mc-agent-executor.socket; then exit 79; fi",
          "sudo systemctl disable mc-agent-gateway.service mc-agent-executor.service mc-agent-executor.socket",
        ]),
    `if sudo test -e ${marker}; then sudo /usr/local/bin/mc-maintenance-boot.py --marker ${marker} inspect | python3 -c 'import json,sys; value=json.load(sys.stdin); owner,operation=sys.argv[1:]; raise SystemExit(0 if value["owner"]==owner and value["operation"]==operation else 1)' ${shellQuote(owner)} ${shellQuote(operation)}; sudo python3 -c 'import json,os,sys; path,owner,operation=sys.argv[1:];\ntry: value=json.load(open(path,encoding="ascii"))\nexcept FileNotFoundError: raise SystemExit(0)\nassert value.get("schemaVersion")==1 and value.get("owner")==owner and value.get("operation")==operation\nos.unlink(path)\ndescriptor=os.open(os.path.dirname(path),os.O_RDONLY); os.fsync(descriptor); os.close(descriptor)' ${fence} ${shellQuote(owner)} ${shellQuote(operation)}; sudo /usr/local/bin/mc-maintenance-boot.py --marker ${marker} clear --owner ${shellQuote(owner)}; else sudo test ! -e ${fence}; fi`,
    "sudo systemctl start crond.service",
  ];
  return [`set -euo pipefail; ${commands.join("; ")}`];
}

async function releaseHostMaintenance(
  options: Options,
  instanceId: string,
  owner: string,
  operation: "restore" | "host-replacement",
  heartbeat: ReplacementFenceHeartbeat,
  activateAgentServices = true
): Promise<void> {
  await ssmCommandWithFence(
    options.region,
    instanceId,
    hostMaintenanceReleaseCommands(owner, operation, activateAgentServices),
    heartbeat
  );
}

async function finalizeCompletedStackRollback(
  options: Options,
  state: UpgradeState,
  rolledBackStack: JsonRecord,
  changeSet: JsonRecord,
  heartbeat: ReplacementFenceHeartbeat
): Promise<void> {
  if (
    rolledBackStack.StackId !== state.identity.stackId ||
    rolledBackStack.StackStatus !== "UPDATE_ROLLBACK_COMPLETE"
  ) {
    throw new Error("CloudFormation rollback did not reach the exact stable stack");
  }
  const outputs = validateRequiredStackOutputs(stackOutputs(rolledBackStack));
  if (outputs.InstanceId !== state.identity.instanceId) {
    throw new Error("CloudFormation rollback did not restore the reviewed original instance identity");
  }
  if (managedInstancePhysicalId(options.region, state.identity.stackId) !== state.identity.instanceId) {
    throw new Error("CloudFormation rollback did not restore ownership of the reviewed original instance");
  }
  if (!state.backupProof) throw new Error("CloudFormation rollback recovery has no terminal backup ownership proof");
  let disposition = oldHostDisposition(options.region, state.identity.instanceId);
  if (disposition === "stopped") {
    await heartbeat.checkpoint();
    aws(options.region, ["ec2", "start-instances", "--instance-ids", state.identity.instanceId]);
    disposition = "pending";
  }
  if (disposition === "pending") {
    await waitInstanceWithFence(options.region, state.identity.instanceId, "running", heartbeat);
    disposition = "running";
  }
  if (disposition !== "running") {
    throw new Error(`CloudFormation rollback could not safely restart the reviewed original host: ${disposition}`);
  }
  await waitSsmOnline(options, state.identity.instanceId, heartbeat);
  const resumeOutput = await ssmCommandWithFence(
    options.region,
    state.identity.instanceId,
    [
      `sudo env MC_RESUME_OPERATION_ID=${shellQuote(state.replacementOperation?.operationId ?? "")} MC_RESUME_OPERATION_OWNER_TOKEN=${shellQuote(state.replacementOperation?.operationOwnerId ?? "")} MC_MAINTENANCE_PARENT_OPERATION=host-replacement /usr/local/bin/mc-resume.sh fresh`,
      "sudo /usr/local/bin/mc-wait-ready.sh raw_ip '' ''",
    ],
    heartbeat
  );
  if (!resumeOutput.includes('"ready":true')) {
    throw new Error("CloudFormation rollback restored the original host but readiness did not succeed");
  }
  if (heartbeat.context.operation.resumeIntent) {
    transitionResumeIntentPointer(
      options.region,
      heartbeat.context.operation.operationId,
      heartbeat.context.operation.operationOwnerId,
      heartbeat.context.operation.resumeIntent as unknown as JsonRecord,
      "completed"
    );
  }
  let terminal = await heartbeat.checkpoint({
    status: "failed",
    phase: "rolled-back",
    oldHostSafetyCheckPending: false,
    hostMaintenanceReleaseRequested: true,
    changeSetStatus: String(changeSet.Status),
    changeSetExecutionStatus: String(changeSet.ExecutionStatus),
    executionCompletedAt: heartbeat.context.operation.executionCompletedAt ?? new Date().toISOString(),
  });
  await releaseHostMaintenance(
    options,
    state.identity.instanceId,
    state.backupProof.maintenanceOwner,
    "host-replacement",
    heartbeat
  );
  terminal = await heartbeat.checkpoint({ hostMaintenanceReleased: true });
  state.status = "complete";
  state.newInstanceId = state.identity.instanceId;
  writeState(state);
  terminal = await heartbeat.stopAfterTerminal();
  state.replacementOperation = await finalizeReplacementLifecycleFence(terminal);
  writeState(state);
}

function verifyUpdatedInstance(options: Options, state: UpgradeState, instanceId: string): void {
  if (state.changeKind === "replacement" && instanceId === state.identity.instanceId) {
    throw new Error("CloudFormation did not replace the instance");
  }
  if (state.changeKind === "in-place" && instanceId !== state.identity.instanceId) {
    throw new Error("CloudFormation unexpectedly replaced the in-place instance");
  }
  if (managedInstancePhysicalId(options.region, state.identity.stackId) !== instanceId) {
    throw new Error("Updated instance is not the current managed CloudFormation physical resource");
  }
  const instance = aws(options.region, ["ec2", "describe-instances", "--instance-ids", instanceId]).Reservations?.[0]
    ?.Instances?.[0];
  if (instance?.ImageId !== state.identity.targetAmiId) {
    throw new Error("Updated instance does not use the reviewed target AMI");
  }
  if (instance?.State?.Name !== "running")
    throw new Error("Updated instance is not running; automatic startup refused");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The replacement workflow keeps every host, EC2, and CloudFormation fence boundary explicit.
async function executeReplacement(options: Options, state: UpgradeState): Promise<void> {
  if (state.status !== "prepared" || !state.snapshotId || !state.changeSetId || !state.backupProof) {
    throw new Error("Replacement state is not prepared");
  }
  assertInitiallyRunningHost(state.identity);
  assertExactReplacementConfirmations(state.identity, state.snapshotId, state.changeSetId, {
    stackId: options.confirmStackId,
    instanceId: options.confirmInstanceId,
    snapshotId: options.confirmSnapshotId,
    changeSetId: options.confirmChangeSetId,
    phrase: options.confirmReplacement,
  });
  // Freshness was established before the old host was stopped. Recovery may
  // legitimately outlive that wall-clock window; immutable authenticated
  // backup identity, generation, snapshot, and operation state are rechecked.
  assertApplicationBackupProof(state.backupName, state.backupProof, Date.now(), Number.MAX_SAFE_INTEGER);
  const snapshot = aws(options.region, ["ec2", "describe-snapshots", "--snapshot-ids", state.snapshotId])
    .Snapshots?.[0];
  assertCompletedRootSnapshot(state.identity, snapshot);
  const reviewed = aws(options.region, [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    state.identity.stackId,
    "--change-set-name",
    state.changeSetId,
    "--include-property-values",
  ]);
  const reviewedChangeKind = assertReviewedInstanceReplacementPlan(state.identity, reviewed, INSTANCE_LOGICAL_ID);
  if (reviewedChangeKind !== state.changeKind) throw new Error("Reviewed host change classification changed");
  const pendingResponse = aws(options.region, [
    "cloudformation",
    "get-template",
    "--stack-name",
    state.identity.stackId,
    "--change-set-name",
    state.changeSetId,
    "--template-stage",
    "Original",
  ]);
  const pendingTemplate = (
    typeof pendingResponse.TemplateBody === "string"
      ? JSON.parse(pendingResponse.TemplateBody)
      : pendingResponse.TemplateBody
  ) as CloudFormationTemplate;
  assertStandardDeploymentInstanceSafe(liveTemplate(options, stack(options)), pendingTemplate, undefined, {
    identity: state.identity,
    snapshotId: state.snapshotId,
    snapshot,
    changeSet: reviewed,
    changeSetId: state.changeSetId,
    confirmations: {
      stackId: options.confirmStackId,
      instanceId: options.confirmInstanceId,
      snapshotId: options.confirmSnapshotId,
      changeSetId: options.confirmChangeSetId,
      phrase: options.confirmReplacement,
    },
  });
  const live = stack(options);
  configureLifecycleLockEnvironment(live);
  const reconciled = await reconcileReplacementFence(options, state);
  const heartbeat = replacementHeartbeat(state, reconciled);
  if (
    heartbeat.context.operation.oldHostSafetyInvalidatedAt ||
    heartbeat.context.operation.oldHostSafetyCheckPending === true
  ) {
    await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
    throw new Error("Replacement execution refuses backup evidence invalidated by old-host activity");
  }
  if (reconciled.operation.phase !== "prepared") {
    throw new Error(`Replacement execution requires prepared durable state; found ${reconciled.operation.phase}`);
  }
  if (
    reconciled.operation.changeSetId !== state.changeSetId ||
    reconciled.operation.changeSetName === undefined ||
    reconciled.operation.changeKind !== state.changeKind
  ) {
    throw new Error("Replacement execution requires the exact durably reviewed change-set identity");
  }
  await heartbeat.checkpoint({ oldHostSafetyCheckPending: true });
  const oldHostState = oldHostDisposition(options.region, state.identity.instanceId);
  if (oldHostState === "running" || oldHostState === "pending") {
    await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
    throw new Error("Old host became active after preparation; execute-replacement refuses stale backup evidence");
  }
  if (oldHostState === "stopping") {
    await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
    throw new Error("Old host stop activity after preparation invalidated backup evidence");
  }
  if (!new Set(["stopped", "terminated", "absent"]).has(oldHostState)) {
    throw new Error("Replacement execution requires a fresh safe old-host disposition");
  }
  await heartbeat.checkpoint({
    oldHostStopped: true,
    oldHostDisposition: oldHostState as "stopped" | "terminated" | "absent",
    oldHostSafetyCheckPending: false,
  });
  state.status = "executing";
  writeState(state);
  let verifiedNewInstance = false;
  try {
    const executionClientToken =
      heartbeat.context.operation.executionClientToken ??
      `replacement-execute-${heartbeat.context.operation.operationId}`;
    await heartbeat.checkpoint({
      phase: "execution-requested",
      executionClientToken,
      executionRequestedAt: heartbeat.context.operation.executionRequestedAt ?? new Date().toISOString(),
      changeSetStatus: String(reviewed.Status),
      changeSetExecutionStatus: String(reviewed.ExecutionStatus),
    });
    if (!state.backupProof) throw new Error("Replacement resume intent requires exact terminal backup proof");
    const resumeIntent =
      state.changeKind === "replacement"
        ? {
            operationId: heartbeat.context.operation.operationId,
            mode: "replacement-convergence" as const,
            backupArchiveName: state.backupName as string,
            backupId: state.backupProof.backupId,
            generation: state.backupProof.generation,
            maintenanceOwner: state.backupProof.maintenanceOwner,
            operationKey: state.backupProof.operationKey,
            quiescenceEpoch: state.backupProof.quiescenceEpoch,
          }
        : {
            operationId: heartbeat.context.operation.operationId,
            mode: "named" as const,
            backupArchiveName: state.backupName as string,
          };
    await heartbeat.checkpoint({ resumeIntent });
    transitionResumeIntentPointer(
      options.region,
      heartbeat.context.operation.operationId,
      heartbeat.context.operation.operationOwnerId,
      resumeIntent,
      "active"
    );
    await heartbeat.checkpoint();
    try {
      aws(options.region, [
        "cloudformation",
        "execute-change-set",
        "--stack-name",
        state.identity.stackId,
        "--change-set-name",
        state.changeSetId,
        "--client-request-token",
        executionClientToken,
      ]);
    } catch (error) {
      const evidence = readReviewedChangeSetExecution(options, state);
      if (classifyReviewedChangeSetExecution(evidence, state.changeSetId) === "never-executed") {
        throw error;
      }
    }
    const completedExecution = await waitReviewedChangeSetExecutionWithFence(options, state.changeSetId, heartbeat);
    const after = completedExecution.stack;
    if (completedExecution.outcome === "rolled-back") {
      await finalizeCompletedStackRollback(options, state, after, completedExecution.changeSet, heartbeat);
      console.log("Reviewed CloudFormation replacement rolled back; the original host was resumed and verified ready.");
      return;
    }
    await heartbeat.checkpoint({
      phase: "execution-complete",
      changeSetStatus: String(completedExecution.changeSet.Status),
      changeSetExecutionStatus: String(completedExecution.changeSet.ExecutionStatus),
      executionCompletedAt: new Date().toISOString(),
    });
    const outputs = validateRequiredStackOutputs(stackOutputs(after));
    if (managedInstancePhysicalId(options.region, state.identity.stackId) !== outputs.InstanceId) {
      throw new Error("Replacement recovery output is not the current managed CloudFormation physical resource");
    }
    state.newInstanceId = outputs.InstanceId;
    writeState(state);
    await heartbeat.checkpoint({ phase: "restoring", newInstanceId: outputs.InstanceId });
    verifyUpdatedInstance(options, state, outputs.InstanceId);
    verifiedNewInstance = true;
    await heartbeat.checkpoint({ newInstanceVerified: true });
    await postRestore(options, state, outputs.InstanceId, heartbeat);
    await heartbeat.checkpoint();
    const persistedStack = persistOutputs(options, state);
    verifyUpdatedInstance(options, state, outputs.InstanceId);
    assertSafeToReleaseUpgradeQuiescence({
      stackStatus: persistedStack.StackStatus,
      instanceState: "running",
      restoreSucceeded: true,
      readinessSucceeded: true,
      hashesMatch: true,
      outputsPersisted: true,
    });
    let terminal = await heartbeat.checkpoint({
      status: "completed",
      phase: "committed",
      oldHostSafetyCheckPending: false,
      hostMaintenanceReleaseRequested: true,
    });
    await releaseHostMaintenance(
      options,
      outputs.InstanceId,
      state.changeKind === "in-place"
        ? state.backupProof!.maintenanceOwner
        : (state.replacementOperation?.operationId ?? ""),
      state.changeKind === "in-place" ? "host-replacement" : "restore",
      heartbeat,
      heartbeat.context.operation.receiptVerifierRotated !== true
    );
    terminal = await heartbeat.checkpoint({ hostMaintenanceReleased: true });
    state.status = "complete";
    writeState(state);
    terminal = await heartbeat.stopAfterTerminal();
    state.replacementOperation = await finalizeReplacementLifecycleFence(terminal);
    writeState(state);
    console.log(
      `${state.changeKind === "replacement" ? "Replacement" : "In-place host update"} complete and verified: ${outputs.InstanceId}`
    );
    console.log("AWS outputs are persisted. Deploy the Worker only after reviewing dual-v1 rollout order.");
  } catch (error) {
    if (heartbeat.context.operation.phase === "committed" || heartbeat.context.operation.phase === "rolled-back") {
      state.status = "complete";
      writeState(state);
      console.error(
        "Replacement terminal outcome is durable; rerun the exact recovery command to reconcile host and fence release."
      );
      throw error;
    }
    state.status = "recovery-required";
    writeState(state);
    await heartbeat.checkpoint({ phase: "recovery-required" }).catch(() => undefined);
    if (verifiedNewInstance && state.newInstanceId) {
      try {
        await heartbeat.checkpoint();
        aws(options.region, ["ec2", "stop-instances", "--instance-ids", state.newInstanceId]);
        await waitInstanceWithFence(options.region, state.newInstanceId, "stopped", heartbeat);
      } catch (stopError) {
        console.error(
          `Recovery stop was not attempted because lifecycle ownership was not proven: ${(stopError as Error).message}`
        );
      }
    }
    console.error(
      "Recovery stop: resume marker and lifecycle fence were retained. Do not deploy the Worker or delete the snapshot."
    );
    if (state.newInstanceId) {
      console.error(
        `After correcting the cause, run: pnpm host:upgrade -- recover --confirm-stack-id '${state.identity.stackId}' --confirm-instance-id '${state.newInstanceId}' --confirm-recovery 'RESTORE ${state.newInstanceId} FROM ${state.backupName}'`
      );
    } else {
      console.error(
        `No replacement instance was proven. After checking CloudFormation, run: pnpm host:upgrade -- recover --confirm-stack-id '${state.identity.stackId}' --confirm-instance-id '${state.identity.instanceId}' --confirm-recovery 'RECOVER ${state.replacementOperation?.operationId} FOR ${state.identity.instanceId}'`
      );
    }
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery keeps takeover proofs, stack convergence, restore, and terminal fencing in one fail-closed boundary.
async function recover(options: Options, state: UpgradeState): Promise<void> {
  if (!state.replacementOperation || !new Set(["executing", "recovery-required", "complete"]).has(state.status)) {
    throw new Error("No replacement recovery is pending");
  }
  assertInitiallyRunningHost(state.identity);
  const found = describeStack(options);
  configureLifecycleLockEnvironment(found);
  const authoritative = await readReplacementLifecycleOperation(state.replacementOperation.operationId);
  if (!authoritative) throw new Error("Replacement durable operation state is unavailable");
  const expectedInstanceId = state.newInstanceId ?? state.identity.instanceId;
  const phrase = state.newInstanceId
    ? `RESTORE ${state.newInstanceId} FROM ${state.backupName}`
    : `RECOVER ${authoritative.operationId} FOR ${state.identity.instanceId}`;
  if (
    options.confirmStackId !== state.identity.stackId ||
    options.confirmInstanceId !== expectedInstanceId ||
    options.confirmRecovery !== phrase
  ) {
    throw new Error(`Recovery refused. Pass exact stack/new-instance confirmations and --confirm-recovery '${phrase}'`);
  }
  if (authoritative.phase === "rolled-back") {
    const execution = readReviewedChangeSetExecution(options, state);
    if (
      classifyReviewedChangeSetExecution(execution, state.changeSetId as string) !== "complete" ||
      found.StackStatus !== "UPDATE_ROLLBACK_COMPLETE" ||
      found.StackId !== execution.StackId
    ) {
      throw new Error("Rolled-back replacement recovery lacks exact completed rollback evidence");
    }
    assertReviewedStackExecutionEvent(options, authoritative, "UPDATE_ROLLBACK_COMPLETE");
    const outputs = validateRequiredStackOutputs(stackOutputs(found));
    if (
      outputs.InstanceId !== state.identity.instanceId ||
      managedInstancePhysicalId(options.region, state.identity.stackId) !== state.identity.instanceId
    ) {
      throw new Error("Rolled-back replacement recovery no longer owns the exact original instance");
    }
    let terminal = contextFromReplacementOperation(authoritative);
    if (authoritative.hostMaintenanceReleased !== true) {
      const heartbeat = replacementHeartbeat(state, terminal);
      await releaseHostMaintenance(
        options,
        state.identity.instanceId,
        state.backupProof!.maintenanceOwner,
        "host-replacement",
        heartbeat
      );
      terminal = await heartbeat.checkpoint({ hostMaintenanceReleased: true });
      terminal = await heartbeat.stopAfterTerminal();
    }
    state.replacementOperation = authoritative.fenceReleasedAt
      ? authoritative
      : await finalizeReplacementLifecycleFence(terminal);
    state.status = "complete";
    state.newInstanceId = state.identity.instanceId;
    writeState(state);
    return;
  }
  if (authoritative.phase === "committed") {
    const execution = readReviewedChangeSetExecution(options, state);
    if (classifyReviewedChangeSetExecution(execution, state.changeSetId as string) !== "complete") {
      throw new Error("Committed replacement recovery lacks exact completed change-set evidence");
    }
    if (found.StackStatus !== "UPDATE_COMPLETE" || found.StackId !== execution.StackId) {
      throw new Error("Committed replacement recovery does not match the exact updated stack");
    }
    assertReviewedStackExecutionEvent(options, authoritative, "UPDATE_COMPLETE");
    const outputs = validateRequiredStackOutputs(stackOutputs(found));
    verifyUpdatedInstance(options, state, outputs.InstanceId);
    state.newInstanceId = outputs.InstanceId;
    persistOutputs(options, state);
    if (!authoritative.fenceReleasedAt) {
      let terminal = contextFromReplacementOperation(authoritative);
      if (authoritative.hostMaintenanceReleased !== true) {
        const heartbeat = replacementHeartbeat(state, terminal);
        await releaseHostMaintenance(
          options,
          outputs.InstanceId,
          state.changeKind === "in-place"
            ? state.backupProof!.maintenanceOwner
            : (state.replacementOperation?.operationId ?? ""),
          state.changeKind === "in-place" ? "host-replacement" : "restore",
          heartbeat,
          authoritative.receiptVerifierRotated !== true
        );
        terminal = await heartbeat.checkpoint({ hostMaintenanceReleased: true });
        terminal = await heartbeat.stopAfterTerminal();
      }
      state.replacementOperation = await finalizeReplacementLifecycleFence(terminal);
    } else {
      state.replacementOperation = authoritative;
    }
    state.status = "complete";
    writeState(state);
    return;
  }
  const reconciled = await reconcileReplacementFence(options, state);
  if (reconciled.operation.phase === "prepared") {
    throw new Error(
      "Prepared replacement must use execute-replacement with its exact snapshot/change-set confirmations"
    );
  }
  if (
    (!reconciled.operation.oldHostAgentDrained || !reconciled.operation.oldHostMasked) &&
    !reconciled.operation.oldHostStopped
  ) {
    throw new Error("Replacement recovery refused because old-host quiescence or physical-stop safety is unproven");
  }
  const heartbeat = replacementHeartbeat(state, reconciled);
  const sameAmiRecovery = state.identity.currentAmiId === state.identity.targetAmiId;
  let authoritativeExecution: JsonRecord | undefined;
  let authoritativeExecutionDisposition: ReturnType<typeof classifyReviewedChangeSetExecution> | undefined;
  if (sameAmiRecovery) {
    // The original instance is also the post-update instance for a same-AMI
    // change. Its activity is not stale-old-host evidence once the exact
    // reviewed change set has started, so establish that authoritative outcome
    // before considering any activity-based backup invalidation.
    authoritativeExecution = readReviewedChangeSetExecution(options, state);
    authoritativeExecutionDisposition = classifyReviewedChangeSetExecution(
      authoritativeExecution,
      state.changeSetId as string
    );
  }
  if (
    heartbeat.context.operation.oldHostSafetyInvalidatedAt ||
    (heartbeat.context.operation.oldHostSafetyCheckPending === true &&
      (!sameAmiRecovery || authoritativeExecutionDisposition === "never-executed"))
  ) {
    await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
    throw new Error("Replacement recovery refuses backup evidence invalidated by old-host activity");
  }
  if (requiresOldHostActivityCheckBeforeRecovery(sameAmiRecovery, authoritativeExecutionDisposition)) {
    await heartbeat.checkpoint({ oldHostSafetyCheckPending: true });
    const recoveryOldHostState = oldHostDisposition(options.region, state.identity.instanceId);
    if (new Set(["running", "pending", "stopping"]).has(recoveryOldHostState)) {
      await invalidateReplacementAfterHostActivity(options, state, heartbeat.context, heartbeat);
      throw new Error("Replacement recovery observed old-host activity and invalidated stale backup evidence");
    }
    if (!new Set(["stopped", "terminated", "absent"]).has(recoveryOldHostState)) {
      throw new Error("Replacement recovery could not prove a fresh safe old-host disposition");
    }
    await heartbeat.checkpoint({
      oldHostStopped: true,
      oldHostDisposition: recoveryOldHostState as "stopped" | "terminated" | "absent",
      oldHostSafetyCheckPending: false,
    });
  } else if (heartbeat.context.operation.oldHostSafetyCheckPending === true) {
    await heartbeat.checkpoint({ oldHostSafetyCheckPending: false });
  }
  let verifiedNewInstance = false;
  try {
    const execution = authoritativeExecution ?? readReviewedChangeSetExecution(options, state);
    const executionDisposition =
      authoritativeExecutionDisposition ?? classifyReviewedChangeSetExecution(execution, state.changeSetId as string);
    if (executionDisposition === "never-executed") {
      await heartbeat.checkpoint({
        phase: "prepared",
        changeSetStatus: String(execution.Status),
        changeSetExecutionStatus: String(execution.ExecutionStatus),
      });
      state.status = "prepared";
      writeState(state);
      throw new Error(
        "Reviewed change set was never executed; rerun execute-replacement with the original exact confirmations"
      );
    }
    const completedExecution: { outcome: "updated" | "rolled-back"; stack: JsonRecord; changeSet: JsonRecord } =
      executionDisposition === "complete"
        ? {
            outcome:
              found.StackStatus === "UPDATE_ROLLBACK_COMPLETE"
                ? "rolled-back"
                : found.StackStatus === "UPDATE_COMPLETE"
                  ? "updated"
                  : (() => {
                      throw new Error("Reviewed replacement execution has not reached a supported stable stack status");
                    })(),
            stack: found,
            changeSet: execution,
          }
        : await waitReviewedChangeSetExecutionWithFence(options, state.changeSetId as string, heartbeat);
    const after = completedExecution.stack;
    if (after.StackId !== state.identity.stackId) {
      throw new Error("Reviewed replacement execution did not complete on the exact stack");
    }
    assertReviewedStackExecutionEvent(
      options,
      heartbeat.context.operation,
      completedExecution.outcome === "rolled-back" ? "UPDATE_ROLLBACK_COMPLETE" : "UPDATE_COMPLETE"
    );
    if (completedExecution.outcome === "rolled-back") {
      await finalizeCompletedStackRollback(options, state, after, completedExecution.changeSet, heartbeat);
      return;
    }
    await heartbeat.checkpoint({
      phase: "execution-complete",
      changeSetStatus: String(completedExecution.changeSet.Status),
      changeSetExecutionStatus: String(completedExecution.changeSet.ExecutionStatus),
      executionCompletedAt: heartbeat.context.operation.executionCompletedAt ?? new Date().toISOString(),
    });
    const outputs = validateRequiredStackOutputs(stackOutputs(after));
    if (managedInstancePhysicalId(options.region, state.identity.stackId) !== outputs.InstanceId) {
      throw new Error("Replacement recovery output is not the current managed CloudFormation physical resource");
    }
    state.newInstanceId = outputs.InstanceId;
    writeState(state);
    await heartbeat.checkpoint({ phase: "restoring", newInstanceId: outputs.InstanceId });
    const replacementState = instanceState(options.region, outputs.InstanceId);
    if (replacementState === "stopped") {
      await heartbeat.checkpoint();
      aws(options.region, ["ec2", "start-instances", "--instance-ids", outputs.InstanceId]);
    } else if (replacementState !== "running" && replacementState !== "pending") {
      throw new Error("Replacement recovery refused to start an unproven instance state");
    }
    await waitInstanceWithFence(options.region, outputs.InstanceId, "running", heartbeat);
    verifyUpdatedInstance(options, state, outputs.InstanceId);
    verifiedNewInstance = true;
    await heartbeat.checkpoint({ newInstanceVerified: true });
    await postRestore(options, state, outputs.InstanceId, heartbeat);
    verifyUpdatedInstance(options, state, outputs.InstanceId);
    await heartbeat.checkpoint();
    const persistedStack = persistOutputs(options, state);
    verifyUpdatedInstance(options, state, outputs.InstanceId);
    assertSafeToReleaseUpgradeQuiescence({
      stackStatus: persistedStack.StackStatus,
      instanceState: "running",
      restoreSucceeded: true,
      readinessSucceeded: true,
      hashesMatch: true,
      outputsPersisted: true,
    });
    let terminal = await heartbeat.checkpoint({
      status: "completed",
      phase: "committed",
      oldHostSafetyCheckPending: false,
      hostMaintenanceReleaseRequested: true,
    });
    await releaseHostMaintenance(
      options,
      outputs.InstanceId,
      state.changeKind === "in-place"
        ? state.backupProof!.maintenanceOwner
        : (state.replacementOperation?.operationId ?? ""),
      state.changeKind === "in-place" ? "host-replacement" : "restore",
      heartbeat,
      heartbeat.context.operation.receiptVerifierRotated !== true
    );
    terminal = await heartbeat.checkpoint({ hostMaintenanceReleased: true });
    state.status = "complete";
    writeState(state);
    terminal = await heartbeat.stopAfterTerminal();
    state.replacementOperation = await finalizeReplacementLifecycleFence(terminal);
    writeState(state);
  } catch (error) {
    state.status =
      heartbeat.context.operation.phase === "committed" || heartbeat.context.operation.phase === "rolled-back"
        ? "complete"
        : heartbeat.context.operation.phase === "prepared"
          ? "prepared"
          : "recovery-required";
    writeState(state);
    if (
      verifiedNewInstance &&
      heartbeat.context.operation.phase !== "committed" &&
      heartbeat.context.operation.phase !== "rolled-back" &&
      state.newInstanceId
    ) {
      try {
        await heartbeat.checkpoint();
        aws(options.region, ["ec2", "stop-instances", "--instance-ids", state.newInstanceId]);
        await waitInstanceWithFence(options.region, state.newInstanceId, "stopped", heartbeat);
      } catch (stopError) {
        console.error(`Verified replacement could not be stopped during recovery: ${(stopError as Error).message}`);
      }
    }
    throw error;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI dispatch includes fail-closed recovery identity checks before selecting one workflow.
async function main(): Promise<void> {
  loadDotenv({ path: path.resolve(".env.production"), override: false });
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "execute-replacement") return executeReplacement(options, readState());
  if (options.command === "recover") return recover(options, readState());
  if (options.command === "reconcile-runtime-receipt") return reconcileRuntimeReceipt(options);
  const found = stack(options);
  if (options.command !== "plan") configureLifecycleLockEnvironment(found);
  if (options.command === "prepare-replacement" && existsSync(STATE_PATH)) {
    const state = readState();
    if (state.status === "complete" && state.replacementOperation?.phase === "rolled-back") {
      const identity = hostIdentity(options, found);
      return prepareReplacement(options, found, identity);
    }
    if (!new Set(["preparing", "prepared"]).has(state.status)) {
      throw new Error("Existing host-upgrade state is not a resumable preparation; preserve it for reviewed recovery");
    }
    if (state.identity.stackId !== found.StackId) throw new Error("Prepared replacement belongs to another stack");
    const currentIdentity = hostIdentity(options, found);
    if (
      currentIdentity.instanceId !== state.identity.instanceId ||
      currentIdentity.rootVolumeId !== state.identity.rootVolumeId
    ) {
      throw new Error("Prepared replacement instance or root volume is no longer the managed CloudFormation resource");
    }
    if (managedInstancePhysicalId(options.region, found.StackId) !== state.identity.instanceId) {
      throw new Error("Prepared replacement instance is no longer owned by the reviewed CloudFormation stack");
    }
    return prepareReplacement(options, found, state.identity, state);
  }
  const identity = hostIdentity(options, found);
  if (managedInstancePhysicalId(options.region, found.StackId) !== identity.instanceId) {
    throw new Error("Stack InstanceId output is not the current managed CloudFormation physical resource");
  }
  if (options.command === "plan") return plan(options, found, identity);
  if (options.command === "rollout-runtime") return rolloutRuntime(options, identity);
  return prepareReplacement(options, found, identity);
}

main().catch((error) => {
  console.error(`Host upgrade refused: ${(error as Error).message}`);
  if (error instanceof CommandFailure) console.error(error.output);
  process.exit(1);
});
