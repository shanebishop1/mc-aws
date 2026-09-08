import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const rootDir = path.resolve(process.cwd());
const temporaryDirectories: string[] = [];
const mockCliServers: Array<ReturnType<typeof spawn>> = [];
const activeDestroyProcesses = new Set<ChildProcess>();

class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.available === 0 || this.waiters.length > 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.available -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += 1;
      this.waiters.shift()?.();
    };
  }
}

// Keep the expensive shell/provider fixture runs bounded even when Vitest is
// executing this suite alongside the rest of the repository.
const destroyProcessSemaphore = new AsyncSemaphore(1);
const accountId = "123456789012";
const cloudflareAccountId = "a".repeat(32);
const zoneId = "d".repeat(32);
const routeId = "e".repeat(32);
const dnsId = "c".repeat(32);
const kvId = "b".repeat(32);
const instanceId = `i-${"1".repeat(17)}`;
const volumeId = `vol-${"2".repeat(17)}`;
const snapshotId = `snap-${"3".repeat(17)}`;
const secondSnapshotId = `snap-${"4".repeat(17)}`;
const workerDeploymentId = "11111111-2222-4333-8444-555555555555";
const replacementDeploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const stackId = `arn:aws:cloudformation:us-east-1:${accountId}:stack/MinecraftStack/stack-id`;
const replacementStackId = `arn:aws:cloudformation:us-east-1:${accountId}:stack/MinecraftStack/replacement-id`;
const stackClaimToken = "11111111-2222-4333-8444-555555555555";
const lifecycleLockTableName = "MinecraftStack-LifecycleLockTable-ABC123";
const operationStateTableName = "MinecraftStack-OperationStateTable-DEF456";
const hibernateOperationId = "hibernate-1788650000000-11111111-2222-4333-8444-555555555555";
const hibernateImageId = `ami-${"5".repeat(17)}`;
const hibernateSnapshotId = `snap-${"6".repeat(17)}`;

interface MockState {
  stack: boolean;
  stackId: string;
  stackDescribeCount: number;
  stackSsmParameters: string[];
  lifecycleLockTableName: string;
  operationStateTableName: string;
  hibernateOperations: Array<Record<string, unknown>>;
  lifecycleLockTable: boolean;
  lifecycleLockRetainedOnStackDelete: boolean;
  lifecycleLockItem?: Record<string, { S?: string; N?: string; BOOL?: boolean }>;
  lifecycleRenewCount: number;
  lifecycleRenewFails: boolean;
  barrierAcquireResponseLost: boolean;
  activeAgentEffect: boolean;
  finalBackupFails: boolean;
  finalBackupDelayMs: number;
  delayedAttemptsDuringBackup: string[];
  lastSsmCommandFailed?: boolean;
  stackFinalFailure: boolean;
  deletedStackDescribable: boolean;
  replaceStackAfterInventory: boolean;
  user: boolean;
  userTags: Record<string, string>;
  iamTagReadCount: number;
  changeIamTagsAfterInventory: boolean;
  accessKeys: string[];
  worker: boolean;
  workerDeployments: string[];
  workerFinalFailure: boolean;
  workerNotFoundCode: number;
  secrets: string[];
  kv: Array<{ id: string; title: string }>;
  routes: Array<{ id: string; pattern: string; script: string }>;
  routePaginationMalformed?: boolean;
  routePaginationMalformedFinal?: boolean;
  routeListCount?: number;
  dns: Array<{
    id: string;
    zoneId: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
    proxied: boolean;
  }>;
  dnsMissingCode: number;
  instanceState: string;
  ssmCommandFails: boolean;
  stopInstanceFails: boolean;
  stopWaitFails: boolean;
  rootVolume: boolean;
  volumes: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  snapshotCreateCount: number;
  snapshotCreateFails: boolean;
  snapshotWaitFails: boolean;
  rcloneCredentialPresent: boolean;
  serverDataPresent: boolean;
  credentialScrubFails: boolean;
  instanceUserData: string;
  backupCache: { backups: unknown[]; cachedAt: number };
  ssmParameters: Record<string, { type: "String" | "SecureString"; value: string; version?: number }>;
  dlm: Array<{ PolicyId: string; Tags: Record<string, string> }>;
  failStackDeleteWaitOnce: boolean;
  stackDeleteWaitFailureConsumed?: boolean;
  instanceWriteGeneration: number;
  mutations: string[];
}

const rootVolume = () => ({
  VolumeId: volumeId,
  State: "in-use",
  Attachments: [{ InstanceId: instanceId, State: "attached" }],
  Tags: [
    { Key: "McAwsProject", Value: "mc-aws" },
    { Key: "McAwsStack", Value: "MinecraftStack" },
    { Key: "McAwsManagedRoot", Value: "true" },
  ],
});

const hibernateOperation = () => ({
  schemaVersion: 1,
  id: hibernateOperationId,
  type: "hibernate",
  status: "failed",
  phase: "terminal",
  instanceId,
  executionToken: "hibernate-execution-token",
  updatedAt: "2026-09-06T00:00:00.000Z",
  managedVolumeId: volumeId,
  managedVolumeDevice: "/dev/xvda",
  hibernateOriginalInstanceId: instanceId,
  hibernateSourceImageId: hibernateImageId,
  hibernateReconstructionSnapshotId: hibernateSnapshotId,
  hibernatePhase: "detached",
  hibernateBackupArchiveName: "backup-before-hibernate.tar.gz",
  hibernateBackupId: "d".repeat(32),
  hibernateBackupDigest: "a".repeat(64),
  hibernateBackupSize: 4096,
  hibernateBackupGeneration: 7,
  hibernateBackupCreatedAt: "2026-09-06T00:00:00.000Z",
  hibernateBackupOperationKey: createHash("sha256").update(`${hibernateOperationId}\0hibernate-backup`).digest("hex"),
  hibernateBackupInstanceId: instanceId,
  hibernateBackupServerId: stackId,
  hibernateBackupAuthenticationKeyId: "backup-key-1",
  hibernateQuiescenceEvidence: {
    schemaVersion: 2,
    mode: "terminal-hibernate",
    maintenanceFence: "held",
    maintenanceOwner: "hibernate-owner",
    services: "stopped-and-masked",
    minecraft: "inactive",
    protocol: "closed",
    bootId: "boot-id",
    rootVolumeId: volumeId,
    rootVolumeDevice: "/dev/xvda",
    quiescenceEpoch: "c".repeat(32),
  },
});

const baseState = (): MockState => ({
  stack: true,
  stackId,
  stackDescribeCount: 0,
  stackSsmParameters: [],
  lifecycleLockTableName,
  operationStateTableName,
  hibernateOperations: [hibernateOperation()],
  lifecycleLockTable: true,
  lifecycleLockRetainedOnStackDelete: false,
  lifecycleLockItem: undefined,
  lifecycleRenewCount: 0,
  lifecycleRenewFails: false,
  barrierAcquireResponseLost: false,
  activeAgentEffect: false,
  finalBackupFails: false,
  finalBackupDelayMs: 0,
  delayedAttemptsDuringBackup: [],
  stackFinalFailure: false,
  deletedStackDescribable: false,
  replaceStackAfterInventory: false,
  user: true,
  userTags: {
    McAwsProject: "mc-aws",
    McAwsPurpose: "CloudflareWorkerRuntime",
    McAwsStack: "MinecraftStack",
  },
  iamTagReadCount: 0,
  changeIamTagsAfterInventory: false,
  accessKeys: ["AKIAOWNEDRUNTIMEKEY"],
  worker: true,
  workerDeployments: [workerDeploymentId],
  workerFinalFailure: false,
  workerNotFoundCode: 10090,
  secrets: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  kv: [{ id: kvId, title: "mc-aws-runtime-state" }],
  routes: [],
  routePaginationMalformed: false,
  routePaginationMalformedFinal: false,
  routeListCount: 0,
  dns: [],
  dnsMissingCode: 81044,
  instanceState: "stopped",
  ssmCommandFails: false,
  stopInstanceFails: false,
  stopWaitFails: false,
  rootVolume: true,
  volumes: [rootVolume()],
  snapshots: [],
  snapshotCreateCount: 0,
  snapshotCreateFails: false,
  snapshotWaitFails: false,
  rcloneCredentialPresent: true,
  serverDataPresent: true,
  credentialScrubFails: false,
  instanceUserData: "#!/bin/bash\n",
  backupCache: { backups: [{ name: "backup-before-hibernate" }], cachedAt: Date.now() },
  ssmParameters: {
    "/minecraft/gdrive-token": { type: "SecureString", value: "credential-envelope" },
    "/minecraft/backups-cache": { type: "String", value: "backup-cache" },
    "/minecraft/last-scheduled-backup-success": { type: "String", value: "2026-08-23T05:00:00.000Z" },
    "/minecraft/scheduled-backup-enabled-at": { type: "String", value: "2026-08-16T05:00:00.000Z" },
    "/minecraft/email-allowlist": { type: "String", value: "owner@example.invalid" },
    "/minecraft/player-count": { type: "String", value: "0" },
    "/minecraft/operations/start-1769000000000-11111111-2222-4333-8444-555555555555": {
      type: "String",
      value: "operation-state",
    },
    "/minecraft/operations/email-0123456789abcdef0123456789abcdef01234567": {
      type: "String",
      value: "email-operation-state",
    },
    "/minecraft/operations/email-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": {
      type: "String",
      value: "email-operation-state-without-event-id",
    },
    "/minecraft/server-action-delete-claim/current": { type: "String", value: "pii-bearing-hint" },
    "/minecraft/server-action-delete-claim/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": {
      type: "String",
      value: "pii-bearing-transition",
    },
  },
  dlm: [],
  failStackDeleteWaitOnce: false,
  instanceWriteGeneration: 0,
  mutations: [],
});

const baseManifest = () => ({
  schemaVersion: 1,
  project: "mc-aws",
  aws: {
    accountId,
    region: "us-east-1",
    stack: {
      name: "MinecraftStack",
      id: stackId,
      createdByProject: true,
      observedBeforeSetup: "absent",
      claimToken: stackClaimToken,
    },
    instanceId,
    runtimeIam: {
      userName: "mc-aws-runtime-user",
      createdByProject: true,
      stackOwned: true,
      expectedTags: {
        McAwsProject: "mc-aws",
        McAwsPurpose: "CloudflareWorkerRuntime",
        McAwsStack: "MinecraftStack",
      },
    },
    dlmPolicies: [] as Array<Record<string, unknown>>,
    ssmParameters: Object.entries(baseState().ssmParameters).map(([name, parameter]) => ({
      name,
      type: parameter.type,
      createdByProject: true,
      ownership: "created",
      observedBeforeSetup: "absent",
      source: "setup-preflight",
    })),
  },
  cloudflare: {
    accountId: cloudflareAccountId,
    worker: {
      name: "mc-aws-panel",
      createdByProject: true,
      observedBeforeDeploy: "absent",
      deploymentId: workerDeploymentId,
    },
    panelHosting: { mode: "workers_dev", workersDevEnabled: true },
    routes: [] as Array<Record<string, unknown>>,
    kvNamespaces: [
      {
        binding: "RUNTIME_STATE_SNAPSHOT_KV",
        id: kvId,
        title: "mc-aws-runtime-state",
        createdByProject: true,
        ownership: "created",
      },
    ],
    panelDnsRecords: [] as Array<Record<string, unknown>>,
  },
  teardown: { completedResources: [] as string[] } as Record<string, unknown>,
});

