import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CloudFormationTemplate,
  INSTANCE_LOGICAL_ID,
  LEGACY_ACTIVATION_LOGICAL_ID,
  LEGACY_RULE_SET_LOGICAL_ID,
  assertExclusiveTaggingAcknowledged,
  assertLegacyResourcesRetained,
  assertOwnershipTagsComplete,
  assertSafeBridgeChangeSet,
  assertSafeRetentionChangeSet,
  assertStandardDeploymentInstanceSafe,
  assertSynthesizedAssemblyIdentity,
  buildLegacyRetentionTemplate,
  buildPinnedInstanceBridgeTemplate,
  establishOwnershipTags,
  inspectInstanceAndRootVolume,
} from "./existing-deployment-migration";

const stackId = "arn:aws:cloudformation:us-west-1:123456789012:stack/MinecraftStack/stack-id";
const instanceId = `i-${"1".repeat(17)}`;
const volumeId = `vol-${"2".repeat(17)}`;

const liveTemplate = (): CloudFormationTemplate => ({
  Resources: {
    [LEGACY_RULE_SET_LOGICAL_ID]: {
      Type: "AWS::SES::ReceiptRuleSet",
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: { RuleSetName: "legacy" },
    },
    [LEGACY_ACTIVATION_LOGICAL_ID]: {
      Type: "Custom::AWS",
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: { Create: "activate", Delete: "deactivate" },
    },
    [INSTANCE_LOGICAL_ID]: {
      Type: "AWS::EC2::Instance",
      Properties: { ImageId: "ami-legacy", UserData: "legacy", BlockDeviceMappings: [{ DeviceName: "/dev/xvda" }] },
    },
  },
});

const currentTemplate = (): CloudFormationTemplate => ({
  Resources: {
    [INSTANCE_LOGICAL_ID]: {
      Type: "AWS::EC2::Instance",
      Properties: { ImageId: "ami-current", UserData: "remediated", PropagateTagsToVolumeOnCreation: true },
    },
    WorkerRuntimeUser: { Type: "AWS::IAM::User" },
  },
});

const ownershipTags = [
  { Key: "McAwsProject", Value: "mc-aws" },
  { Key: "McAwsStack", Value: "MinecraftStack" },
  { Key: "McAwsManagedRoot", Value: "true" },
];

const instanceResponse = (includeOwnership = true) => ({
  Reservations: [
    {
      Instances: [
        {
          InstanceId: instanceId,
          ImageId: `ami-${"3".repeat(17)}`,
          RootDeviceName: "/dev/xvda",
          BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: volumeId, DeleteOnTermination: true } }],
          Tags: [
            { Key: "aws:cloudformation:stack-id", Value: stackId },
            { Key: "aws:cloudformation:stack-name", Value: "MinecraftStack" },
            { Key: "aws:cloudformation:logical-id", Value: INSTANCE_LOGICAL_ID },
            ...(includeOwnership ? ownershipTags : []),
          ],
        },
      ],
    },
  ],
});

const volumeResponse = (tags = ownershipTags) => ({
  Volumes: [
    {
      VolumeId: volumeId,
      State: "in-use",
      Attachments: [{ InstanceId: instanceId, Device: "/dev/xvda", State: "attached" }],
      Tags: tags,
    },
  ],
});

