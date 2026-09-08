import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTANCE_LOGICAL_ID, assertStandardDeploymentInstanceSafe } from "./existing-deployment-migration";
import {
  assertApplicationBackupProof,
  assertCompletedRootSnapshot,
  assertExactReplacementConfirmations,
  assertInitiallyRunningHost,
  assertPublishedAgentRuntimeMatchesBuild,
  assertReviewedInstanceReplacementPlan,
  assertSafeToReleaseRuntimeRollout,
  assertSafeToReleaseUpgradeQuiescence,
  bindReplacementTransferAuthorization,
  classifyReviewedChangeSetExecution,
  envOutputLines,
  replacementConfirmationPhrase,
  requiresOldHostActivityCheckBeforeRecovery,
  validateLifecycleFenceIdentity,
  validatePublishedAgentRuntime,
  validateRequiredStackOutputs,
} from "./existing-host-upgrade";

const identity = {
  stackId: "arn:aws:cloudformation:us-west-1:123456789012:stack/MinecraftStack/stack-id",
  instanceId: `i-${"1".repeat(17)}`,
  rootVolumeId: `vol-${"2".repeat(17)}`,
  currentAmiId: `ami-${"3".repeat(17)}`,
  targetAmiId: `ami-${"4".repeat(17)}`,
};
const snapshotId = `snap-${"5".repeat(17)}`;
const changeSetId = `${identity.stackId}/change-set/reviewed/id`;

const replacementChangeSet = () => ({
  StackId: identity.stackId,
  ChangeSetId: changeSetId,
  Status: "CREATE_COMPLETE",
  ExecutionStatus: "AVAILABLE",
  Changes: [
    {
      ResourceChange: {
        LogicalResourceId: "MinecraftServerACE914F3",
        ResourceType: "AWS::EC2::Instance",
        PhysicalResourceId: identity.instanceId,
        Action: "Modify",
        Replacement: "True",
        Details: [
          {
            Target: {
              Attribute: "Properties",
              Name: "ImageId",
              BeforeValue: identity.currentAmiId,
              AfterValue: identity.targetAmiId,
              RequiresRecreation: "Always",
            },
          },
        ],
      },
    },
    {
      ResourceChange: {
        LogicalResourceId: "StartMinecraftLambdaABC123",
        ResourceType: "AWS::Lambda::Function",
        Action: "Modify",
        Replacement: "False",
        Details: [
          {
            ChangeSource: "ResourceReference",
            CausingEntity: "MinecraftServerACE914F3",
            Evaluation: "Dynamic",
            Target: { Attribute: "Properties", Name: "Environment", RequiresRecreation: "Never" },
          },
        ],
      },
    },
  ],
});

