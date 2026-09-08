import { createHash, createHmac } from "node:crypto";

// biome-ignore lint/suspicious/noExplicitAny: AWS CLI documents are open JSON records.
type JsonRecord = Record<string, any>;

export interface HostIdentity {
  stackId: string;
  instanceId: string;
  rootVolumeId: string;
  currentAmiId: string;
  targetAmiId: string;
  /** The state observed before this workflow was allowed to mutate the host. */
  initialInstanceState?: "running" | "stopped";
}

export interface ReplacementTransferBinding {
  operationId: string;
  backupId: string;
  archiveName: string;
  generation: number;
  sourceInstanceId: string;
  lockId: string;
  fencingToken: number;
  leaseGeneration: number;
}

export type ReviewedChangeSetExecution = "never-executed" | "in-progress" | "complete";

export function classifyReviewedChangeSetExecution(
  value: Record<string, unknown>,
  expectedChangeSetId: string
): ReviewedChangeSetExecution {
  if (value.ChangeSetId !== expectedChangeSetId || value.Status !== "CREATE_COMPLETE") {
    throw new Error("Reviewed replacement change set identity/status changed");
  }
  if (value.ExecutionStatus === "AVAILABLE") return "never-executed";
  if (value.ExecutionStatus === "EXECUTE_IN_PROGRESS") return "in-progress";
  if (value.ExecutionStatus === "EXECUTE_COMPLETE") return "complete";
  throw new Error(
    `Reviewed replacement change set has unsafe execution status ${String(value.ExecutionStatus ?? "missing")}`
  );
}

export function requiresOldHostActivityCheckBeforeRecovery(
  sameAmi: boolean,
  execution: ReviewedChangeSetExecution | undefined
): boolean {
  return !sameAmi || execution === "never-executed";
}

export interface LifecycleFenceIdentity {
  lockId: string;
  fencingToken: number;
  leaseGeneration: number;
  action: "backup";
  ownerEmail: string;
}

export interface ReplacementConfirmations {
  stackId?: string;
  instanceId?: string;
  snapshotId?: string;
  changeSetId?: string;
  phrase?: string;
}

export interface AgentRuntimeBuildEvidence {
  archive: string;
  sha256: string;
  bytes: number;
  manifestSha256: string;
  manifestBytes: number;
}

export interface PublishedAgentRuntime {
  uri: string;
  sha256: string;
  bytes: number;
  bundleManifestSha256: string;
}

const idPatterns = {
  instance: /^i-[a-f0-9]{8,17}$/,
  volume: /^vol-[a-f0-9]{8,17}$/,
  snapshot: /^snap-[a-f0-9]{8,17}$/,
  ami: /^ami-[a-f0-9]{8,17}$/,
  operation: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
};

const transferCanonical = (value: unknown): string => {
  const sort = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sort);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sort(child)])
      );
    }
    return candidate;
  };
  return JSON.stringify(sort(value));
};

type TransferOfferRecord = {
  format?: unknown;
  schemaVersion?: unknown;
  operationId?: unknown;
  backup?: Record<string, unknown>;
  source?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  delegation?: Record<string, unknown>;
};