const backupStateParameters = {
  "/minecraft/backup-generation-checkpoint": { type: "String" as const, value: "UNINITIALIZED" },
  "/minecraft/restore-generation-floor": { type: "String" as const, value: "UNINITIALIZED" },
  "/minecraft/backup-server-identity": { type: "String" as const, value: stackId },
  "/minecraft/backup-auth-keyring": { type: "SecureString" as const, value: "opaque-keyring" },
  "/minecraft/backup-verifier-metadata": { type: "String" as const, value: "opaque-verifier-metadata" },
};

function addBackupStateFacts(manifest: ReturnType<typeof baseManifest>): void {
  for (const [name, parameter] of Object.entries(backupStateParameters)) {
    manifest.aws.ssmParameters.push({
      name,
      type: parameter.type,
      createdByProject: true,
      ownership: "created",
      observedBeforeSetup: "absent",
      source: "setup-preflight",
    });
  }
}

const mockCliSource = String.raw`
import fs from "node:fs";
const [tool, ...rawArgs] = process.argv.slice(2);
const statePath = ${JSON.stringify("__STATE_PATH__")};
const accountId = ${JSON.stringify(accountId)};
const cfAccountId = ${JSON.stringify(cloudflareAccountId)};
const instanceId = ${JSON.stringify(instanceId)};
const volumeId = ${JSON.stringify(volumeId)};
const snapshotId = ${JSON.stringify(snapshotId)};
const secondSnapshotId = ${JSON.stringify(secondSnapshotId)};
let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => {
  const temporaryPath = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
  fs.renameSync(temporaryPath, statePath);
};
const mutate = (entry) => { state.mutations.push(entry); save(); };
const output = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const fail = (message, code = 255) => { process.stderr.write(message); process.exit(code); };
const args = rawArgs[0] === "--region" ? rawArgs.slice(2) : rawArgs;

if (tool === "aws") {
  const [service, command] = args;
  if (service === "sts") output(accountId);
  else if (service === "cloudformation" && command === "describe-stacks") {
    state.stackDescribeCount += 1;
    if (state.replaceStackAfterInventory && state.stackDescribeCount >= 2) state.stackId = ${JSON.stringify(replacementStackId)};
    save();
    const requested = args[args.indexOf("--stack-name") + 1];
    if (!state.stack && state.stackFinalFailure) fail("AccessDenied: cloudformation DescribeStacks denied");
    if (!state.stack && state.deletedStackDescribable && requested === state.stackId) output({ Stacks: [{ StackId: state.stackId, StackStatus: "DELETE_COMPLETE" }] });
    else if (!state.stack || (requested.startsWith("arn:") && requested !== state.stackId)) fail("ValidationError: Stack does not exist");
    else output({ Stacks: [{ StackId: state.stackId, Tags: [{ Key: "McAwsClaimToken", Value: ${JSON.stringify(stackClaimToken)} }] }] });
  } else if (service === "cloudformation" && command === "list-stack-resources") {
    if (!state.stack) fail("ValidationError: Stack does not exist");
    output({ StackResourceSummaries: [
      ...state.stackSsmParameters.map((PhysicalResourceId, index) => ({
      LogicalResourceId: "SsmParameter" + index, ResourceType: "AWS::SSM::Parameter", PhysicalResourceId,
      })),
      ...(state.lifecycleLockTableName ? [{ LogicalResourceId: "LifecycleLockTableABC123", ResourceType: "AWS::DynamoDB::Table", PhysicalResourceId: state.lifecycleLockTableName }] : []),
      ...(state.operationStateTableName ? [{ LogicalResourceId: "OperationStateTableDEF456", ResourceType: "AWS::DynamoDB::Table", PhysicalResourceId: state.operationStateTableName }] : []),
    ] });
  } else if (service === "cloudformation" && command === "delete-stack") {
    const requested = args[args.indexOf("--stack-name") + 1];
    if (!state.stack || requested !== state.stackId) fail("ValidationError: Stack does not exist");
    mutate("cloudformation:delete-stack:" + requested);
  } else if (service === "cloudformation" && command === "wait") {
    const requested = args[args.indexOf("--stack-name") + 1];
    if (requested !== state.stackId) fail("ValidationError: Stack does not exist");
    if (state.failStackDeleteWaitOnce && !state.stackDeleteWaitFailureConsumed) {
      state.stackDeleteWaitFailureConsumed = true;
      const destroyBarrier = state.lifecycleLockItem?.action?.S === "destroy" && state.lifecycleLockItem?.agentFenceActive?.BOOL === true && state.lifecycleLockItem?.released?.BOOL !== true;
      if (destroyBarrier) mutate("delayed:start-denied-by-destroy-barrier");
      else {
        state.instanceState = "running";
        state.instanceWriteGeneration += 1;
        mutate("instance:restarted-with-new-writes:" + state.instanceWriteGeneration);
      }
      mutate("cloudformation:wait-failed");
      fail("WaiterError: stack deletion failed");
    }
    state.stack = false; state.user = false; state.rootVolume = false; state.volumes = [];
    if (!state.lifecycleLockRetainedOnStackDelete) state.lifecycleLockTable = false;
    mutate("cloudformation:stack-deleted:" + requested);
  } else if (service === "iam" && command === "get-user") {
    if (!state.user) fail("NoSuchEntity");
    output({ User: { UserName: "mc-aws-runtime-user" } });
  } else if (service === "iam" && command === "list-user-tags") {
    state.iamTagReadCount += 1;
    const tags = state.changeIamTagsAfterInventory && state.iamTagReadCount >= 2 ? { McAwsProject: "replaced" } : state.userTags;
    save(); output({ Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });
  } else if (service === "iam" && command === "list-access-keys") {
    output({ AccessKeyMetadata: state.accessKeys.map((AccessKeyId) => ({ AccessKeyId, Status: "Active" })) });
  } else if (service === "iam" && command === "update-access-key") mutate("iam:update-key:" + args[args.indexOf("--access-key-id") + 1]);
  else if (service === "iam" && command === "delete-access-key") {
    const id = args[args.indexOf("--access-key-id") + 1]; state.accessKeys = state.accessKeys.filter((value) => value !== id); mutate("iam:delete-key:" + id);
  } else if (service === "iam" && command === "list-attached-user-policies") output({ AttachedPolicies: [] });
  else if (service === "iam" && command === "list-groups-for-user") output({ Groups: [] });
  else if (service === "iam" && command === "list-user-policies") output({ PolicyNames: ["inline-runtime-policy"] });
  else if (service === "iam" && command === "delete-user-policy") mutate("iam:delete-inline-policy");
  else if (service === "iam" && command === "delete-user") { state.user = false; mutate("iam:delete-user"); }
  else if (service === "dlm" && command === "get-lifecycle-policies") output({ Policies: state.dlm.map(({ PolicyId }) => ({ PolicyId })) });
  else if (service === "dlm" && command === "get-lifecycle-policy") {
    const id = args[args.indexOf("--policy-id") + 1]; const policy = state.dlm.find((item) => item.PolicyId === id);
    if (!policy) fail("ResourceNotFoundException"); output({ Policy: policy });
  } else if (service === "dlm" && command === "delete-lifecycle-policy") {
    const id = args[args.indexOf("--policy-id") + 1]; state.dlm = state.dlm.filter((item) => item.PolicyId !== id); mutate("dlm:delete:" + id);
  } else if (service === "ec2" && command === "describe-volumes") {
    const requested = args.includes("--volume-ids") ? args[args.indexOf("--volume-ids") + 1] : undefined;
    const volumes = requested ? state.volumes.filter((volume) => volume.VolumeId === requested) : state.volumes;
    if (requested && volumes.length === 0) fail("InvalidVolume.NotFound");
    output({ Volumes: volumes });
  } else if (service === "ec2" && command === "describe-snapshots") {
    const requested = args.includes("--snapshot-ids") ? args[args.indexOf("--snapshot-ids") + 1] : undefined;
    output({ Snapshots: requested ? state.snapshots.filter((item) => item.SnapshotId === requested) : state.snapshots });
  } else if (service === "ec2" && command === "create-snapshot") {
    if (state.snapshotCreateFails) fail("InternalError: snapshot creation failed");
    if (state.instanceState !== "stopped") fail("IncorrectState: refusing mock snapshot while instance is not stopped");
    const createdSnapshotId = [snapshotId, secondSnapshotId][state.snapshotCreateCount];
    if (!createdSnapshotId) fail("Mock supports only two teardown snapshots");
    state.snapshotCreateCount += 1;
    const snapshot = { SnapshotId: createdSnapshotId, VolumeId: volumeId, State: "pending", WriteGeneration: state.instanceWriteGeneration, Tags: [
      { Key: "McAwsProject", Value: "mc-aws" }, { Key: "McAwsStack", Value: "MinecraftStack" },
      { Key: "McAwsStackId", Value: state.stackId }, { Key: "McAwsSourceVolumeId", Value: volumeId },
      { Key: "McAwsFinalTeardown", Value: "true" },
    ] };
    state.snapshots.push(snapshot); mutate("ec2:create-snapshot:" + createdSnapshotId); output(snapshot);
  } else if (service === "ec2" && command === "wait") {
    const waiter = args[2];
    if (waiter === "snapshot-completed") {
      if (state.snapshotWaitFails) fail("WaiterError: snapshot did not complete");
      const snapshot = state.snapshots.find((item) => item.SnapshotId === args[args.indexOf("--snapshot-ids") + 1]);
      if (snapshot) snapshot.State = "completed"; save();
    } else if (waiter === "instance-stopped") {
      if (state.stopWaitFails) fail("WaiterError: instance did not stop");
      state.instanceState = "stopped"; mutate("ec2:instance-stopped");
    } else if (waiter === "instance-running") {
      state.instanceState = "running"; mutate("ec2:instance-running");
    } else fail("unexpected ec2 waiter: " + waiter);
  } else if (service === "ec2" && command === "stop-instances") {
    if (state.stopInstanceFails) fail("InternalError: stop failed");
    state.instanceState = "stopping"; mutate("ec2:stop-instance:" + instanceId); output({ StoppingInstances: [{ InstanceId: instanceId }] });
  } else if (service === "ec2" && command === "describe-instances") {
    if (!state.stack && args.includes("--instance-ids")) fail("InvalidInstanceID.NotFound");
    if (!state.stack) output({ Reservations: [] });
    else output({ Reservations: [{ Instances: [{ InstanceId: instanceId, RootDeviceName: "/dev/xvda",
      BlockDeviceMappings: state.rootVolume ? [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: volumeId } }] : [],
       State: { Name: state.instanceState }, Tags: [
        { Key: "McAwsProject", Value: "mc-aws" }, { Key: "McAwsStack", Value: "MinecraftStack" },
        { Key: "aws:cloudformation:stack-id", Value: state.stackId },
      ] }] }] });
  } else if (service === "ec2" && command === "describe-instance-attribute") {
    output({ InstanceId: instanceId, UserData: { Value: Buffer.from(state.instanceUserData).toString("base64") } });
  } else if (service === "ec2" && command === "delete-volume") {
    const id = args[args.indexOf("--volume-id") + 1];
    state.volumes = state.volumes.filter((volume) => volume.VolumeId !== id); mutate("ec2:delete-volume:" + id);
  } else if (service === "ssm" && command === "describe-parameters") {
    const filter = args[args.indexOf("--parameter-filters") + 1] || "";
    const exactName = filter.startsWith("Key=Name,Option=Equals,Values=") ? filter.slice("Key=Name,Option=Equals,Values=".length) : undefined;
    const entries = Object.entries(state.ssmParameters).filter(([Name]) => !exactName || Name === exactName);
    if (exactName && args.includes("--query")) output(entries.map(([Name]) => Name).join("\t"));
    else output(entries.map(([Name, item]) => ({ Name, Type: item.type })));
  } else if (service === "ssm" && command === "get-parameter") {
    const name = args[args.indexOf("--name") + 1];
    const item = state.ssmParameters[name];
    if (!item) fail("ParameterNotFound");
    if (args.includes("--query") && args[args.indexOf("--query") + 1] === "Parameter.Value") output(item.value);
    else if (args.includes("--query")) output(name);
    else if (name === "/minecraft/backups-cache") { mutate("ssm:read-backup-evidence"); output({ Parameter: { Name: name, Type: item.type, Value: JSON.stringify(state.backupCache), Version: item.version ?? 1 } }); }
    else output({ Parameter: { Name: name, Type: item.type, Value: item.value, Version: item.version ?? 1 } });
  } else if (service === "ssm" && command === "put-parameter") {
    const name = args[args.indexOf("--name") + 1];
    const value = args[args.indexOf("--value") + 1];
    if (args.includes("--no-overwrite") && state.ssmParameters[name]) fail("ParameterAlreadyExists");
    const version = (state.ssmParameters[name]?.version ?? 0) + 1;
    state.ssmParameters[name] = { type: "String", value, version };
    mutate("ssm:put-parameter:" + name);
  } else if (service === "ssm" && command === "delete-parameter") {
    const name = args[args.indexOf("--name") + 1];
    if (!state.ssmParameters[name]) fail("ParameterNotFound");
    delete state.ssmParameters[name]; mutate("ssm:delete-parameter:" + name);
  } else if (service === "dynamodb" && command === "scan") {
    if (args[args.indexOf("--table-name") + 1] !== state.operationStateTableName) fail("ResourceNotFoundException");
    mutate("dynamodb:read-hibernate-evidence");
    output({ Items: state.hibernateOperations.map((payload) => ({ operationId: { S: payload.id }, payload: { S: JSON.stringify(payload) } })) });
  } else if (service === "dynamodb" && command === "get-item") {
    if (!state.lifecycleLockTable) fail("ResourceNotFoundException");
    const key = JSON.parse(args[args.indexOf("--key") + 1]).lockKey.S;
    if (key === "protocol#dual-v1") output({ Item: { protocolVersion: { S: "dual-v1" } } });
    else output(state.lifecycleLockItem ? { Item: state.lifecycleLockItem } : {});
  } else if (service === "dynamodb" && command === "update-item") {
    if (!state.lifecycleLockTable) fail("ResourceNotFoundException");
    const expression = args[args.indexOf("--update-expression") + 1];
    const values = JSON.parse(args[args.indexOf("--expression-attribute-values") + 1]);
    const current = state.lifecycleLockItem;
    const active = current && current.released?.BOOL !== true && (current.agentFenceActive?.BOOL === true || Number(current.leaseExpiresAt?.N || 0) >= Date.now());
    const exact = current && current.lockId?.S === values[":lockId"]?.S && current.fencingToken?.N === values[":token"]?.N && current.operationId?.S === values[":operationId"]?.S && current.action?.S === "destroy" && current.released?.BOOL !== true;
    if (expression.includes("if_not_exists(fencingToken")) {
      if (active) fail("ConditionalCheckFailedException");
      const nextToken = Number(current?.fencingToken?.N || 0) + 1;
      state.lifecycleLockItem = {
        lockKey: { S: "minecraft-server-lifecycle" }, lockId: values[":lockId"], action: values[":action"], ownerEmail: values[":ownerEmail"],
        createdAt: values[":createdAt"], leaseExpiresAt: values[":lease"], leaseGeneration: values[":generation"], agentFenceActive: { BOOL: true },
        released: { BOOL: false }, protocolVersion: values[":protocol"], fencingToken: { N: String(nextToken) }, operationId: values[":operationId"],
        operationOwnerId: values[":operationId"], destroyPhase: values[":phase"],
      };
      mutate("dynamodb:destroy-barrier-acquired:" + nextToken);
      if (state.barrierAcquireResponseLost) fail("TimeoutError: response lost");
    } else if (expression.includes("leaseGeneration = leaseGeneration +")) {
      if (state.lifecycleRenewFails) fail("ConditionalCheckFailedException");
      if (!exact || current.leaseGeneration?.N !== values[":generation"]?.N) fail("ConditionalCheckFailedException");
      current.leaseExpiresAt = values[":lease"];
      current.leaseGeneration = { N: String(Number(current.leaseGeneration?.N) + 1) };
      state.lifecycleRenewCount += 1;
      mutate("dynamodb:destroy-barrier-renewed:" + current.leaseGeneration.N);
    } else if (expression.includes("released = :true")) {
      if (!exact || !["intent", "runtime-quiesced"].includes(current.destroyPhase?.S || "")) fail("ConditionalCheckFailedException");
      current.released = { BOOL: true }; current.destroyPhase = { S: "aborted" };
      mutate("dynamodb:destroy-barrier-aborted");
    } else if (expression.includes("destroyPhase = :phase")) {
      if (!exact) fail("ConditionalCheckFailedException");
      const expected = values[":expectedPhase"]?.S;
      const next = values[":phase"]?.S;
      if (current.destroyPhase?.S !== expected && current.destroyPhase?.S !== next) fail("ConditionalCheckFailedException");
      current.destroyPhase = { S: next };
      if (next === "preserving") current.preservationStartedAt = values[":now"];
      mutate("dynamodb:destroy-phase:" + next);
    } else fail("unexpected dynamodb update: " + expression);
    save();
    output({ Attributes: state.lifecycleLockItem });
  } else if (service === "dynamodb" && command === "describe-table") {
    if (!state.lifecycleLockTable) fail("ResourceNotFoundException");
    output({ Table: { TableName: state.lifecycleLockTableName, TableArn: "arn:aws:dynamodb:us-east-1:" + accountId + ":table/" + state.lifecycleLockTableName } });
  } else if (service === "dynamodb" && command === "list-tags-of-resource") {
    output({ Tags: [{ Key: "McAwsProject", Value: "mc-aws" }, { Key: "McAwsStack", Value: "MinecraftStack" }, { Key: "McAwsPurpose", Value: "LifecycleLock" }] });
  } else if (service === "dynamodb" && command === "delete-table") {
    state.lifecycleLockTable = false; mutate("dynamodb:delete-table:" + state.lifecycleLockTableName);
  } else if (service === "dynamodb" && command === "wait") {
    if (state.lifecycleLockTable) fail("WaiterError: table still exists");
  }
  else if (service === "ssm" && command === "send-command") {
    const serialized = args[args.indexOf("--parameters") + 1] || "";
    state.lastSsmCommandFailed = false;
    if (serialized.includes("mc-agent-abort-rollback")) {
      mutate("ssm:pre-preservation-agent-rollback");
      if (
        !serialized.includes("/usr/local/bin/mc-host-operation.py executor-idle") ||
        !serialized.includes("--journal /var/lib/mc-agent-executor/executor-effect-journal.json") ||
        !serialized.includes("--gateway-journal /var/lib/mc-agent-gateway/executor-reconciliations.json")
      ) state.lastSsmCommandFailed = true;
      if (state.activeAgentEffect) state.lastSsmCommandFailed = true;
    } else if (serialized.includes("mc-agent-gateway.service")) {
      mutate("ssm:quiesce-agent-runtime");
      if (
        !serialized.includes("/usr/local/bin/mc-host-operation.py executor-idle") ||
        !serialized.includes("--journal /var/lib/mc-agent-executor/executor-effect-journal.json") ||
        !serialized.includes("--gateway-journal /var/lib/mc-agent-gateway/executor-reconciliations.json")
      ) state.lastSsmCommandFailed = true;
      if (state.activeAgentEffect) state.lastSsmCommandFailed = true;
    } else if (serialized.includes("mc-backup.sh")) {
      mutate("ssm:final-drive-backup");
      for (const attempt of state.delayedAttemptsDuringBackup) {
        const barrier = state.lifecycleLockItem?.action?.S === "destroy" && state.lifecycleLockItem?.agentFenceActive?.BOOL === true && state.lifecycleLockItem?.released?.BOOL !== true;
        if (barrier) mutate("delayed:" + attempt + "-denied-by-destroy-barrier");
        else { state.instanceWriteGeneration += 1; mutate("delayed:" + attempt + "-dispatched"); }
      }
      if (state.finalBackupDelayMs > 0 && process.env.MC_AWS_DESTROY_TEST_MODE !== "1") {
        await new Promise((resolve) => setTimeout(resolve, state.finalBackupDelayMs));
      }
      if (state.finalBackupFails) state.lastSsmCommandFailed = true;
    } else {
      mutate("ssm:quiesce-minecraft");
    }
    if (serialized.includes("rclone.conf")) {
      mutate("ssm:scrub-rclone");
      if (!state.credentialScrubFails) state.rcloneCredentialPresent = false;
      else state.lastSsmCommandFailed = true;
      save();
    }
    save();
    output({ Command: { CommandId: "11111111-2222-4333-8444-555555555555" } });
  } else if (service === "ssm" && command === "wait") {
    if (state.ssmCommandFails || state.lastSsmCommandFailed) fail("WaiterError: command failed");
  } else if (service === "ssm" && command === "get-command-invocation") {
    output({ CommandId: "11111111-2222-4333-8444-555555555555", InstanceId: instanceId, Status: (state.ssmCommandFails || state.lastSsmCommandFailed) ? "Failed" : "Success" });
  }
  else fail("unexpected aws command: " + args.join(" "));
} else if (tool === "wrangler") {
  const joined = args.join(" ");
  if (joined.includes("whoami")) output("Account ID: " + cfAccountId);
  else if (joined.includes("deployments status")) {
    if (state.workerFinalFailure && !state.worker) fail("AccessDenied: code 10000");
    if (!state.worker) fail("Worker API error code " + state.workerNotFoundCode);
    output({ id: state.workerDeployments[0] });
  } else if (joined.includes("kv namespace list")) output(state.kv);
  else if (joined.includes("secret list")) { mutate("wrangler:secret-list"); output(state.secrets.map((name) => ({ name, type: "secret_text" }))); }
  else if (joined.includes("secret delete")) {
    const name = args.at(-1); state.secrets = state.secrets.filter((value) => value !== name); mutate("wrangler:secret-delete:" + name);
  } else if (joined.includes("kv namespace delete")) {
    const id = args[args.indexOf("--namespace-id") + 1]; state.kv = state.kv.filter((item) => item.id !== id); mutate("wrangler:kv-delete:" + id);
  } else if (args.includes("delete")) { state.worker = false; state.secrets = []; mutate("wrangler:worker-delete"); }
  else fail("unexpected wrangler command: " + joined);
} else if (tool === "curl") {
  const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
  const url = args.at(-1); const body = args.includes("--data") ? JSON.parse(args[args.indexOf("--data") + 1]) : undefined;
  const routeMatch = url.match(/\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/);
  const dnsMatch = url.match(/\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
  let status = 200; let response;
  if (routeMatch && method === "GET") {
    state.routeListCount = (state.routeListCount || 0) + 1;
    save();
    const malformed = state.routePaginationMalformed || (state.routePaginationMalformedFinal && state.routeListCount >= 3);
    response = {
    success: true,
    result: state.routes,
    result_info: {
      page: 1,
      per_page: 100,
      total_pages: 1,
       count: malformed ? state.routes.length + 1 : state.routes.length,
       total_count: state.routes.length,
     },
   };
  }
  else if (routeMatch && method === "DELETE") { state.routes = state.routes.filter((item) => item.id !== routeMatch[2]); mutate("cf:route-delete:" + routeMatch[2]); response = { success: true, result: { id: routeMatch[2] } }; }
  else if (routeMatch && method === "PUT") { const route = state.routes.find((item) => item.id === routeMatch[2]); Object.assign(route, body); mutate("cf:route-restore:" + routeMatch[2]); response = { success: true, result: route }; }
  else if (dnsMatch && method === "GET") { const record = state.dns.find((item) => item.id === dnsMatch[2]); if(record) response={success:true,result:record}; else {status=404;response={success:false,errors:[{code:state.dnsMissingCode}]};} }
  else if (dnsMatch && method === "DELETE") { state.dns = state.dns.filter((item) => item.id !== dnsMatch[2]); mutate("cf:dns-delete:" + dnsMatch[2]); response = { success: true, result: { id: dnsMatch[2] } }; }
  else if (dnsMatch && method === "PUT") { const record = state.dns.find((item) => item.id === dnsMatch[2]); Object.assign(record, body); mutate("cf:dns-restore:" + dnsMatch[2]); response = { success: true, result: record }; }
  else fail("unexpected curl request: " + method + " " + url);
  const responsePath = args[args.indexOf("-o") + 1]; fs.writeFileSync(responsePath, JSON.stringify(response)); output(String(status));
} else fail("unknown mock tool");
`;