describe("existing deployment migration template contracts", () => {
  it("changes only legacy SES lifecycle policies in the retention stage", () => {
    const live = liveTemplate();
    const retained = buildLegacyRetentionTemplate(live);

    assertLegacyResourcesRetained(retained);
    expect(retained.Resources[INSTANCE_LOGICAL_ID]).toEqual(live.Resources[INSTANCE_LOGICAL_ID]);
    expect(live.Resources[LEGACY_RULE_SET_LOGICAL_ID].DeletionPolicy).toBe("Delete");
  });

  it("pins the complete deployed instance resource while taking all other resources from current CDK", () => {
    const retained = buildLegacyRetentionTemplate(liveTemplate());
    const current = currentTemplate();
    const bridge = buildPinnedInstanceBridgeTemplate(retained, current);

    expect(bridge.Resources[INSTANCE_LOGICAL_ID]).toEqual(retained.Resources[INSTANCE_LOGICAL_ID]);
    expect(bridge.Resources.WorkerRuntimeUser).toEqual(current.Resources.WorkerRuntimeUser);
    expect(bridge.Resources[LEGACY_RULE_SET_LOGICAL_ID]).toBeUndefined();
    expect(bridge.Resources[LEGACY_ACTIVATION_LOGICAL_ID]).toBeUndefined();
  });

  it("pins the bridge ImageId to the exact physical AMI instead of refreshing an SSM AMI parameter", () => {
    const retained = buildLegacyRetentionTemplate(liveTemplate());
    retained.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = { Ref: "LatestAmiParameter" };
    const bridge = buildPinnedInstanceBridgeTemplate(retained, currentTemplate(), `ami-${"4".repeat(17)}`);

    expect(bridge.Resources[INSTANCE_LOGICAL_ID].Properties).toMatchObject({
      ImageId: `ami-${"4".repeat(17)}`,
      UserData: "legacy",
    });
  });

  it("rejects a bridge change set that touches the EC2 instance", () => {
    expect(() =>
      assertSafeBridgeChangeSet([
        { ResourceChange: { LogicalResourceId: INSTANCE_LOGICAL_ID, Action: "Modify", Replacement: "True" } },
        { ResourceChange: { LogicalResourceId: LEGACY_RULE_SET_LOGICAL_ID, Action: "Remove" } },
        { ResourceChange: { LogicalResourceId: LEGACY_ACTIVATION_LOGICAL_ID, Action: "Remove" } },
      ])
    ).toThrow(/touches MinecraftServerACE914F3/);
  });

  it("rejects retention if parameter re-resolution would touch the instance", () => {
    expect(() =>
      assertSafeRetentionChangeSet([
        { ResourceChange: { LogicalResourceId: INSTANCE_LOGICAL_ID, Action: "Modify", Replacement: "True" } },
      ])
    ).toThrow(/unexpectedly touches MinecraftServerACE914F3/);
  });

  it("allows only non-replacing legacy lifecycle-policy modifications in retention", () => {
    expect(() =>
      assertSafeRetentionChangeSet([
        {
          ResourceChange: {
            LogicalResourceId: LEGACY_RULE_SET_LOGICAL_ID,
            Action: "Modify",
            Replacement: "False",
          },
        },
        {
          ResourceChange: {
            LogicalResourceId: LEGACY_ACTIVATION_LOGICAL_ID,
            Action: "Modify",
            Replacement: "False",
          },
        },
      ])
    ).not.toThrow();
  });

  it("accepts legacy removals plus non-instance remediation changes", () => {
    expect(() =>
      assertSafeBridgeChangeSet([
        { ResourceChange: { LogicalResourceId: LEGACY_RULE_SET_LOGICAL_ID, Action: "Remove" } },
        { ResourceChange: { LogicalResourceId: LEGACY_ACTIVATION_LOGICAL_ID, Action: "Remove" } },
        { ResourceChange: { LogicalResourceId: "WorkerRuntimeUser", Action: "Add" } },
      ])
    ).not.toThrow();
  });

  it("rejects an effective SES delete policy action while tolerating API omission", () => {
    expect(() =>
      assertSafeBridgeChangeSet([
        {
          ResourceChange: {
            LogicalResourceId: LEGACY_RULE_SET_LOGICAL_ID,
            Action: "Remove",
            PolicyAction: "Delete",
          },
        },
        {
          ResourceChange: {
            LogicalResourceId: LEGACY_ACTIVATION_LOGICAL_ID,
            Action: "Remove",
            PolicyAction: "Retain",
          },
        },
      ])
    ).toThrow(/effective PolicyAction="Delete"/);

    expect(() =>
      assertSafeBridgeChangeSet([
        { ResourceChange: { LogicalResourceId: LEGACY_RULE_SET_LOGICAL_ID, Action: "Remove" } },
        {
          ResourceChange: {
            LogicalResourceId: LEGACY_ACTIVATION_LOGICAL_ID,
            Action: "Remove",
            PolicyAction: "Retain",
          },
        },
      ])
    ).not.toThrow();
  });

  it("blocks ordinary deployment when an existing instance uses a dynamic AMI reference", () => {
    const live = currentTemplate();
    const current = currentTemplate();
    live.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = { Ref: "LatestAmiParameter" };
    current.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = { Ref: "LatestAmiParameter" };

    expect(() => assertStandardDeploymentInstanceSafe(live, current)).toThrow(/dynamic or unpinned/);

    const pinnedImageId = `ami-${"5".repeat(17)}`;
    live.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = pinnedImageId;
    current.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = pinnedImageId;
    expect(() => assertStandardDeploymentInstanceSafe(live, current)).not.toThrow();
  });

  it("allows later pinned-instance bridges after both legacy resources are no longer managed", () => {
    const postBridgeLive = currentTemplate();
    postBridgeLive.Resources[INSTANCE_LOGICAL_ID] = liveTemplate().Resources[INSTANCE_LOGICAL_ID];

    expect(() => buildPinnedInstanceBridgeTemplate(postBridgeLive, currentTemplate())).not.toThrow();
    expect(() =>
      assertSafeBridgeChangeSet(
        [{ ResourceChange: { LogicalResourceId: "WorkerRuntimePolicy", Action: "Modify" } }],
        false
      )
    ).not.toThrow();
  });
});