/** Bind the source-host signed offer to the physical replacement instance. */
export function bindReplacementTransferAuthorization(
  offerRaw: string,
  targetInstanceId: string,
  expected: ReplacementTransferBinding
): string {
  if (
    !idPatterns.instance.test(targetInstanceId) ||
    !idPatterns.operation.test(expected.operationId) ||
    !expected.lockId ||
    !Number.isSafeInteger(expected.fencingToken) ||
    expected.fencingToken < 1 ||
    !Number.isSafeInteger(expected.leaseGeneration) ||
    expected.leaseGeneration < 1
  ) {
    throw new Error("Replacement transfer target, operation, or lifecycle fence is malformed");
  }
  let offer: TransferOfferRecord;
  try {
    offer = JSON.parse(offerRaw) as TransferOfferRecord;
  } catch {
    throw new Error("Replacement transfer offer is not valid JSON");
  }
  if (
    !offer ||
    Array.isArray(offer) ||
    offer.format !== "mc-aws-backup-transfer-offer" ||
    offer.schemaVersion !== 1 ||
    !offer.backup ||
    !offer.source ||
    !offer.lifecycle ||
    offer.operationId !== expected.operationId ||
    !offer.delegation ||
    typeof offer.delegation.keyBase64 !== "string"
  ) {
    throw new Error("Replacement transfer offer is malformed");
  }
  const offerFencingToken = offer.lifecycle.fencingToken;
  const offerLeaseGeneration = offer.lifecycle.leaseGeneration;
  if (
    typeof offer.lifecycle.lockId !== "string" ||
    offer.lifecycle.lockId.length === 0 ||
    typeof offerFencingToken !== "number" ||
    !Number.isSafeInteger(offerFencingToken) ||
    offerFencingToken < 1 ||
    typeof offerLeaseGeneration !== "number" ||
    !Number.isSafeInteger(offerLeaseGeneration) ||
    offerLeaseGeneration < 1
  ) {
    throw new Error("Replacement transfer offer lifecycle fence is malformed");
  }
  if (
    offer.backup.archiveName !== expected.archiveName ||
    offer.backup.backupId !== expected.backupId ||
    offer.backup.generation !== expected.generation ||
    offer.source.instanceId !== expected.sourceInstanceId
  ) {
    throw new Error("Replacement transfer offer does not match the exact backup or operation");
  }
  const delegationKey = Buffer.from(offer.delegation.keyBase64, "base64");
  if (
    delegationKey.length < 32 ||
    delegationKey.length > 64 ||
    delegationKey.toString("base64") !== offer.delegation.keyBase64
  ) {
    throw new Error("Replacement transfer delegation key is malformed");
  }
  const accountMatch = /^arn:aws(?:-[a-z]+)?:cloudformation:[a-z0-9-]+:(\d{12}):stack\//.exec(
    String(offer.source.serverId)
  );
  if (!accountMatch || offer.source.accountId !== accountMatch[1])
    throw new Error("Replacement transfer server account is malformed");
  const payload = {
    format: "mc-aws-backup-transfer",
    lifecycle: {
      fencingToken: expected.fencingToken,
      leaseGeneration: expected.leaseGeneration,
      lockId: expected.lockId,
    },
    operationId: expected.operationId,
    offer,
    schemaVersion: 1,
    target: { accountId: accountMatch[1], instanceId: targetInstanceId },
  };
  return `${transferCanonical({
    ...payload,
    authentication: {
      algorithm: "HMAC-SHA256",
      keyId: "transfer-delegated",
      tag: createHmac("sha256", delegationKey).update(transferCanonical(payload)).digest("hex"),
    },
  })}\n`;
}

export function replacementConfirmationPhrase(identity: HostIdentity, snapshotId: string): string {
  if (identity.currentAmiId === identity.targetAmiId) {
    return `UPDATE ${identity.instanceId} USERDATA IN PLACE FROM ${snapshotId}`;
  }
  return `REPLACE ${identity.instanceId} WITH ${identity.targetAmiId} FROM ${snapshotId}`;
}

export function assertExactReplacementConfirmations(
  identity: HostIdentity,
  snapshotId: string,
  changeSetId: string,
  confirmations: ReplacementConfirmations
): void {
  if (
    confirmations.stackId !== identity.stackId ||
    confirmations.instanceId !== identity.instanceId ||
    confirmations.snapshotId !== snapshotId ||
    confirmations.changeSetId !== changeSetId ||
    confirmations.phrase !== replacementConfirmationPhrase(identity, snapshotId)
  ) {
    throw new Error(
      `Reviewed replacement bypass refused. Confirm the exact StackId, instance, completed snapshot, immutable change-set ARN, and phrase: ${replacementConfirmationPhrase(identity, snapshotId)}`
    );
  }
}