describe("existing host upgrade safety contracts", () => {
  it("uses authoritative same-AMI execution outcome before treating instance activity as stale", () => {
    expect(requiresOldHostActivityCheckBeforeRecovery(true, "never-executed")).toBe(true);
    expect(requiresOldHostActivityCheckBeforeRecovery(true, "in-progress")).toBe(false);
    expect(requiresOldHostActivityCheckBeforeRecovery(true, "complete")).toBe(false);
    expect(requiresOldHostActivityCheckBeforeRecovery(false, "complete")).toBe(true);
  });

  it.each([
    ["AVAILABLE", "never-executed"],
    ["EXECUTE_IN_PROGRESS", "in-progress"],
    ["EXECUTE_COMPLETE", "complete"],
  ] as const)("classifies reviewed change-set execution status %s", (executionStatus, expected) => {
    expect(
      classifyReviewedChangeSetExecution(
        { ChangeSetId: changeSetId, Status: "CREATE_COMPLETE", ExecutionStatus: executionStatus },
        changeSetId
      )
    ).toBe(expected);
  });

  it.each(["UNAVAILABLE", "OBSOLETE", "", "DELETE_COMPLETE"])(
    "rejects unsafe reviewed change-set execution status %s",
    (executionStatus) => {
      expect(() =>
        classifyReviewedChangeSetExecution(
          { ChangeSetId: changeSetId, Status: "CREATE_COMPLETE", ExecutionStatus: executionStatus },
          changeSetId
        )
      ).toThrow(/unsafe execution status/);
    }
  );

  it("uses the canonical fenced lifecycle owner instead of a legacy pseudo-lock", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    expect(source).toContain('acquireServerActionLock("backup"');
    expect(source).toContain("assertServerActionLockOwned");
    expect(source).toContain("leaseGeneration");
    expect(source).toContain("releaseServerActionLock");
    expect(source).not.toContain("acquireQuiescence");
    expect(source).not.toContain("/minecraft/server-action");
  });

  it("checks the lifecycle fence before every recovery start and retains it on rollout failure", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    const rollout = source.slice(source.indexOf("async function rolloutRuntime"), source.indexOf("function plan"));
    const prepare = source.slice(
      source.indexOf("async function prepareReplacement"),
      source.indexOf("function writeEnvValue")
    );
    const execute = source.slice(
      source.indexOf("async function executeReplacement"),
      source.indexOf("async function recover")
    );
    expect(rollout.indexOf("acquireLifecycleFence")).toBeLessThan(rollout.indexOf("hostMutationStarted = true"));
    expect(prepare.indexOf("claimReplacementLifecycleFence")).toBeLessThan(prepare.indexOf("mc-backup.sh"));
    expect(prepare.indexOf("writeState(initialized)")).toBeLessThan(
      prepare.indexOf("readReplacementLifecycleOperation(persistedOperation.operationId)")
    );
    expect(prepare.indexOf("replacementHeartbeat")).toBeLessThan(prepare.indexOf('"ec2", "stop-instances"'));
    expect(prepare.indexOf('phase: "backup-requested"')).toBeLessThan(prepare.indexOf("mc-backup.sh"));
    expect(prepare.indexOf("quiesceRequestedAt")).toBeLessThan(prepare.indexOf("mc-backup.sh --replacement"));
    expect(prepare.indexOf('phase: "stop-requested"')).toBeLessThan(prepare.indexOf('"ec2", "stop-instances"'));
    expect(prepare.indexOf('phase: "snapshot-requested"')).toBeLessThan(prepare.indexOf('"create-snapshot"'));
    expect(prepare.indexOf('phase: "change-set-requested"')).toBeLessThan(prepare.indexOf('"prepare-change-set"'));
    expect(prepare).toContain('"--client-token"');
    expect(execute.indexOf("reconcileReplacementFence")).toBeLessThan(execute.indexOf('"execute-change-set"'));
    expect(execute.indexOf("oldHostSafetyCheckPending: true")).toBeLessThan(
      execute.indexOf("oldHostState = oldHostDisposition")
    );
    expect(execute.indexOf("oldHostState = oldHostDisposition")).toBeLessThan(execute.indexOf('"execute-change-set"'));
    expect(execute).toContain("waitReviewedChangeSetExecutionWithFence");
    expect(execute.indexOf('phase: "execution-requested"')).toBeLessThan(execute.indexOf('"execute-change-set"'));
    expect(execute).toContain('"--client-request-token"');
    expect(source).toContain("const current = describeStack(options)");
    expect(source).not.toContain("timer.unref?.();\n    signal?.addEventListener");
    expect(source).toContain("ssmCommandWithFence");
    expect(source).toContain("takeOverExpiredReplacementFence");
    expect(source).toContain('outcome: "updated" | "rolled-back"');
    expect(source).toContain("finalizeCompletedStackRollback");
    expect(source).toContain('found.StackStatus !== "UPDATE_COMPLETE"');
    const reconcile = source.slice(
      source.indexOf("async function reconcileReplacementFence"),
      source.indexOf("function commandCheckpointSequence")
    );
    expect(reconcile.indexOf("state.oldHostActivityObservedAt =")).toBeLessThan(
      reconcile.indexOf('"ec2", "stop-instances"')
    );
    expect(reconcile).toContain("state.oldHostActivityObservedAt !== undefined");
    expect(reconcile).toContain("authoritative.oldHostSafetyCheckPending === true");
    const recover = source.slice(source.indexOf("async function recover"));
    expect(recover).toContain("readReviewedChangeSetExecution");
    expect(recover.indexOf("readReviewedChangeSetExecution")).toBeLessThan(
      recover.indexOf("persistOutputs(options, state)")
    );
    expect(recover.indexOf("const sameAmiRecovery")).toBeLessThan(recover.indexOf("const recoveryOldHostState"));
    expect(recover).toContain('authoritativeExecutionDisposition === "never-executed"');
    expect(recover).toContain("verifyUpdatedInstance(options, state, outputs.InstanceId)");
    const recoveryStart = recover.indexOf('"ec2", "start-instances", "--instance-ids", outputs.InstanceId');
    const recoveryCheckpoint = recover.lastIndexOf("await heartbeat.checkpoint()", recoveryStart);
    expect(recoveryCheckpoint).toBeGreaterThan(0);
    expect(recoveryCheckpoint).toBeLessThan(recoveryStart);
    expect(source).toContain("finalizeReplacementLifecycleFence");
    expect(source).toContain("stopAfterTerminal");
    expect(source).toContain('"--claim-token"');
    expect(source).toContain('"--claim-observed"');
    expect(source).toContain("observedClaims[0].Value !== claimToken");
    expect(source).toContain("managedInstancePhysicalId");
    expect(source).toContain("assertReviewedStackExecutionEvent");
    expect(source).toContain('"describe-stack-events"');
    expect(source).toContain("const latestStable = events?.find");
    const postRestore = source.slice(
      source.indexOf("async function postRestore"),
      source.indexOf("function verifyUpdatedInstance")
    );
    expect(postRestore.indexOf("refreshReplacementTransferAuthorization")).toBeLessThan(
      postRestore.indexOf("const restoreCommand")
    );
    expect(postRestore).toContain("MC_RELEASE_RECOVERY=rolled-back");
    expect(postRestore).toContain("pinReceiptVerifier(options, verifier)");
  });

  it("reconciles receipt verifier manifest and both environments before lifecycle release", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    const pin = source.slice(
      source.indexOf("function pinReceiptVerifier"),
      source.indexOf("async function rolloutRuntime")
    );
    const rollout = source.slice(source.indexOf("async function rolloutRuntime"), source.indexOf("function plan"));
    expect(pin.match(/reconcileReceiptVerifierEnvironment\(\)/g)).toHaveLength(2);
    expect(source).toContain('writeEnvValue(".env.production", "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS"');
    expect(source).toContain('writeEnvValue(".env.local", "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS"');
    const pinIndex = rollout.indexOf("pinReceiptVerifier");
    expect(pinIndex).toBeLessThan(rollout.indexOf("releaseLifecycleFence", pinIndex));
    const pinnedPhaseIndex = rollout.indexOf('phase: "verifier-pinned"', pinIndex);
    expect(rollout).toContain('phase: "verifier-discovered"');
    expect(pinnedPhaseIndex).toBeLessThan(rollout.indexOf("releaseLifecycleFence", pinnedPhaseIndex));
    expect(rollout).toContain("retainForAgentEffect: true");
    expect(source).toContain('"reconcile-runtime-receipt"');
    expect(source).toContain("pinDiscoveredRuntimeReceipt");
    expect(source).toContain("worker.artifactMerkleSha256");
    expect(source).toContain("worker.uploadConfigSha256");
    expect(source).toContain("worker.deploymentReceiptSha256");
    expect(source).toContain("deploymentReceiptSha256({");
    expect(source).toContain("worker.versionId");
    expect(source).toContain("worker.scriptEtag");
  });

  it("terminalizes a completed CloudFormation rollback only after the original host is ready", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    const rollback = source.slice(
      source.indexOf("async function finalizeCompletedStackRollback"),
      source.indexOf("function verifyUpdatedInstance")
    );
    expect(rollback).toContain('rolledBackStack.StackStatus !== "UPDATE_ROLLBACK_COMPLETE"');
    expect(rollback).toContain("outputs.InstanceId !== state.identity.instanceId");
    expect(rollback.indexOf("mc-wait-ready.sh")).toBeLessThan(rollback.indexOf('phase: "rolled-back"'));
    expect(rollback.indexOf('phase: "rolled-back"')).toBeLessThan(
      rollback.indexOf("finalizeReplacementLifecycleFence")
    );
  });

  it("refuses stopped or unproven hosts before a mutating command", () => {
    expect(() => assertInitiallyRunningHost({ initialInstanceState: "running" })).not.toThrow();
    expect(() => assertInitiallyRunningHost({ initialInstanceState: "stopped" })).toThrow(/initially stopped/);
    expect(() => assertInitiallyRunningHost({})).toThrow(/initially stopped or unproven/);
  });

  it("validates the persisted lock token and lease generation as one recovery identity", () => {
    expect(
      validateLifecycleFenceIdentity({
        lockId: "lock-a",
        fencingToken: 7,
        leaseGeneration: 3,
        action: "backup",
        ownerEmail: "HOST-UPGRADE@LOCAL.INVALID",
      })
    ).toEqual({
      lockId: "lock-a",
      fencingToken: 7,
      leaseGeneration: 3,
      action: "backup",
      ownerEmail: "host-upgrade@local.invalid",
    });
    expect(() =>
      validateLifecycleFenceIdentity({
        lockId: "lock-a",
        fencingToken: 7,
        leaseGeneration: 2,
        action: "backup",
        ownerEmail: "host-upgrade@local.invalid",
        stale: true,
      })
    ).toThrow(/malformed/);
  });

  it("publishes and activates one complete host release while retaining quiescence for rollback", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    expect(source).toContain("reviewedHostRelease");
    expect(source).toContain("build-host-release.mjs");
    expect(source).toContain("hostRelease");
    expect(source).toContain("mc-runtime-rollout.sh");
    expect(source).toContain("MC_RUNTIME_ROLLOUT_ADOPT_OPERATION=host-replacement");
    expect(source).toContain("--release-root");
    expect(source).toContain("--manifest-file");
    expect(source).toContain('executionTimeout: ["1800"]');
    expect(source).toContain('"trap - EXIT HUP INT TERM"');
    expect(source).toContain('rm -rf -- "$release_work"');
    expect(source).not.toContain("rollback_host_release");
    expect(source).not.toContain("mc-agent-install.sh rollback");
  });

  it("requires exact confirmations for the narrow standard-guard replacement bypass", () => {
    const phrase = replacementConfirmationPhrase(identity, snapshotId);
    expect(() =>
      assertExactReplacementConfirmations(identity, snapshotId, changeSetId, {
        stackId: identity.stackId,
        instanceId: identity.instanceId,
        snapshotId,
        changeSetId,
        phrase,
      })
    ).not.toThrow();
    expect(() =>
      assertExactReplacementConfirmations(identity, snapshotId, changeSetId, {
        stackId: identity.stackId,
        instanceId: identity.instanceId,
        snapshotId,
        changeSetId,
        phrase: `${phrase} NOW`,
      })
    ).toThrow(/bypass refused/);

    const template = (imageId: string) => ({
      Resources: {
        [INSTANCE_LOGICAL_ID]: {
          Type: "AWS::EC2::Instance",
          Properties: { ImageId: imageId, UserData: { "Fn::Base64": "#!/bin/bash\n" } },
        },
      },
    });
    const snapshot = {
      SnapshotId: snapshotId,
      VolumeId: identity.rootVolumeId,
      State: "completed",
      Encrypted: true,
      VolumeSize: 8,
    };
    expect(() =>
      assertStandardDeploymentInstanceSafe(template(identity.currentAmiId), template(identity.targetAmiId))
    ).toThrow(/Standard deployment blocked/);
    expect(() =>
      assertStandardDeploymentInstanceSafe(template(identity.currentAmiId), template(identity.targetAmiId), undefined, {
        identity,
        snapshotId,
        snapshot,
        changeSet: replacementChangeSet(),
        changeSetId,
        confirmations: {
          stackId: identity.stackId,
          instanceId: identity.instanceId,
          snapshotId,
          changeSetId,
          phrase,
        },
      })
    ).not.toThrow();
  });

  it("binds replacement transfer authorization to old and new instances and exact fenced backup state", () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const offer = JSON.stringify({
      authentication: { algorithm: "HMAC-SHA256", keyId: "key-old", tag: "a".repeat(64) },
      backup: { archiveName: "host-upgrade.tar.gz", backupId: "b".repeat(32), generation: 7 },
      delegation: { keyBase64: Buffer.alloc(32, 6).toString("base64") },
      format: "mc-aws-backup-transfer-offer",
      lifecycle: { fencingToken: 4, leaseGeneration: 2, lockId: "lock-replacement" },
      operationId,
      restoreFloor: { backupId: "", generation: 0 },
      schemaVersion: 1,
      source: { accountId: "123456789012", instanceId: identity.instanceId, serverId: identity.stackId },
      validity: { expiresAt: "2099-01-01T00:30:00Z", issuedAt: "2099-01-01T00:00:00Z", transferId: "c".repeat(32) },
    });
    const authorization = bindReplacementTransferAuthorization(offer, `i-${"6".repeat(17)}`, {
      archiveName: "host-upgrade.tar.gz",
      operationId,
      backupId: "b".repeat(32),
      generation: 7,
      sourceInstanceId: identity.instanceId,
      lockId: "lock-takeover",
      fencingToken: 5,
      leaseGeneration: 1,
    });
    expect(JSON.parse(authorization)).toMatchObject({
      format: "mc-aws-backup-transfer",
      operationId,
      target: { accountId: "123456789012", instanceId: `i-${"6".repeat(17)}` },
      lifecycle: { lockId: "lock-takeover", fencingToken: 5, leaseGeneration: 1 },
      authentication: { keyId: "transfer-delegated", algorithm: "HMAC-SHA256", tag: expect.any(String) },
    });
    expect(() =>
      bindReplacementTransferAuthorization(offer, `i-${"6".repeat(17)}`, {
        archiveName: "other.tar.gz",
        operationId,
        backupId: "b".repeat(32),
        generation: 7,
        sourceInstanceId: identity.instanceId,
        lockId: "lock-takeover",
        fencingToken: 5,
        leaseGeneration: 1,
      })
    ).toThrow(/exact backup/);
  });

  it("requires fresh exact non-empty application backup proof and a completed exact root snapshot", () => {
    const now = Date.parse("2026-08-28T12:00:00Z");
    expect(() =>
      assertApplicationBackupProof(
        "host-upgrade.tar.gz",
        { name: "host-upgrade.tar.gz", size: 42, modifiedAt: "2026-08-28T11:59:00Z" },
        now
      )
    ).not.toThrow();
    expect(() =>
      assertApplicationBackupProof(
        "host-upgrade.tar.gz",
        { name: "other.tar.gz", size: 42, modifiedAt: "2026-08-28T11:59:00Z" },
        now
      )
    ).toThrow(/exact non-empty/);
    const snapshot = {
      SnapshotId: snapshotId,
      VolumeId: identity.rootVolumeId,
      State: "completed",
      Encrypted: true,
      VolumeSize: 8,
    };
    expect(() => assertCompletedRootSnapshot(identity, snapshot)).not.toThrow();
    expect(() => assertCompletedRootSnapshot(identity, { ...snapshot, State: "pending" })).toThrow(/completed/);
    expect(() => assertCompletedRootSnapshot(identity, { ...snapshot, VolumeId: `vol-${"9".repeat(17)}` })).toThrow(
      /exact live root/
    );
  });

  it("accepts only exact instance-reference effects and rejects unreviewed changes", () => {
    expect(() =>
      assertReviewedInstanceReplacementPlan(identity, replacementChangeSet(), "MinecraftServerACE914F3")
    ).not.toThrow();
    const sameAmiIdentity = { ...identity, targetAmiId: identity.currentAmiId };
    const userDataReplacement = replacementChangeSet();
    userDataReplacement.Changes[0].ResourceChange.Replacement = "Conditional";
    userDataReplacement.Changes[0].ResourceChange.Details = [
      {
        Target: {
          Attribute: "Properties",
          Name: "UserData",
          BeforeValue: "old-user-data",
          AfterValue: "new-user-data",
          RequiresRecreation: "Conditionally",
        },
      },
    ];
    expect(assertReviewedInstanceReplacementPlan(sameAmiIdentity, userDataReplacement, "MinecraftServerACE914F3")).toBe(
      "in-place"
    );
    const noReplacement = replacementChangeSet();
    noReplacement.Changes[0].ResourceChange.Replacement = "False";
    expect(() => assertReviewedInstanceReplacementPlan(identity, noReplacement, "MinecraftServerACE914F3")).toThrow(
      /explicit replacement/
    );
    const destructive = replacementChangeSet();
    destructive.Changes.push({
      ResourceChange: {
        LogicalResourceId: "LifecycleLockTable",
        ResourceType: "AWS::DynamoDB::Table",
        Action: "Remove",
        Replacement: "False",
        Details: [],
      },
    });
    expect(() => assertReviewedInstanceReplacementPlan(identity, destructive, "MinecraftServerACE914F3")).toThrow(
      /unreviewed resource change/
    );
    const unrelatedModify = replacementChangeSet();
    unrelatedModify.Changes.push({
      ResourceChange: {
        LogicalResourceId: "UnrelatedRole",
        ResourceType: "AWS::IAM::Role",
        Action: "Modify",
        Replacement: "False",
        Details: [],
      },
    });
    expect(() => assertReviewedInstanceReplacementPlan(identity, unrelatedModify, "MinecraftServerACE914F3")).toThrow(
      /unreviewed resource change/
    );
  });

  it("validates and maps all outputs that must be persisted before Worker deployment", () => {
    const outputs = validateRequiredStackOutputs({
      InstanceId: identity.instanceId,
      LifecycleLockTableName: "MinecraftStack-LifecycleLockTable-ABC",
      OperationStateTableName: "MinecraftStack-OperationStateTable-DEF",
      WorkerRuntimeIamUserName: "mc-aws-runtime",
    });
    expect(envOutputLines(outputs)).toEqual({
      INSTANCE_ID: identity.instanceId,
      MC_LIFECYCLE_LOCK_TABLE_NAME: "MinecraftStack-LifecycleLockTable-ABC",
      MC_OPERATION_STATE_TABLE_NAME: "MinecraftStack-OperationStateTable-DEF",
    });
    expect(() => validateRequiredStackOutputs({ ...outputs, OperationStateTableName: "" })).toThrow(
      /OperationStateTableName/
    );
  });

  it("retains quiescence at every rollback stop condition", () => {
    const good = {
      stackStatus: "UPDATE_COMPLETE",
      instanceState: "running",
      restoreSucceeded: true,
      readinessSucceeded: true,
      hashesMatch: true,
      outputsPersisted: true,
    };
    expect(() => assertSafeToReleaseUpgradeQuiescence(good)).not.toThrow();
    for (const bad of [
      { ...good, stackStatus: "UPDATE_ROLLBACK_COMPLETE" },
      { ...good, instanceState: "stopped" },
      { ...good, restoreSucceeded: false },
      { ...good, readinessSucceeded: false },
      { ...good, hashesMatch: false },
      { ...good, outputsPersisted: false },
    ]) {
      expect(() => assertSafeToReleaseUpgradeQuiescence(bad)).toThrow(/Rollback stop/);
    }
  });

  it("releases an in-place rollout lock only after helpers and dependencies are proven", () => {
    const good = {
      rolloutSucceeded: true,
      transferSucceeded: true,
      helperHashesMatch: true,
      dependencyVersionsMatch: true,
      installedRuntimeMatches: true,
      installedManifestMatches: true,
    };
    expect(() => assertSafeToReleaseRuntimeRollout(good)).not.toThrow();
    for (const bad of [
      { ...good, rolloutSucceeded: false },
      { ...good, transferSucceeded: false },
      { ...good, helperHashesMatch: false },
      { ...good, dependencyVersionsMatch: false },
      { ...good, installedRuntimeMatches: false },
      { ...good, installedManifestMatches: false },
    ]) {
      expect(() => assertSafeToReleaseRuntimeRollout(bad)).toThrow(/Runtime rollout stop/);
    }
  });

  it("rejects an old published manifest/current local bundle mismatch before activation", () => {
    const digest = "a".repeat(64);
    const manifestDigest = "b".repeat(64);
    const published = validatePublishedAgentRuntime({
      uri: `s3://cdk-assets/agent/${digest}.zip`,
      sha256: digest,
      bytes: 123,
      bundleManifestSha256: manifestDigest,
    });
    expect(() =>
      assertPublishedAgentRuntimeMatchesBuild(published, {
        archive: `/reviewed/${"c".repeat(64)}.zip`,
        sha256: "c".repeat(64),
        bytes: 456,
        manifestSha256: "d".repeat(64),
        manifestBytes: 42,
      })
    ).toThrow(/current locally built\/reviewed bundle/);
  });

  it("accepts only exact published ZIP size/digest and bundle manifest digest", () => {
    const digest = "a".repeat(64);
    const manifestDigest = "b".repeat(64);
    const published = validatePublishedAgentRuntime({
      uri: `s3://cdk-assets/agent/${digest}.zip`,
      sha256: digest,
      bytes: 123,
      bundleManifestSha256: manifestDigest,
    });
    expect(() =>
      assertPublishedAgentRuntimeMatchesBuild(published, {
        archive: `/reviewed/${digest}.zip`,
        sha256: digest,
        bytes: 123,
        manifestSha256: manifestDigest,
        manifestBytes: 42,
      })
    ).not.toThrow();
    expect(() =>
      assertPublishedAgentRuntimeMatchesBuild(published, {
        archive: "x",
        sha256: digest,
        bytes: 124,
        manifestSha256: manifestDigest,
        manifestBytes: 42,
      })
    ).toThrow(/does not match/);
    expect(() =>
      assertPublishedAgentRuntimeMatchesBuild(published, {
        archive: "x",
        sha256: digest,
        bytes: 123,
        manifestSha256: "e".repeat(64),
        manifestBytes: 42,
      })
    ).toThrow(/does not match/);
  });

  it("requires an explicit cutoff for a changed verifier and checks durable state before eviction", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    expect(source).toContain("sameVerifierIdentity");
    expect(source).toContain('return "unchanged"');
    expect(source).toContain("--rotation-cutoff-at");
    expect(source).toContain('"dynamodb",\n      "scan"');
    expect(source).toContain("unresolved durable receipt reference");
    expect(source).toContain("executor-receipt-references");
    expect(source).toContain("priorReceiptVerifiers);");
    expect(source).not.toContain("prior.slice(1)");
  });
});