describe("existing deployment migration ownership contracts", () => {
  const identity = { accountId: "123456789012", region: "us-west-1", stackId, stackName: "MinecraftStack" };

  it("derives the exact attached root and reports only missing safe-to-add ownership tags", () => {
    const inspection = inspectInstanceAndRootVolume(identity, instanceId, instanceResponse(false), volumeResponse([]));

    expect(inspection.rootVolumeId).toBe(volumeId);
    expect(inspection.imageId).toBe(`ami-${"3".repeat(17)}`);
    expect(inspection.missingInstanceTags).toEqual(["McAwsProject", "McAwsStack", "McAwsManagedRoot"]);
    expect(inspection.missingVolumeTags).toEqual(["McAwsProject", "McAwsStack", "McAwsManagedRoot"]);
  });

  it("refuses conflicting ownership instead of adopting a same-name resource", () => {
    expect(() =>
      inspectInstanceAndRootVolume(
        identity,
        instanceId,
        instanceResponse(),
        volumeResponse([{ Key: "McAwsProject", Value: "another-project" }])
      )
    ).toThrow(/conflicting ownership tag/);
  });

  it("requires DeleteOnTermination and exact CloudFormation identity", () => {
    const response = instanceResponse();
    response.Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.DeleteOnTermination = false;
    expect(() => inspectInstanceAndRootVolume(identity, instanceId, response, volumeResponse())).toThrow(
      /DeleteOnTermination=true/
    );
  });

  it("verifies both resources have the complete ownership tag set", () => {
    const complete = inspectInstanceAndRootVolume(identity, instanceId, instanceResponse(), volumeResponse());
    expect(() => assertOwnershipTagsComplete(complete)).not.toThrow();

    const incomplete = inspectInstanceAndRootVolume(identity, instanceId, instanceResponse(false), volumeResponse([]));
    expect(() => assertOwnershipTagsComplete(incomplete)).toThrow(/have not been established/);
  });

  it("tags the volume first and removes only invocation-added tags if attachment identity changes", () => {
    const missingManagedRoot = {
      instanceId,
      imageId: `ami-${"3".repeat(17)}`,
      rootDeviceName: "/dev/xvda",
      rootVolumeId: volumeId,
      missingInstanceTags: ["McAwsManagedRoot"],
      missingVolumeTags: ["McAwsManagedRoot"],
    };
    const changedAttachment = {
      ...missingManagedRoot,
      rootVolumeId: `vol-${"9".repeat(17)}`,
      missingVolumeTags: [],
    };
    const writes: Array<{ operation: string; resourceId: string; tags: Record<string, string> }> = [];
    const inspections = [missingManagedRoot, changedAttachment];

    expect(() =>
      establishOwnershipTags("MinecraftStack", missingManagedRoot, {
        inspect: () => inspections.shift() ?? changedAttachment,
        createTags: (resourceId, tags) => writes.push({ operation: "create", resourceId, tags }),
        deleteTags: (resourceId, tags) => writes.push({ operation: "delete", resourceId, tags }),
      })
    ).toThrow(/identity changed.*Invocation-added tags were removed/);

    expect(writes).toEqual([
      {
        operation: "create",
        resourceId: volumeId,
        tags: { McAwsManagedRoot: "true" },
      },
      {
        operation: "delete",
        resourceId: volumeId,
        tags: { McAwsManagedRoot: "true" },
      },
    ]);
  });

  it("reinspects around volume-first and instance-second tag writes", () => {
    const missing = {
      instanceId,
      imageId: `ami-${"3".repeat(17)}`,
      rootDeviceName: "/dev/xvda",
      rootVolumeId: volumeId,
      missingInstanceTags: ["McAwsProject"],
      missingVolumeTags: ["McAwsProject"],
    };
    const volumeComplete = { ...missing, missingVolumeTags: [] };
    const complete = { ...volumeComplete, missingInstanceTags: [] };
    const inspections = [missing, volumeComplete, volumeComplete, complete];
    const operations: string[] = [];

    establishOwnershipTags("MinecraftStack", missing, {
      inspect: () => {
        operations.push("inspect");
        return inspections.shift() ?? complete;
      },
      createTags: (resourceId) => operations.push(`create:${resourceId}`),
      deleteTags: (resourceId) => operations.push(`delete:${resourceId}`),
    });

    expect(operations).toEqual([
      "inspect",
      `create:${volumeId}`,
      "inspect",
      "inspect",
      `create:${instanceId}`,
      "inspect",
    ]);
  });
});

