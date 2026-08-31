import { createHash } from "node:crypto";

// biome-ignore lint/suspicious/noExplicitAny: AWS CLI documents are open JSON records.
type JsonRecord = Record<string, any>;

export interface HostIdentity {
  stackId: string;
  instanceId: string;
  rootVolumeId: string;
  currentAmiId: string;
  targetAmiId: string;
}

export interface ReplacementConfirmations {
  stackId?: string;
  instanceId?: string;
  snapshotId?: string;
  changeSetId?: string;
  phrase?: string;
}

const idPatterns = {
  instance: /^i-[a-f0-9]{8,17}$/,
  volume: /^vol-[a-f0-9]{8,17}$/,
  snapshot: /^snap-[a-f0-9]{8,17}$/,
  ami: /^ami-[a-f0-9]{8,17}$/,
};

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
  const sameAmi = identity.currentAmiId === identity.targetAmiId;
  if (!sameAmi) {
    if (resource.Replacement !== "True") {
      throw new Error("Managed EC2 AMI change must be an explicit replacement of the exact live instance");
    }
    return "replacement";
  }
  const userDataChanges = (resource.Details ?? []).filter(
    (detail: JsonRecord) =>
      detail.Target?.Attribute === "Properties" &&
      detail.Target?.Name === "UserData" &&
      detail.Target?.RequiresRecreation === "Conditionally"
  );
  if (resource.Replacement !== "Conditional" || userDataChanges.length !== 1) {
    throw new Error("Same-AMI EC2 change must be exactly one conditional UserData update");
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
    if (candidate.Action === "Remove" || candidate.Replacement === "True" || candidate.Replacement === "Conditional") {
      throw new Error(`Replacement plan contains another destructive/replacing change: ${candidate.LogicalResourceId}`);
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
  helperHashesMatch: boolean;
  dependencyVersionsMatch: boolean;
}): void {
  if (!input.rolloutSucceeded) throw new Error("Runtime rollout stop: rollout did not complete");
  if (!input.helperHashesMatch) throw new Error("Runtime rollout stop: helper hashes are not proven");
  if (!input.dependencyVersionsMatch) throw new Error("Runtime rollout stop: dependency versions are not proven");
}

export function runtimeFileDigest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