export function assertInitiallyRunningHost(identity: Pick<HostIdentity, "initialInstanceState">): void {
  if (identity.initialInstanceState !== "running") {
    throw new Error("Mutating existing-host commands refuse an initially stopped or unproven EC2 instance");
  }
}

export function validateLifecycleFenceIdentity(value: unknown): LifecycleFenceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted lifecycle fence identity is malformed");
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !== "action,fencingToken,leaseGeneration,lockId,ownerEmail" ||
    item.action !== "backup" ||
    typeof item.lockId !== "string" ||
    item.lockId.length === 0 ||
    typeof item.ownerEmail !== "string" ||
    item.ownerEmail.trim().length === 0 ||
    !Number.isSafeInteger(item.fencingToken) ||
    Number(item.fencingToken) < 1 ||
    !Number.isSafeInteger(item.leaseGeneration) ||
    Number(item.leaseGeneration) < 1
  ) {
    throw new Error("Persisted lifecycle fence identity is malformed");
  }
  return {
    lockId: item.lockId,
    fencingToken: item.fencingToken as number,
    leaseGeneration: item.leaseGeneration as number,
    action: "backup",
    ownerEmail: item.ownerEmail.trim().toLowerCase(),
  };
}

export function assertApplicationBackupProof(
  backupName: string,
  proof: { name?: unknown; size?: unknown; modifiedAt?: unknown },
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000
): void {
  if (!/^[A-Za-z0-9._-]{1,128}\.tar\.gz$/.test(backupName)) throw new Error("Backup proof name is malformed");
  if (proof.name !== backupName || !Number.isSafeInteger(proof.size) || Number(proof.size) <= 0) {
    throw new Error("Backup proof must identify the exact non-empty reviewed Drive archive");
  }
  const modified = typeof proof.modifiedAt === "string" ? Date.parse(proof.modifiedAt) : Number.NaN;
  if (!Number.isFinite(modified) || modified > now + 5 * 60_000 || now - modified > maxAgeMs) {
    throw new Error("Backup proof is stale or has an invalid modification time");
  }
}

export function assertCompletedRootSnapshot(identity: Pick<HostIdentity, "rootVolumeId">, snapshot: JsonRecord): void {
  if (
    !idPatterns.snapshot.test(snapshot.SnapshotId ?? "") ||
    snapshot.VolumeId !== identity.rootVolumeId ||
    snapshot.State !== "completed" ||
    snapshot.Encrypted !== true ||
    !Number.isSafeInteger(snapshot.VolumeSize) ||
    snapshot.VolumeSize < 1
  ) {
    throw new Error("Backup proof requires one completed encrypted snapshot of the exact live root volume");
  }
}

function replacementValue(change: JsonRecord, name: string, side: "BeforeValue" | "AfterValue"): unknown {
  return (change.ResourceChange?.Details ?? [])
    .filter((detail: JsonRecord) => detail.Target?.Attribute === "Properties" && detail.Target?.Name === name)
    .map((detail: JsonRecord) => detail.Target?.[side])
    .find((value: unknown) => value !== undefined);
}

function assertReviewedAmiTransition(identity: HostIdentity, instance: JsonRecord): void {
  const before = replacementValue(instance, "ImageId", "BeforeValue");
  const after = replacementValue(instance, "ImageId", "AfterValue");
  if (identity.currentAmiId === identity.targetAmiId) {
    if (
      (before !== undefined || after !== undefined) &&
      (before !== identity.currentAmiId || after !== identity.targetAmiId)
    ) {
      throw new Error("EC2 replacement plan contains an unexpected AMI transition");
    }
    return;
  }
  if (before !== identity.currentAmiId || after !== identity.targetAmiId) {
    throw new Error("EC2 replacement plan does not show the exact reviewed AMI transition");
  }
}