const mockCliServerSource = (cliPath: string, socketPath: string) => `
import net from "node:net";
const cliUrl = ${JSON.stringify(pathToFileURL(cliPath).href)};
const socketPath = ${JSON.stringify(socketPath)};
class ExitSignal extends Error { constructor(code) { super("exit"); this.code = code; } }
let requestId = 0;

const handle = async (args) => {
  let stdout = "";
  let stderr = "";
  let status = 0;
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.argv = [process.execPath, new URL(cliUrl).pathname, ...args];
  process.stdout.write = (value) => { stdout += String(value); return true; };
  process.stderr.write = (value) => { stderr += String(value); return true; };
  process.exit = (code = 0) => { throw new ExitSignal(code); };
  try {
    await import(cliUrl + "?request=" + requestId++);
  } catch (error) {
    if (error instanceof ExitSignal) status = error.code;
    else { status = 1; stderr += String(error); }
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return [String(status), Buffer.from(stderr).toString("base64"), Buffer.from(stdout).toString("base64")].join("\\n") + "\\n";
};

net.createServer((connection) => {
  const chunks = [];
  let handled = false;
  connection.on("data", async (chunk) => {
    chunks.push(chunk);
    const request = Buffer.concat(chunks).toString();
    if (handled || !request.includes("\\0\\0")) return;
    handled = true;
    connection.end(await handle(request.split("\\0").filter(Boolean)));
  });
}).listen(socketPath);
`;