describe("existing deployment migration entry-point contract", () => {
  it("keeps migration dry-run by default and guards routine setup/CDK deployment", () => {
    const root = path.resolve(process.cwd());
    const migrationCli = readFileSync(path.join(root, "scripts/migrate-existing-deployment.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const setup = readFileSync(path.join(root, "setup.sh"), "utf8");

    expect(migrationCli).toContain('stage: "plan"');
    expect(migrationCli).toContain("DRY RUN ONLY");
    expect(packageJson.scripts["cdk:deploy"]).toContain("--assert-standard-deploy-safe");
    expect(setup).toContain("migrate-existing-deployment.ts");
    expect(setup).toContain("--assert-standard-deploy-safe");
  });

  it("requires exclusive-writer acknowledgment only for an executing tags stage", () => {
    expect(() => assertExclusiveTaggingAcknowledged("tags", true, false)).toThrow(/confirm-exclusive-tagging/);
    expect(() => assertExclusiveTaggingAcknowledged("tags", true, true)).not.toThrow();
    expect(() => assertExclusiveTaggingAcknowledged("plan", false, false)).not.toThrow();
    expect(() => assertExclusiveTaggingAcknowledged("retain", true, false)).not.toThrow();

    const migrationCli = readFileSync(path.join(process.cwd(), "scripts/migrate-existing-deployment.ts"), "utf8");
    expect(migrationCli).toContain('argument === "--confirm-exclusive-tagging"');
  });
});

describe("synthesized CDK assembly identity", () => {
  const identity = { accountId: "123456789012", region: "us-west-1", stackId, stackName: "MinecraftStack" };
  const documents = () => ({
    manifest: {
      artifacts: {
        MinecraftStack: {
          type: "aws:cloudformation:stack",
          environment: "aws://123456789012/us-west-1",
          properties: {
            stackTemplateAssetObjectUrl: "s3://cdk-test-assets-123456789012-us-west-1/template.json",
          },
        },
        "MinecraftStack.assets": {
          type: "cdk:asset-manifest",
          properties: { file: "MinecraftStack.assets.json" },
        },
      },
    },
    assetManifest: {
      files: {
        asset: {
          destinations: {
            destination: {
              bucketName: "cdk-test-assets-123456789012-us-west-1",
              region: "us-west-1",
              assumeRoleArn:
                "arn:${AWS::Partition}:iam::123456789012:role/cdk-test-file-publishing-role-123456789012-us-west-1",
            },
          },
        },
      },
      dockerImages: {},
    },
  });

  it("accepts an assembly whose stack and every asset destination match", () => {
    expect(() => assertSynthesizedAssemblyIdentity(identity, documents())).not.toThrow();
  });

  it("rejects conflicting stack, asset account, region, and bucket identities", () => {
    const wrongStack = documents();
    wrongStack.manifest.artifacts.MinecraftStack.environment = "aws://999999999999/us-west-1";
    expect(() => assertSynthesizedAssemblyIdentity(identity, wrongStack)).toThrow(/stack identity/);

    const wrongAccount = documents();
    wrongAccount.assetManifest.files.asset.destinations.destination.assumeRoleArn =
      "arn:${AWS::Partition}:iam::999999999999:role/cdk-test-file-publishing-role";
    expect(() => assertSynthesizedAssemblyIdentity(identity, wrongAccount)).toThrow(/unexpected account/);

    const wrongRegion = documents();
    wrongRegion.assetManifest.files.asset.destinations.destination.region = "eu-west-1";
    expect(() => assertSynthesizedAssemblyIdentity(identity, wrongRegion)).toThrow(/unexpected region/);

    const wrongBucket = documents();
    wrongBucket.assetManifest.files.asset.destinations.destination.bucketName = "wrong-bucket";
    expect(() => assertSynthesizedAssemblyIdentity(identity, wrongBucket)).toThrow(/unexpected asset bucket/);

    const consistentlyWrongBucket = documents();
    consistentlyWrongBucket.manifest.artifacts.MinecraftStack.properties.stackTemplateAssetObjectUrl =
      "s3://cdk-test-assets-999999999999-us-west-1/template.json";
    consistentlyWrongBucket.assetManifest.files.asset.destinations.destination.bucketName =
      "cdk-test-assets-999999999999-us-west-1";
    expect(() => assertSynthesizedAssemblyIdentity(identity, consistentlyWrongBucket)).toThrow(
      /does not encode the confirmed account and region/
    );
  });
});