function classifyReviewedInstanceChange(identity: HostIdentity, resource: JsonRecord): "replacement" | "in-place" {
  if (
    resource.ResourceType !== "AWS::EC2::Instance" ||
    resource.PhysicalResourceId !== identity.instanceId ||
    resource.Action !== "Modify"
  ) {
    throw new Error("Managed EC2 change must modify the exact live instance");
  }
  const propertyChanges = (resource.Details ?? []).filter(
    (detail: JsonRecord) => detail.Target?.Attribute === "Properties"
  );
  if (propertyChanges.length !== (resource.Details ?? []).length) {
    throw new Error("Managed EC2 change contains details outside reviewed properties");
  }
  const sameAmi = identity.currentAmiId === identity.targetAmiId;
  if (!sameAmi) {
    if (resource.Replacement !== "True") {
      throw new Error("Managed EC2 AMI change must be an explicit replacement of the exact live instance");
    }
    if (propertyChanges.length !== 1 || propertyChanges[0].Target?.Name !== "ImageId") {
      throw new Error("Managed EC2 replacement contains properties outside the exact reviewed AMI transition");
    }
    return "replacement";
  }
  const userDataChanges = propertyChanges.filter(
    (detail: JsonRecord) =>
      detail.Target?.Attribute === "Properties" &&
      detail.Target?.Name === "UserData" &&
      detail.Target?.RequiresRecreation === "Conditionally"
  );
  if (resource.Replacement !== "Conditional" || userDataChanges.length !== 1) {
    throw new Error("Same-AMI EC2 change must be exactly one conditional UserData update");
  }
  if (propertyChanges.length !== 1) {
    throw new Error("Same-AMI EC2 change contains properties outside the exact reviewed UserData update");
  }
  return "in-place";
}

export function assertReviewedInstanceReplacementPlan(
  identity: HostIdentity,
  changeSet: JsonRecord,
  instanceLogicalId: string
): "replacement" | "in-place" {
  if (
    changeSet.StackId !== identity.stackId ||
    changeSet.Status !== "CREATE_COMPLETE" ||
    changeSet.ExecutionStatus !== "AVAILABLE"
  ) {
    throw new Error("Replacement change set is not complete and available");
  }
  const changes = Array.isArray(changeSet.Changes) ? changeSet.Changes : [];
  const instanceChanges = changes.filter(
    (change: JsonRecord) => change.ResourceChange?.LogicalResourceId === instanceLogicalId
  );
  if (instanceChanges.length !== 1) throw new Error("Plan must contain exactly one managed EC2 instance change");
  const instance = instanceChanges[0];
  const resource = instance.ResourceChange;
  const changeKind = classifyReviewedInstanceChange(identity, resource);
  assertReviewedAmiTransition(identity, instance);
  for (const change of changes) {
    const candidate = change.ResourceChange ?? {};
    if (candidate.LogicalResourceId === instanceLogicalId) continue;
    const details = Array.isArray(candidate.Details) ? candidate.Details : [];
    const exactManagedReference =
      candidate.Action === "Modify" &&
      candidate.Replacement === "False" &&
      candidate.ResourceType === "AWS::Lambda::Function" &&
      /^StartMinecraftLambda[A-F0-9]+$/.test(String(candidate.LogicalResourceId ?? "")) &&
      details.length > 0 &&
      details.every(
        (detail: JsonRecord) =>
          detail.ChangeSource === "ResourceReference" &&
          detail.CausingEntity === instanceLogicalId &&
          detail.Evaluation === "Dynamic" &&
          detail.Target?.Attribute === "Properties" &&
          detail.Target?.Name === "Environment" &&
          detail.Target?.RequiresRecreation === "Never"
      );
    if (!exactManagedReference) {
      throw new Error(`Replacement plan contains an unreviewed resource change: ${candidate.LogicalResourceId}`);
    }
  }
  return changeKind;
}

export interface PersistedStackOutputs {
  InstanceId: string;
  LifecycleLockTableName: string;
  OperationStateTableName: string;
  WorkerRuntimeIamUserName: string;
}