function makeHarness(
  overrides?: Partial<MockState>,
  manifestOverride?: (manifest: ReturnType<typeof baseManifest>) => void,
  options: { mode?: number; symlink?: boolean } = {}
) {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-destroy-"));
  temporaryDirectories.push(directory);
  const statePath = path.join(directory, "state.json");
  const manifestPath = path.join(directory, "manifest.json");
  const actualManifestPath = options.symlink ? path.join(directory, "manifest-target.json") : manifestPath;
  const envPath = path.join(directory, ".env.production");
  const cliPath = path.join(directory, "mock-cli.mjs");
  const mockCliServerPath = path.join(directory, "mock-cli-server.mjs");
  const mockCliSocketPath = path.join(directory, "mock-cli.sock");
  const heartbeatPidPath = path.join(directory, "heartbeat.pid");
  const state = { ...baseState(), ...overrides };
  const manifest = baseManifest();
  manifestOverride?.(manifest);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(actualManifestPath, JSON.stringify(manifest, null, 2), { mode: options.mode ?? 0o600 });
  chmodSync(actualManifestPath, options.mode ?? 0o600);
  if (options.symlink) symlinkSync(actualManifestPath, manifestPath);
  writeFileSync(envPath, "CLOUDFLARE_TEARDOWN_API_TOKEN=test-token\n");
  writeFileSync(cliPath, mockCliSource.replace("__STATE_PATH__", statePath));
  writeFileSync(mockCliServerPath, mockCliServerSource(cliPath, mockCliSocketPath));
  mockCliServers.push(spawn(process.execPath, [mockCliServerPath], { stdio: ["ignore", "inherit", "inherit"] }));

  const tools: Record<string, string> = {};
  for (const tool of ["aws", "wrangler", "curl"]) {
    const wrapperPath = path.join(directory, tool);
    writeFileSync(
      wrapperPath,
      `#!/bin/sh
set -eu
i=0
while [ ! -S ${JSON.stringify(mockCliSocketPath)} ] && [ "$i" -lt 100 ]; do
  sleep 0.01
  i=$((i + 1))
done
{
  printf '%s\\0' ${JSON.stringify(tool)}
  for arg in "$@"; do printf '%s\\0' "$arg"; done
  printf '\\0'
} | nc -U ${JSON.stringify(mockCliSocketPath)} | {
  IFS= read -r status
  IFS= read -r stderr_b64
  IFS= read -r stdout_b64
  printf '%s' "$stderr_b64" | base64 -d >&2
  printf '%s' "$stdout_b64" | base64 -d
  exit "$status"
}
`,
      { mode: 0o755 }
    );
    tools[tool] = wrapperPath;
  }
  const run = async (args: string[] = [], input = "", envOverrides: Record<string, string> = {}) => {
    const release = await destroyProcessSemaphore.acquire();
    try {
      return await new Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          "bash",
          [path.join(rootDir, "scripts/operations/destroy.sh"), "--manifest", manifestPath, ...args],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              AWS_CLI: tools.aws,
              WRANGLER_BIN: tools.wrangler,
              CURL_BIN: tools.curl,
              ENV_FILE: envPath,
              WRANGLER_HOME_DIR: directory,
              MC_AWS_DESTROY_TEST_MODE: "1",
              MC_AWS_DESTROY_HEARTBEAT_PID_FILE: heartbeatPidPath,
              NODE_BIN: process.execPath,
              ...envOverrides,
            },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        activeDestroyProcesses.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          activeDestroyProcesses.delete(child);
          reject(error);
        });
        child.once("close", (status, signal) => {
          activeDestroyProcesses.delete(child);
          resolve({ status, signal, stdout, stderr });
        });
        child.stdin?.end(input);
      });
    } finally {
      release();
    }
  };
  return {
    run,
    manifestPath,
    heartbeatPidPath,
    readState: () => JSON.parse(readFileSync(statePath, "utf8")) as MockState,
    updateState: (update: Partial<MockState>) => {
      const current = JSON.parse(readFileSync(statePath, "utf8")) as MockState;
      writeFileSync(statePath, JSON.stringify({ ...current, ...update }, null, 2));
    },
    readManifest: () => JSON.parse(readFileSync(actualManifestPath, "utf8")) as Record<string, unknown>,
  };
}

