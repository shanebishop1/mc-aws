import { describe, expect, it } from "vitest";
import { INSTANCE_LOGICAL_ID, assertStandardDeploymentInstanceSafe } from "./existing-deployment-migration";
import {
  assertApplicationBackupProof,
  assertCompletedRootSnapshot,
  assertExactReplacementConfirmations,
  assertReviewedInstanceReplacementPlan,
  assertSafeToReleaseRuntimeRollout,
  assertSafeToReleaseUpgradeQuiescence,
  envOutputLines,
  replacementConfirmationPhrase,
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
    { ResourceChange: { LogicalResourceId: "StartLambda", Action: "Modify", Replacement: "False" } },
  ],
});

describe("existing host upgrade safety contracts", () => {
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

  it("accepts only the exact instance replacement plan and rejects other destructive changes", () => {
    expect(() =>
      assertReviewedInstanceReplacementPlan(identity, replacementChangeSet(), "MinecraftServerACE914F3")
    ).not.toThrow();
    const noReplacement = replacementChangeSet();
    noReplacement.Changes[0].ResourceChange.Replacement = "False";
    expect(() => assertReviewedInstanceReplacementPlan(identity, noReplacement, "MinecraftServerACE914F3")).toThrow(
      /explicit replacement/
    );
    const destructive = replacementChangeSet();
    destructive.Changes.push({
      ResourceChange: { LogicalResourceId: "LifecycleLockTable", Action: "Remove", Replacement: "False" },
    });
    expect(() => assertReviewedInstanceReplacementPlan(identity, destructive, "MinecraftServerACE914F3")).toThrow(
      /another destructive/
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
    const good = { rolloutSucceeded: true, helperHashesMatch: true, dependencyVersionsMatch: true };
    expect(() => assertSafeToReleaseRuntimeRollout(good)).not.toThrow();
    for (const bad of [
      { ...good, rolloutSucceeded: false },
      { ...good, helperHashesMatch: false },
      { ...good, dependencyVersionsMatch: false },
    ]) {
      expect(() => assertSafeToReleaseRuntimeRollout(bad)).toThrow(/Runtime rollout stop/);
    }
  });
});