export function validateRequiredStackOutputs(value: Record<string, unknown>): PersistedStackOutputs {
  const result = value as unknown as PersistedStackOutputs;
  if (!idPatterns.instance.test(result.InstanceId ?? "")) throw new Error("InstanceId output is missing or malformed");
  for (const name of ["LifecycleLockTableName", "OperationStateTableName", "WorkerRuntimeIamUserName"] as const) {
    if (typeof result[name] !== "string" || !/^[A-Za-z0-9_.@+=,/-]{1,255}$/.test(result[name])) {
      throw new Error(`${name} output is missing or malformed`);
    }
  }
  return result;
}

export function envOutputLines(outputs: PersistedStackOutputs): Record<string, string> {
  return {
    INSTANCE_ID: outputs.InstanceId,
    MC_LIFECYCLE_LOCK_TABLE_NAME: outputs.LifecycleLockTableName,
    MC_OPERATION_STATE_TABLE_NAME: outputs.OperationStateTableName,
  };
}

export function assertSafeToReleaseUpgradeQuiescence(input: {
  stackStatus: unknown;
  instanceState: unknown;
  restoreSucceeded: boolean;
  readinessSucceeded: boolean;
  hashesMatch: boolean;
  outputsPersisted: boolean;
}): void {
  if (input.stackStatus !== "UPDATE_COMPLETE") throw new Error("Rollback stop: stack update is not complete");
  if (input.instanceState !== "running") throw new Error("Rollback stop: replacement instance is not running");
  if (!input.restoreSucceeded) throw new Error("Rollback stop: application backup restore is not proven");
  if (!input.readinessSucceeded) throw new Error("Rollback stop: Minecraft readiness is not proven");
  if (!input.hashesMatch) throw new Error("Rollback stop: runtime hashes do not match reviewed inputs");
  if (!input.outputsPersisted) throw new Error("Rollback stop: replacement outputs are not persisted");
}

export function assertSafeToReleaseRuntimeRollout(input: {
  rolloutSucceeded: boolean;
  transferSucceeded: boolean;
  helperHashesMatch: boolean;
  dependencyVersionsMatch: boolean;
  installedRuntimeMatches: boolean;
  installedManifestMatches: boolean;
}): void {
  if (!input.rolloutSucceeded) throw new Error("Runtime rollout stop: rollout did not complete");
  if (!input.transferSucceeded) throw new Error("Runtime rollout stop: intended runtime transfer did not complete");
  if (!input.helperHashesMatch) throw new Error("Runtime rollout stop: helper hashes are not proven");
  if (!input.dependencyVersionsMatch) throw new Error("Runtime rollout stop: dependency versions are not proven");
  if (!input.installedRuntimeMatches) throw new Error("Runtime rollout stop: current release digest is not proven");
  if (!input.installedManifestMatches) throw new Error("Runtime rollout stop: installed manifest digest is not proven");
}

export function validatePublishedAgentRuntime(value: unknown): PublishedAgentRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Published agent runtime is malformed");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !== "bundleManifestSha256,bytes,sha256,uri" ||
    typeof item.uri !== "string" ||
    !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9!_.*()/-]+$/.test(item.uri) ||
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !Number.isSafeInteger(item.bytes) ||
    Number(item.bytes) < 1 ||
    Number(item.bytes) > 64 * 1024 * 1024 ||
    typeof item.bundleManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.bundleManifestSha256)
  ) {
    throw new Error("Published agent runtime immutable metadata is malformed");
  }
  return item as unknown as PublishedAgentRuntime;
}

export function assertPublishedAgentRuntimeMatchesBuild(
  published: PublishedAgentRuntime,
  build: AgentRuntimeBuildEvidence
): void {
  if (
    published.sha256 !== build.sha256 ||
    published.bytes !== build.bytes ||
    published.bundleManifestSha256 !== build.manifestSha256
  ) {
    throw new Error(
      "Published agent runtime does not match the current locally built/reviewed bundle; publish the current content-addressed ZIP and atomic manifest before host activation"
    );
  }
}

export function runtimeFileDigest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