afterAll(() => {
  for (const child of activeDestroyProcesses) child.kill("SIGTERM");
  activeDestroyProcesses.clear();
  for (const server of mockCliServers.splice(0)) server.kill("SIGTERM");
  for (const directory of temporaryDirectories.splice(0)) {
    const heartbeatPath = path.join(directory, "heartbeat.pid");
    try {
      const heartbeatPid = Number(readFileSync(heartbeatPath, "utf8"));
      if (Number.isInteger(heartbeatPid) && heartbeatPid > 1) {
        try {
          process.kill(-heartbeatPid, "SIGTERM");
        } catch {
          /* already stopped */
        }
        try {
          process.kill(heartbeatPid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    } catch {
      /* no worker was started */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

const standardConfirmation = `destroy MinecraftStack in ${accountId}/us-east-1\n`;
const driveConfirmation = `drive backup directly verified for ${stackId}\n`;
const recoveryCapsuleConfirmation = `delete authenticated recovery capsule for ${stackId}\n`;
const confirmation = `${standardConfirmation}${driveConfirmation}`;

function expectProcessStopped(pidPath: string): void {
  const workerPid = Number(readFileSync(pidPath, "utf8"));
  let workerAlive = true;
  try {
    process.kill(workerPid, 0);
  } catch {
    workerAlive = false;
  }
  expect(workerAlive).toBe(false);
}

describe("ownership-aware destroy", { timeout: 60_000 }, () => {
  it("defaults to live dry-run with no mutation", async () => {
    const harness = makeHarness();
    const result = await harness.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DRY RUN (default)");
    expect(result.stdout).toContain("/minecraft/gdrive-token [SecureString; credential; ownership=unproven;");
    expect(result.stdout).toContain("/minecraft/email-allowlist [String; pii; ownership=unproven;");
    expect(result.stdout).toContain(
      "/minecraft/last-scheduled-backup-success [String; runtime-state; ownership=unproven;"
    );
    expect(result.stdout).toContain(
      "/minecraft/scheduled-backup-enabled-at [String; runtime-state; ownership=unproven;"
    );
    expect(result.stdout).toContain(
      "/minecraft/operations/email-0123456789abcdef0123456789abcdef01234567 [String; pii; ownership=unproven;"
    );
    expect(result.stdout).toContain(
      "/minecraft/operations/email-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee [String; pii; ownership=unproven;"
    );
    expect(result.stdout).toContain("/minecraft/server-action-delete-claim/current [String; pii; ownership=unproven;");
    expect(result.stdout).toContain(
      "/minecraft/server-action-delete-claim/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee [String; pii; ownership=unproven;"
    );
    expect(harness.readState().mutations).toEqual([]);
  });

  it("defaults execution to Google Drive evidence without retaining a new EBS snapshot", async () => {
    const harness = makeHarness();
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Data preservation:    google-drive");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
    expect(harness.readState().mutations).toContain(`cloudformation:stack-deleted:${stackId}`);
    expect(harness.readState().mutations).not.toContain("ssm:delete-parameter:/minecraft/gdrive-token");
    expect(harness.readState().ssmParameters).toEqual(baseState().ssmParameters);
    expect(result.stdout).toContain("Security residual: preserved");
    expect((harness.readManifest().teardown as Record<string, unknown>).finalGoogleDriveBackup).toMatchObject({
      backupName: expect.stringMatching(/^final-destroy-[a-f0-9]{12}\.tar\.gz$/),
      operationId: expect.stringMatching(/^destroy-/),
    });
    expectProcessStopped(harness.heartbeatPidPath);
  }, 20_000);

  it("retains only the Drive credential when explicitly requested for migration", async () => {
    const harness = makeHarness();
    const result = await harness.run(["--execute", "--retain-gdrive-token-for-migration"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().ssmParameters).toEqual(baseState().ssmParameters);
    expect(result.stdout).toContain("Security residual: retained credential /minecraft/gdrive-token");
  }, 20_000);

  it("allows the migration flag to retain a legacy ownership-unproven Drive credential", async () => {
    const harness = makeHarness(undefined, (manifest) => {
      manifest.aws.ssmParameters = manifest.aws.ssmParameters.filter(
        (parameter) => parameter.name !== "/minecraft/gdrive-token"
      );
    });
    const result = await harness.run(["--retain-gdrive-token-for-migration"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "/minecraft/gdrive-token [SecureString; credential; ownership=unproven; evidence=none] => retain-for-migration"
    );
    expect(harness.readState().mutations).toEqual([]);
  });

  it("preserves and blocks on an SSM path outside the exact project allowlist", async () => {
    const harness = makeHarness({
      ssmParameters: {
        ...baseState().ssmParameters,
        "/minecraft/unreviewed-secret": { type: "SecureString", value: "do-not-delete" },
      },
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ownership is not proven");
    expect(harness.readState().mutations).toEqual([]);
    expect(harness.readState().ssmParameters["/minecraft/unreviewed-secret"]).toBeDefined();
  });

  it("requires installation ownership or exact-name consent for familiar SSM credentials", async () => {
    const removeOwnership = (manifest: ReturnType<typeof baseManifest>) => {
      manifest.aws.ssmParameters = [];
    };
    const unproven = makeHarness(
      { ssmParameters: { "/minecraft/gdrive-token": baseState().ssmParameters["/minecraft/gdrive-token"] } },
      removeOwnership
    );
    const blocked = await unproven.run();
    expect(blocked.status).toBe(0);
    expect(blocked.stderr).not.toContain("ownership is not proven");
    expect(blocked.stdout).toContain("ownership=unproven");

    const consented = makeHarness(
      { ssmParameters: { "/minecraft/gdrive-token": baseState().ssmParameters["/minecraft/gdrive-token"] } },
      removeOwnership
    );
    const allowedDryRun = await consented.run(["--consent-delete-ssm", "/minecraft/gdrive-token"]);
    expect(allowedDryRun.status, `${allowedDryRun.stdout}\n${allowedDryRun.stderr}`).toBe(0);
    expect(allowedDryRun.stdout).toContain("manual-review-consented");
    expect(consented.readState().mutations).toEqual([]);
  }, 20_000);

  it("classifies backup state and identity exactly, and cleans it after authenticated preservation", async () => {
    const harness = makeHarness(
      { ssmParameters: { ...baseState().ssmParameters, ...backupStateParameters } },
      addBackupStateFacts
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "/minecraft/backup-generation-checkpoint [String; backup-state; ownership=unproven; evidence=setup-preflight] => preserve-recovery-capsule (policy=retain-until-explicit-consent)"
    );
    expect(result.stdout).toContain(
      "/minecraft/restore-generation-floor [String; backup-state; ownership=unproven; evidence=setup-preflight] => preserve-recovery-capsule (policy=retain-until-explicit-consent)"
    );
    expect(result.stdout).toContain(
      "/minecraft/backup-server-identity [String; backup-identity; ownership=unproven; evidence=setup-preflight] => preserve-recovery-capsule (policy=retain-until-explicit-consent)"
    );
    expect(result.stdout).toContain(
      "/minecraft/backup-auth-keyring [SecureString; credential; ownership=unproven; evidence=setup-preflight] => preserve-recovery-capsule (policy=retain-until-explicit-consent)"
    );

    const mutations = harness.readState().mutations;
    const finalBackup = mutations.indexOf("ssm:final-drive-backup");
    const stackDelete = mutations.indexOf(`cloudformation:stack-deleted:${stackId}`);
    expect(finalBackup).toBeGreaterThanOrEqual(0);
    expect(stackDelete).toBeGreaterThan(finalBackup);
    for (const name of [
      "/minecraft/backup-generation-checkpoint",
      "/minecraft/restore-generation-floor",
      "/minecraft/backup-server-identity",
      "/minecraft/backup-auth-keyring",
    ]) {
      expect(mutations).not.toContain(`ssm:delete-parameter:${name}`);
      expect(harness.readState().ssmParameters[name]).toBeDefined();
    }
    expect((harness.readManifest().teardown as Record<string, unknown>).recoveryCapsule).toMatchObject({
      status: "preserved",
      checkpointGeneration: 0,
      floorGeneration: 0,
    });
  }, 25_000);

  it("does not let exact-name consent delete an unknown backup lookalike", async () => {
    const lookalike = "/minecraft/backup-generation-checkpoint-copy";
    const harness = makeHarness({
      ssmParameters: { ...baseState().ssmParameters, [lookalike]: { type: "String", value: "do-not-delete" } },
    });
    const result = await harness.run(["--consent-delete-ssm", lookalike]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${lookalike} [String; unclassified; ownership=unproven; evidence=none]`);
    expect(result.stdout).toContain("=> preserve-unclassified");
    expect(result.stderr).toContain("ownership is not proven");
    expect(harness.readState().mutations).toEqual([]);
    expect(harness.readState().ssmParameters[lookalike]).toBeDefined();
  });

  it("allows exact consent to dispose of the owned backup-auth keyring after stack deletion", async () => {
    const harness = makeHarness(
      { ssmParameters: { ...baseState().ssmParameters, ...backupStateParameters } },
      addBackupStateFacts
    );
    const result = await harness.run(
      [
        "--execute",
        "--consent-delete-ssm",
        "/minecraft/backup-auth-keyring",
        "--consent-delete-ssm",
        "/minecraft/backup-server-identity",
        "--consent-delete-ssm",
        "/minecraft/backup-generation-checkpoint",
        "--consent-delete-ssm",
        "/minecraft/restore-generation-floor",
        "--consent-delete-ssm",
        "/minecraft/backup-verifier-metadata",
        "--consent-delete-ssm",
        "/minecraft/backup-recovery-adoption-lock",
      ],
      confirmation + recoveryCapsuleConfirmation
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const mutations = harness.readState().mutations;
    expect(mutations.indexOf("ssm:final-drive-backup")).toBeLessThan(
      mutations.indexOf(`cloudformation:stack-deleted:${stackId}`)
    );
    expect(mutations).not.toContain("ssm:delete-parameter:/minecraft/backup-auth-keyring");
    expect(harness.readState().ssmParameters["/minecraft/backup-auth-keyring"]).toBeDefined();
    expect(harness.readState().ssmParameters["/minecraft/backup-server-identity"]).toBeDefined();
  }, 25_000);

  it("preserves owned recovery-capsule state on an absent-stack rerun after recorded preservation", async () => {
    const harness = makeHarness(
      {
        stack: false,
        rootVolume: false,
        volumes: [],
        ssmParameters: { ...baseState().ssmParameters, ...backupStateParameters },
      },
      (manifest) => {
        addBackupStateFacts(manifest);
        manifest.teardown.completedResources = ["final-data-preservation"];
        manifest.teardown.googleDriveBackupEvidence = {
          parameterName: "/minecraft/backups-cache",
          backupCount: 1,
          cacheCachedAt: Date.now(),
          observedAt: "2026-09-04T00:00:00Z",
        };
      }
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
    for (const name of [
      "/minecraft/backup-generation-checkpoint",
      "/minecraft/restore-generation-floor",
      "/minecraft/backup-server-identity",
    ]) {
      expect(harness.readState().ssmParameters[name]).toBeDefined();
    }
    expect(harness.readState().ssmParameters["/minecraft/backup-auth-keyring"]).toBeDefined();
  }, 25_000);

  it("migrates exact native stack-resource identity without inferring custom/runtime ownership", async () => {
    const parameterName = "/minecraft/server-profile-manifest";
    const harness = makeHarness(
      {
        stackSsmParameters: [parameterName],
        ssmParameters: { [parameterName]: { type: "String", value: "profile" } },
      },
      (manifest) => {
        manifest.aws.ssmParameters = [];
      }
    );
    const result = await harness.run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `${parameterName} [String; runtime-state; ownership=unproven; evidence=exact-stack-resource] => manual-review-unproven`
    );
  });

  it("classifies legacy GitHub parameters and blocks while live user data depends on them", async () => {
    const githubPat = { type: "SecureString" as const, value: "legacy-pat" };
    const harness = makeHarness(
      {
        instanceUserData: "#!/bin/bash\naws ssm get-parameter --name /minecraft/github-pat\n",
        ssmParameters: { ...baseState().ssmParameters, "/minecraft/github-pat": githubPat },
      },
      (manifest) => {
        manifest.aws.ssmParameters.push({
          name: "/minecraft/github-pat",
          type: "SecureString",
          createdByProject: true,
          ownership: "created",
          observedBeforeSetup: "absent",
          source: "setup-preflight",
        });
      }
    );
    const result = await harness.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("legacy-credential");
    expect(result.stdout).toContain("revoke the PAT in GitHub");
    expect(result.stderr).toContain("user data still depends on legacy GitHub SSM parameters");
  });

  it("blocks absent-stack cleanup without durable preservation or a second exact confirmation", async () => {
    const blocked = makeHarness({ stack: false, rootVolume: false, volumes: [] });
    const dryRun = await blocked.run();
    expect(dryRun.status).not.toBe(0);
    expect(dryRun.stderr).toContain("no durable final-data-preservation record exists");

    const confirmed = makeHarness({ stack: false, rootVolume: false, volumes: [] });
    const dataPhrase = `data preservation independently verified for ${stackId}\n`;
    const result = await confirmed.run(
      ["--execute", "--confirm-absent-stack-data"],
      `${standardConfirmation}${dataPhrase}`
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 20_000);

  it.each([
    "/minecraft/operations/email-not-a-hash",
    "/minecraft/operations/start-1769000000000-not-a-uuid",
    "/minecraft/server-action-delete-claim/not-a-uuid",
    "/minecraft/server-action-delete-claim/current/extra",
  ])("rejects malformed runtime path %s", async (parameterName) => {
    const harness = makeHarness({
      ssmParameters: {
        ...baseState().ssmParameters,
        [parameterName]: { type: "String", value: "preserve" },
      },
    });
    const result = await harness.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `ownership is not proven; preserve it or pass explicit exact-name consent: ${parameterName}`
    );
    expect(harness.readState().mutations).toEqual([]);
  });

  it("passes backup preservation before Cloudflare, KV, DNS, DLM, and IAM cleanup", async () => {
    const policyId = "policy-aaaaaaaa";
    const harness = makeHarness(
      {
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "mc-aws-panel" }],
        dns: [{ id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", ttl: 1, proxied: true }],
        dlm: [{ PolicyId: policyId, Tags: { McAwsProject: "mc-aws", McAwsStack: "MinecraftStack" } }],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.routes = [
          {
            zoneId,
            id: routeId,
            pattern: "panel.example.com/*",
            script: "mc-aws-panel",
            createdByProject: true,
            ownershipProven: true,
            ownership: "created",
            originalScript: "",
          },
        ];
        manifest.cloudflare.panelDnsRecords = [
          {
            zoneId,
            id: dnsId,
            name: "panel.example.com",
            type: "A",
            content: "192.0.2.1",
            applied: { ttl: 1, proxied: true },
            createdByProject: true,
            modifiedByProject: false,
            ownership: "created",
          },
        ];
        manifest.aws.dlmPolicies = [
          {
            id: policyId,
            createdByProject: true,
            ownership: "created",
            expectedTags: { McAwsProject: "mc-aws", McAwsStack: "MinecraftStack" },
          },
        ];
      }
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const mutations = harness.readState().mutations;
    const gateIndex = mutations.indexOf("ssm:final-drive-backup");
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    for (const irreversible of [
      `cf:route-delete:${routeId}`,
      "wrangler:worker-delete",
      `wrangler:kv-delete:${kvId}`,
      `cf:dns-delete:${dnsId}`,
      `dlm:delete:${policyId}`,
      "iam:delete-key:AKIAOWNEDRUNTIMEKEY",
    ]) {
      expect(mutations.indexOf(irreversible), irreversible).toBeGreaterThan(gateIndex);
    }
  }, 25_000);

  it("accepts exact DELETE_COMPLETE stack history and current Wrangler 10007 Worker absence", async () => {
    const harness = makeHarness({ deletedStackDescribable: true, workerNotFoundCode: 10007 });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("DELETE_COMPLETE (retained API history only)");
  }, 20_000);

  it("creates, waits for, verifies, and records a final root snapshot before exact StackId deletion", async () => {
    const harness = makeHarness({ instanceState: "running" });
    const result = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const state = harness.readState();
    expect(state.rcloneCredentialPresent).toBe(false);
    expect(state.serverDataPresent).toBe(true);
    expect(state.mutations.indexOf("ssm:scrub-rclone")).toBeLessThan(
      state.mutations.indexOf(`ec2:create-snapshot:${snapshotId}`)
    );
    expect(state.mutations).toContain(`ec2:create-snapshot:${snapshotId}`);
    expect(state.mutations.indexOf(`ec2:create-snapshot:${snapshotId}`)).toBeLessThan(
      state.mutations.findIndex((entry) => entry === `cloudformation:delete-stack:${stackId}`)
    );
    expect(state.mutations).toContain(`cloudformation:stack-deleted:${stackId}`);
    expect(result.stdout).toContain("root volume itself is NOT retained");
    expect((harness.readManifest().teardown as Record<string, unknown>).finalRootSnapshot).toMatchObject({
      snapshotId,
      sourceVolumeId: volumeId,
      state: "completed",
    });
  }, 20_000);

  it("aborts snapshot creation when reusable credential scrubbing fails", async () => {
    const harness = makeHarness({ instanceState: "running", credentialScrubFails: true });
    const result = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(result.status).not.toBe(0);
    expect(harness.readState().rcloneCredentialPresent).toBe(true);
    expect(harness.readState().serverDataPresent).toBe(true);
    expect(harness.readState().mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
  }, 20_000);

  it("refuses to snapshot an already-stopped root without durable scrub evidence", async () => {
    const harness = makeHarness();
    const result = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no durable credential-scrub evidence");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
  });

  it("blocks stack deletion when final snapshot creation fails", async () => {
    const harness = makeHarness({ instanceState: "running", snapshotCreateFails: true });
    const result = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("blocking CloudFormation stack deletion");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
  }, 20_000);

  it.each(["running", "pending"])(
    "quiesces Minecraft and stops a %s instance before creating the snapshot",
    async (state) => {
      const harness = makeHarness({ instanceState: state });
      const result = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const mutations = harness.readState().mutations;
      const quiesceIndex = mutations.indexOf("ssm:quiesce-minecraft");
      const stopIndex = mutations.indexOf(`ec2:stop-instance:${instanceId}`);
      const stoppedIndex = mutations.indexOf("ec2:instance-stopped");
      const snapshotIndex = mutations.indexOf(`ec2:create-snapshot:${snapshotId}`);
      expect(quiesceIndex).toBeGreaterThanOrEqual(0);
      expect(quiesceIndex).toBeLessThan(stopIndex);
      expect(stopIndex).toBeLessThan(stoppedIndex);
      expect(stoppedIndex).toBeLessThan(snapshotIndex);
      expect(harness.readState().instanceState).toBe("stopped");
    },
    25_000
  );

  it.each([
    ["SSM quiesce", { ssmCommandFails: true }, "agent quiescence command did not reach successful completion"],
    ["EC2 stop", { stopInstanceFails: true }, "EC2 stop request failed"],
    ["EC2 stop waiter", { stopWaitFails: true }, "did not reach stopped state"],
  ])(
    "blocks snapshot and stack deletion when %s fails",
    async (_label, override, expectedError) => {
      const harness = makeHarness({ instanceState: "running", ...override });
      const result = await harness.run(["--execute"], confirmation);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      const mutations = harness.readState().mutations;
      expect(mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
      expect(mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
    },
    25_000
  );

  it("resumes a failed snapshot wait without creating a duplicate snapshot", async () => {
    const harness = makeHarness({ instanceState: "running", snapshotWaitFails: true });
    const first = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(first.status).not.toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toHaveLength(1);
    expect((harness.readManifest().teardown as Record<string, unknown>).pendingFinalRootSnapshot).toMatchObject({
      snapshotId,
      sourceVolumeId: volumeId,
      state: "pending",
    });
    harness.updateState({ snapshotWaitFails: false });
    const retry = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toHaveLength(1);
    const teardown = harness.readManifest().teardown as Record<string, unknown>;
    expect(teardown.pendingFinalRootSnapshot).toBeUndefined();
    expect(teardown.finalRootSnapshot).toMatchObject({ snapshotId, state: "completed" });
  }, 30_000);

  it("requires exact terminal hibernation evidence when no root volume is attached", async () => {
    const harness = makeHarness({
      rootVolume: false,
      volumes: [],
      hibernateOperations: [],
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No exact durable terminal hibernation transaction");
    expect(harness.readState().mutations.at(-1)).toBe("dynamodb:read-hibernate-evidence");
    expect(harness.readState().mutations).not.toContain(`cloudformation:delete-stack:${stackId}`);

    const malformedEvidence = hibernateOperation();
    malformedEvidence.hibernateQuiescenceEvidence = {
      ...malformedEvidence.hibernateQuiescenceEvidence,
      rootVolumeId: `vol-${"9".repeat(17)}`,
    };
    const invalidTransaction = makeHarness({
      rootVolume: false,
      volumes: [],
      hibernateOperations: [malformedEvidence],
    });
    const invalidResult = await invalidTransaction.run(["--execute"], confirmation);
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stderr).toContain("No exact durable terminal hibernation transaction");
  }, 20_000);

  it("rejects fresh cache data without terminal transaction evidence and missing direct Drive confirmation", async () => {
    const cacheOnly = makeHarness({
      rootVolume: false,
      volumes: [],
      backupCache: { backups: [{ name: "fresh-but-unbound" }], cachedAt: Date.now() },
      hibernateOperations: [],
    });
    const cacheOnlyResult = await cacheOnly.run(["--execute"], confirmation);
    expect(cacheOnlyResult.status).not.toBe(0);
    expect(cacheOnlyResult.stderr).toContain("No exact durable terminal hibernation transaction");
    expect(cacheOnly.readState().mutations).not.toContain("ssm:read-backup-evidence");
    expect(cacheOnly.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(
      false
    );

    const unconfirmed = makeHarness();
    const unconfirmedResult = await unconfirmed.run(["--execute"], standardConfirmation);
    expect(unconfirmedResult.status).not.toBe(0);
    expect(unconfirmedResult.stderr).toContain("Direct Google Drive verification confirmation did not match");
    expect(unconfirmed.readState().mutations).toEqual([]);
  }, 20_000);

  it("records exact terminal transaction evidence when hibernated and performs no EBS snapshot", async () => {
    const harness = makeHarness({ rootVolume: false, volumes: [] });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
    expect((harness.readManifest().teardown as Record<string, unknown>).hibernatedBackupEvidence).toMatchObject({
      operationId: hibernateOperationId,
      sourceVolumeId: volumeId,
      backupName: "backup-before-hibernate.tar.gz",
      backupId: "d".repeat(32),
      backupDigest: "a".repeat(64),
      backupSize: 4096,
      backupGeneration: 7,
      serverId: stackId,
    });
  }, 20_000);

  it("deletes an exact detached reconstructed root only after Drive evidence", async () => {
    const detached = {
      VolumeId: volumeId,
      State: "available",
      Attachments: [],
      Tags: [
        { Key: "McAwsProject", Value: "mc-aws" },
        { Key: "McAwsStack", Value: "MinecraftStack" },
        { Key: "McAwsManagedRoot", Value: "true" },
        { Key: "McAwsInstanceId", Value: instanceId },
      ],
    };
    const harness = makeHarness({ rootVolume: false, volumes: [detached] });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const mutations = harness.readState().mutations;
    expect(mutations.indexOf("dynamodb:read-hibernate-evidence")).toBeLessThan(
      mutations.indexOf(`ec2:delete-volume:${volumeId}`)
    );
  }, 20_000);

  it("deletes an exactly identified legacy retained lifecycle lock table only after stack deletion", async () => {
    const tableName = "MinecraftStack-LifecycleLockTable-ABC123";
    const harness = makeHarness({
      lifecycleLockTableName: tableName,
      lifecycleLockTable: true,
      lifecycleLockRetainedOnStackDelete: true,
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const mutations = harness.readState().mutations;
    expect(mutations.indexOf(`cloudformation:stack-deleted:${stackId}`)).toBeLessThan(
      mutations.indexOf(`dynamodb:delete-table:${tableName}`)
    );
    expect(harness.readState().lifecycleLockTable).toBe(false);
  }, 20_000);

  it("blocks an ambiguous detached root and refuses offline snapshot scrubbing", async () => {
    const detached = {
      VolumeId: volumeId,
      State: "available",
      Attachments: [],
      Tags: [
        { Key: "McAwsProject", Value: "mc-aws" },
        { Key: "McAwsStack", Value: "MinecraftStack" },
        { Key: "McAwsManagedRoot", Value: "true" },
      ],
    };
    const ambiguous = makeHarness({ rootVolume: false, volumes: [detached] });
    expect((await ambiguous.run()).stderr).toContain("detached managed root volume candidates are ambiguous");

    const exact = makeHarness({
      rootVolume: false,
      volumes: [{ ...detached, Tags: [...detached.Tags, { Key: "McAwsInstanceId", Value: instanceId }] }],
    });
    const result = await exact.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be credential-scrubbed offline");
  }, 15_000);

  it("accepts exact HTTP 404/81044 DNS absence but rejects other 404 bodies", async () => {
    const addOwnedDns = (manifest: ReturnType<typeof baseManifest>) => {
      manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
      manifest.cloudflare.panelDnsRecords = [
        {
          zoneId,
          id: dnsId,
          name: "panel.example.com",
          type: "A",
          content: "192.0.2.1",
          applied: { ttl: 1, proxied: true },
          createdByProject: true,
          modifiedByProject: false,
          ownership: "created",
        },
      ];
    };
    expect((await makeHarness({}, addOwnedDns).run()).status).toBe(0);
    const rejected = await makeHarness({ dnsMissingCode: 10000 }, addOwnedDns).run();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("unexpected error");
  }, 15_000);

  it("deletes exact owned route and DNS identities", async () => {
    const harness = makeHarness(
      {
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "mc-aws-panel" }],
        dns: [{ id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", ttl: 1, proxied: true }],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.routes = [
          {
            zoneId,
            id: routeId,
            pattern: "panel.example.com/*",
            script: "mc-aws-panel",
            createdByProject: true,
            ownershipProven: true,
            ownership: "created",
            originalScript: "",
          },
        ];
        manifest.cloudflare.panelDnsRecords = [
          {
            zoneId,
            id: dnsId,
            name: "panel.example.com",
            type: "A",
            content: "192.0.2.1",
            applied: { ttl: 1, proxied: true },
            createdByProject: true,
            modifiedByProject: false,
            ownership: "created",
          },
        ];
      }
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations).toEqual(
      expect.arrayContaining([`cf:route-delete:${routeId}`, `cf:dns-delete:${dnsId}`])
    );
    const mutations = harness.readState().mutations;
    expect(mutations.indexOf(`cf:route-delete:${routeId}`)).toBeLessThan(mutations.indexOf("wrangler:worker-delete"));
    expect(mutations.some((entry) => entry.startsWith("wrangler:secret-"))).toBe(false);
  }, 20_000);

  it("blocks owned DNS teardown when the canonical TTL identity changes", async () => {
    const harness = makeHarness(
      {
        dns: [
          { id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", ttl: 60, proxied: true },
        ],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.panelDnsRecords = [
          {
            zoneId,
            id: dnsId,
            name: "panel.example.com",
            type: "A",
            content: "192.0.2.1",
            applied: { ttl: 1, proxied: true },
            createdByProject: true,
            modifiedByProject: false,
            ownership: "created",
          },
        ];
      }
    );
    const result = await harness.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer matches its manifest identity");
    expect(harness.readState().mutations).toEqual([]);
  }, 20_000);

  it("refuses route teardown when the provider inventory pagination is incomplete", async () => {
    const harness = makeHarness(
      {
        routePaginationMalformed: true,
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "mc-aws-panel" }],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.routes = [
          {
            zoneId,
            id: routeId,
            pattern: "panel.example.com/*",
            script: "mc-aws-panel",
            createdByProject: true,
            ownershipProven: true,
            ownership: "created",
            originalScript: "",
          },
        ];
      }
    );
    const result = await harness.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("incomplete pagination metadata");
    expect(harness.readState().mutations).toEqual([]);
  }, 20_000);

  it("fails closed when final route absence verification has incomplete pagination", async () => {
    const harness = makeHarness(
      {
        routePaginationMalformedFinal: true,
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "mc-aws-panel" }],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.routes = [
          {
            zoneId,
            id: routeId,
            pattern: "panel.example.com/*",
            script: "mc-aws-panel",
            createdByProject: true,
            ownershipProven: true,
            ownership: "created",
            originalScript: "",
          },
        ];
      }
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pagination");
  }, 20_000);

  it("refuses empty-ID route ownership records before provider mutation", async () => {
    const harness = makeHarness({}, (manifest) => {
      manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
      manifest.cloudflare.routes = [
        {
          zoneId,
          id: "",
          pattern: "panel.example.com/*",
          script: "mc-aws-panel",
          createdByProject: true,
          ownershipProven: true,
          ownership: "created",
          originalScript: "",
        },
      ];
    });
    const result = await harness.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("id is required");
    expect(harness.readState().mutations).toEqual([]);
  }, 20_000);

  it("blocks a replaced pre-existing route ID and preserves changed pre-existing DNS", async () => {
    const addPreexistingResources = (manifest: ReturnType<typeof baseManifest>) => {
      manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
      manifest.cloudflare.routes = [
        {
          zoneId,
          id: routeId,
          pattern: "panel.example.com/*",
          script: "mc-aws-panel",
          createdByProject: false,
          ownershipProven: true,
          ownership: "preexisting",
          originalScript: "old-worker",
        },
      ];
      manifest.cloudflare.panelDnsRecords = [
        {
          zoneId,
          id: dnsId,
          name: "panel.example.com",
          type: "A",
          content: "192.0.2.1",
          applied: { ttl: 1, proxied: true },
          createdByProject: false,
          modifiedByProject: true,
          ownership: "preexisting",
          original: { proxied: false, ttl: 300 },
        },
      ];
    };

    const replacedRoute = makeHarness(
      {
        routes: [{ id: "f".repeat(32), pattern: "panel.example.com/*", script: "mc-aws-panel" }],
        dns: [{ id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", ttl: 1, proxied: true }],
      },
      addPreexistingResources
    );
    const blocked = await replacedRoute.run();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("live ID differs");

    const changedDns = makeHarness(
      {
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "old-worker" }],
        dns: [
          {
            id: dnsId,
            zoneId,
            type: "A",
            name: "panel.example.com",
            content: "198.51.100.1",
            ttl: 1,
            proxied: true,
          },
        ],
      },
      addPreexistingResources
    );
    const preserved = await changedDns.run(["--execute"], confirmation);
    expect(preserved.status, `${preserved.stdout}\n${preserved.stderr}`).toBe(0);
    expect(preserved.stdout).toContain("Preserved changed pre-existing DNS record");
    expect(changedDns.readState().mutations).not.toContain(`cf:dns-restore:${dnsId}`);
  }, 25_000);

  it("restores and re-verifies the exact proxy state of a project-modified pre-existing DNS record", async () => {
    const harness = makeHarness(
      {
        dns: [{ id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", ttl: 1, proxied: true }],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.panelDnsRecords = [
          {
            zoneId,
            id: dnsId,
            name: "panel.example.com",
            type: "A",
            content: "192.0.2.1",
            applied: { ttl: 1, proxied: true },
            createdByProject: false,
            modifiedByProject: true,
            ownership: "preexisting",
            original: { proxied: false, ttl: 300 },
          },
        ];
      }
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations).toContain(`cf:dns-restore:${dnsId}`);
    expect(harness.readState().dns.find((record) => record.id === dnsId)?.proxied).toBe(false);
    expect(harness.readState().dns.find((record) => record.id === dnsId)?.ttl).toBe(300);
  }, 25_000);

  it("rejects stale Worker deployment and same-name replacement stack identities", async () => {
    const worker = await makeHarness({ workerDeployments: [replacementDeploymentId] }).run();
    expect(worker.status).not.toBe(0);
    expect(worker.stderr).toContain("live Worker deployment identity");
    const stack = await makeHarness({ stackId: replacementStackId }).run();
    expect(stack.status).not.toBe(0);
    expect(stack.stderr).toContain("stack ID does not match");
  }, 15_000);

  it("revalidates IAM tags and exact stack identity before destructive AWS mutations", async () => {
    const iamHarness = makeHarness({ changeIamTagsAfterInventory: true });
    const iamResult = await iamHarness.run(["--execute"], confirmation);
    expect(iamResult.status).not.toBe(0);
    expect(iamResult.stderr).toContain("before final data preservation");
    expect(iamHarness.readState().mutations.some((entry) => entry.startsWith("iam:"))).toBe(false);

    const stackHarness = makeHarness({ replaceStackAfterInventory: true });
    const stackResult = await stackHarness.run(["--execute"], confirmation);
    expect(stackResult.status).not.toBe(0);
    expect(stackHarness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(
      false
    );
  }, 30_000);

  it("treats final provider AccessDenied as failure, not absence", async () => {
    const harness = makeHarness({ workerFinalFailure: true });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}\n${JSON.stringify(harness.readState())}`).not.toBe(0);
    expect(result.stderr).toContain("Worker could not be verified absent");
    const stackHarness = makeHarness({ stackFinalFailure: true });
    const stackResult = await stackHarness.run(["--execute"], confirmation);
    expect(stackResult.status).not.toBe(0);
    expect(stackResult.stderr).toContain("stack absence could not be verified");
  }, 30_000);

  it("rejects malformed, wrong-mode, and symlink manifests before inventory", async () => {
    const malformed = makeHarness({}, (manifest) => Object.assign(manifest, { unexpected: true }));
    expect((await malformed.run()).stderr).toContain("Manifest validation failed");
    const wrongMode = makeHarness({}, undefined, { mode: 0o644 });
    expect((await wrongMode.run()).stderr).toContain("Manifest validation failed");
    const symlink = makeHarness({}, undefined, { symlink: true });
    expect((await symlink.run()).stderr).toContain("Manifest validation failed");
  });

  it("retains the destroy barrier after stack deletion failure and reuses fenced preservation", async () => {
    const harness = makeHarness({ instanceState: "running", failStackDeleteWaitOnce: true });
    const first = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(first.status).not.toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toEqual([
      `ec2:create-snapshot:${snapshotId}`,
    ]);
    expect((harness.readManifest().teardown as Record<string, unknown>).finalRootSnapshot).toMatchObject({
      snapshotId,
      state: "completed",
    });

    const retry = await harness.run(["--execute", "--retain-final-snapshot"], confirmation);
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    const state = harness.readState();
    expect(state.mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toEqual([
      `ec2:create-snapshot:${snapshotId}`,
    ]);
    expect(state.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ SnapshotId: snapshotId, WriteGeneration: 0, State: "completed" }),
      ])
    );
    expect((harness.readManifest().teardown as Record<string, unknown>).finalRootSnapshot).toMatchObject({
      snapshotId,
      state: "completed",
    });
    const deleteIndexes = state.mutations
      .map((entry, index) => (entry.startsWith("cloudformation:delete-stack") ? index : -1))
      .filter((index) => index >= 0);
    expect(deleteIndexes).toHaveLength(2);
    expect(state.mutations).toContain("delayed:start-denied-by-destroy-barrier");
    expect(state.mutations.some((entry) => entry.startsWith("instance:restarted-with-new-writes"))).toBe(false);

    const mutationCount = state.mutations.length;
    expect((await harness.run(["--execute", "--retain-final-snapshot"], confirmation)).status).toBe(0);
    expect(harness.readState().mutations).toHaveLength(mutationCount);
  }, 50_000);

  it("acquires the global destroy barrier before quiescence and denies delayed lifecycle and agent dispatch", async () => {
    const harness = makeHarness({
      instanceState: "running",
      delayedAttemptsDuringBackup: ["start", "restore", "agent-backup"],
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const state = harness.readState();
    const acquired = state.mutations.findIndex((entry) => entry.startsWith("dynamodb:destroy-barrier-acquired:"));
    const agentIdle = state.mutations.indexOf("ssm:quiesce-agent-runtime");
    const finalBackup = state.mutations.indexOf("ssm:final-drive-backup");
    expect(acquired).toBeGreaterThanOrEqual(0);
    expect(acquired).toBeLessThan(agentIdle);
    expect(agentIdle).toBeLessThan(finalBackup);
    for (const attempt of ["start", "restore", "agent-backup"]) {
      expect(state.mutations).toContain(`delayed:${attempt}-denied-by-destroy-barrier`);
      expect(state.mutations).not.toContain(`delayed:${attempt}-dispatched`);
    }
    expect(state.instanceWriteGeneration).toBe(0);
  }, 25_000);

  it("reconciles an ambiguous destroy barrier acquisition response before any teardown effect", async () => {
    const harness = makeHarness({ barrierAcquireResponseLost: true });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("a consistent read proved the exact owner");
    expect(
      harness.readState().mutations.filter((entry) => entry.startsWith("dynamodb:destroy-barrier-acquired"))
    ).toHaveLength(1);
  }, 25_000);

  it("fails closed when an in-flight lifecycle lock owns the global fence", async () => {
    const future = String(Date.now() + 90 * 60_000);
    const harness = makeHarness({
      lifecycleLockItem: {
        lockKey: { S: "minecraft-server-lifecycle" },
        lockId: { S: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
        action: { S: "restore" },
        ownerEmail: { S: "owner@example.invalid" },
        createdAt: { S: new Date().toISOString() },
        leaseExpiresAt: { N: future },
        leaseGeneration: { N: "4" },
        agentFenceActive: { BOOL: false },
        released: { BOOL: false },
        fencingToken: { N: "12" },
      },
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another lifecycle or agent effect owns the global lock");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("ssm:quiesce"))).toBe(false);
    expect(harness.readState().mutations).not.toContain("ssm:final-drive-backup");
  }, 20_000);

  it("does not take over an expired lifecycle lease while its agent fence remains active", async () => {
    const harness = makeHarness({
      lifecycleLockItem: {
        lockKey: { S: "minecraft-server-lifecycle" },
        lockId: { S: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
        action: { S: "backup" },
        ownerEmail: { S: "owner@example.invalid" },
        createdAt: { S: new Date(Date.now() - 120_000).toISOString() },
        leaseExpiresAt: { N: String(Date.now() - 60_000) },
        leaseGeneration: { N: "4" },
        agentFenceActive: { BOOL: true },
        released: { BOOL: false },
        fencingToken: { N: "12" },
      },
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another lifecycle or agent effect owns the global lock");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("dynamodb:destroy-barrier-acquired"))).toBe(
      false
    );
  }, 20_000);

  it("refuses a concurrent destroy process using the same deployment manifest", async () => {
    const harness = makeHarness();
    const holder = spawn("flock", [`${harness.manifestPath}.destroy.lock`, "bash", "-c", "printf ready; read -r _"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", () => resolve());
    });
    try {
      const result = await harness.run(["--execute"], confirmation);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Another destroy process is already using this deployment manifest");
      expect(harness.readState().mutations).toEqual([]);
    } finally {
      holder.stdin.end("done\n");
    }
  }, 20_000);

  it("refuses a symbolic-link destroy process lock without modifying its target", async () => {
    const harness = makeHarness();
    const originalManifest = readFileSync(harness.manifestPath, "utf8");
    symlinkSync(harness.manifestPath, `${harness.manifestPath}.destroy.lock`);
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Destroy process lock path must not be a symbolic link");
    expect(readFileSync(harness.manifestPath, "utf8")).toBe(originalManifest);
    expect(harness.readState().mutations).toEqual([]);
  }, 20_000);

  it("renews the fenced destroy owner without wall-clock delay in the mocked backup", async () => {
    const harness = makeHarness({ instanceState: "running", finalBackupDelayMs: 1_500 });
    const result = await harness.run(["--execute"], confirmation, { MC_AWS_DESTROY_RENEW_INTERVAL_SECONDS: "1" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().lifecycleRenewCount).toBeGreaterThanOrEqual(1);
    expect(harness.readState().mutations.some((entry) => entry.startsWith("dynamodb:destroy-barrier-renewed:"))).toBe(
      true
    );
  }, 30_000);

  it("fails closed before provider cleanup when destroy barrier renewal loses ownership", async () => {
    const harness = makeHarness({ instanceState: "running", finalBackupDelayMs: 1_500, lifecycleRenewFails: true });
    const result = await harness.run(["--execute"], confirmation, { MC_AWS_DESTROY_RENEW_INTERVAL_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Durable destroy barrier ownership was lost");
    expect(harness.readState().mutations).not.toContain("ssm:final-drive-backup");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudflare:delete"))).toBe(false);
    expect(harness.readState().accessKeys).toEqual(["AKIAOWNEDRUNTIMEKEY"]);
    expect(harness.readState().stack).toBe(true);
  }, 30_000);

  it("terminates and awaits the renewal worker after a teardown error", async () => {
    const harness = makeHarness({ finalBackupFails: true });
    const result = await harness.run(["--execute"], confirmation, { MC_AWS_DESTROY_RENEW_INTERVAL_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expectProcessStopped(harness.heartbeatPidPath);
  });

  it("reattaches the exact durable barrier after process death without repeating preservation", async () => {
    const harness = makeHarness({ instanceState: "running" });
    const died = await harness.run(["--execute"], confirmation, { MC_AWS_TEST_EXIT_AFTER_DESTROY_BARRIER: "1" });
    expect(died.status).toBe(99);
    const afterDeath = harness.readState();
    expect(afterDeath.mutations.filter((entry) => entry.startsWith("dynamodb:destroy-barrier-acquired:"))).toHaveLength(
      1
    );
    expect(afterDeath.mutations).not.toContain("ssm:final-drive-backup");
    const operationId = (harness.readManifest().teardown as { destroyLifecycle: { operationId: string } })
      .destroyLifecycle.operationId;

    const retry = await harness.run(["--execute"], confirmation);
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(
      harness.readState().mutations.filter((entry) => entry.startsWith("dynamodb:destroy-barrier-acquired:"))
    ).toHaveLength(1);
    expect(harness.readState().mutations.filter((entry) => entry === "ssm:final-drive-backup")).toHaveLength(1);
    expect(
      (harness.readManifest().teardown as { finalGoogleDriveBackup: unknown }).finalGoogleDriveBackup
    ).toMatchObject({
      operationId,
    });
  }, 35_000);

  it("reconciles an authoritative preservation phase after death before the local journal commit", async () => {
    const harness = makeHarness({ instanceState: "running" });
    const died = await harness.run(["--execute"], confirmation, {
      MC_AWS_TEST_EXIT_AFTER_DESTROY_PHASE: "preserving",
    });
    expect(died.status).toBe(98);
    expectProcessStopped(harness.heartbeatPidPath);
    expect(harness.readState().lifecycleLockItem?.destroyPhase?.S).toBe("preserving");
    expect((harness.readManifest().teardown as { destroyLifecycle: { phase: string } }).destroyLifecycle.phase).toBe(
      "runtime-quiesced"
    );

    const retry = await harness.run(["--execute"], confirmation);
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry === "ssm:quiesce-agent-runtime")).toHaveLength(1);
    expect(harness.readState().mutations.filter((entry) => entry === "ssm:final-drive-backup")).toHaveLength(1);
  }, 35_000);

  it("releases a pre-preservation barrier only through explicit safe abort", async () => {
    const harness = makeHarness({ instanceState: "running", activeAgentEffect: true });
    const blocked = await harness.run(["--execute"], confirmation);
    expect(blocked.status, `${blocked.stdout}\n${blocked.stderr}`).not.toBe(0);
    expect(harness.readState().lifecycleLockItem?.released?.BOOL).toBe(false);
    const lifecycle = (
      harness.readManifest().teardown as {
        destroyLifecycle: { operationId: string; preservationStartedAt?: string; phase: string };
      }
    ).destroyLifecycle;
    expect(lifecycle.preservationStartedAt).toBeUndefined();

    // The first quiescence attempt found an active effect. Safe abort is only
    // allowed after the effect has drained and rollback can be verified.
    harness.updateState({ activeAgentEffect: false });
    const abortPhrase = `abort destroy ${lifecycle.operationId} before preservation\n`;
    const aborted = await harness.run(["--execute", "--safe-abort-destroy"], `${standardConfirmation}${abortPhrase}`);
    expect(aborted.status, `${aborted.stdout}\n${aborted.stderr}`).toBe(0);
    expect(harness.readState().lifecycleLockItem?.released?.BOOL).toBe(true);
    expect(harness.readState().mutations).not.toContain("ssm:delete-parameter:/minecraft/server-action");
    expect((harness.readManifest().teardown as { destroyLifecycle: { phase: string } }).destroyLifecycle.phase).toBe(
      "aborted"
    );
  }, 30_000);

  it("retains a pre-preservation barrier when safe rollback cannot be verified", async () => {
    const harness = makeHarness({ instanceState: "running", activeAgentEffect: true });
    const blocked = await harness.run(["--execute"], confirmation);
    expect(blocked.status, `${blocked.stdout}\n${blocked.stderr}`).not.toBe(0);
    const lifecycle = (harness.readManifest().teardown as { destroyLifecycle: { operationId: string } })
      .destroyLifecycle;

    const abortPhrase = `abort destroy ${lifecycle.operationId} before preservation\n`;
    const aborted = await harness.run(["--execute", "--safe-abort-destroy"], `${standardConfirmation}${abortPhrase}`);
    expect(aborted.status).not.toBe(0);
    expect(aborted.stderr).toContain("Pre-preservation agent rollback was not authoritatively verified");
    expect(harness.readState().lifecycleLockItem?.released?.BOOL).toBe(false);
    expect(harness.readManifest().teardown).toMatchObject({
      destroyLifecycle: { phase: "barrier-active" },
    });
  }, 30_000);

  it("refuses safe abort after preservation starts and retains fail-closed state", async () => {
    const harness = makeHarness({ instanceState: "running", finalBackupFails: true });
    const failed = await harness.run(["--execute"], confirmation);
    expect(failed.status).not.toBe(0);
    const lifecycle = (
      harness.readManifest().teardown as {
        destroyLifecycle: { operationId: string; preservationStartedAt?: string; phase: string };
      }
    ).destroyLifecycle;
    expect(lifecycle.phase).toBe("preserving");
    expect(lifecycle.preservationStartedAt).toBeDefined();

    const abortPhrase = `abort destroy ${lifecycle.operationId} before preservation\n`;
    const aborted = await harness.run(["--execute", "--safe-abort-destroy"], `${standardConfirmation}${abortPhrase}`);
    expect(aborted.status).not.toBe(0);
    expect(aborted.stderr).toContain("refused after preservation starts");
    expect(harness.readState().lifecycleLockItem?.released?.BOOL).toBe(false);
  }, 30_000);

  it("disables Worker ingress before IAM revocation and stack deletion", async () => {
    const harness = makeHarness(
      { routes: [{ id: routeId, pattern: "panel.example.com/*", script: "mc-aws-panel" }] },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.routes = [
          {
            zoneId,
            id: routeId,
            pattern: "panel.example.com/*",
            script: "mc-aws-panel",
            createdByProject: true,
            ownershipProven: true,
            ownership: "created",
            originalScript: "",
          },
        ];
      }
    );
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const mutations = harness.readState().mutations;
    expect(mutations.indexOf(`cf:route-delete:${routeId}`)).toBeLessThan(mutations.indexOf("wrangler:worker-delete"));
    expect(mutations.indexOf("wrangler:worker-delete")).toBeLessThan(
      mutations.indexOf("iam:update-key:AKIAOWNEDRUNTIMEKEY")
    );
    expect(mutations.indexOf("iam:delete-key:AKIAOWNEDRUNTIMEKEY")).toBeLessThan(
      mutations.indexOf(`cloudformation:delete-stack:${stackId}`)
    );
  }, 25_000);

  it("cleans up an exactly tagged runtime IAM orphan after the stack is already absent", async () => {
    const harness = makeHarness({ stack: false, rootVolume: false, volumes: [] }, (manifest) => {
      manifest.teardown.completedResources = ["final-data-preservation"];
      manifest.teardown.googleDriveBackupEvidence = {
        parameterName: "/minecraft/backups-cache",
        backupCount: 1,
        cacheCachedAt: 1_769_000_000_000,
        observedAt: "2026-01-01T00:00:00Z",
      };
    });
    const result = await harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations).toEqual(
      expect.arrayContaining(["iam:delete-key:AKIAOWNEDRUNTIMEKEY", "iam:delete-user"])
    );
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
  }, 20_000);
});
