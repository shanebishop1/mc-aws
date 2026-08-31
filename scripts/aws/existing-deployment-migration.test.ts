import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CloudFormationTemplate,
  INSTANCE_LOGICAL_ID,
  LEGACY_ACTIVATION_LOGICAL_ID,
  LEGACY_RULE_SET_LOGICAL_ID,
  adoptActualInstanceUserData,
  assertExclusiveTaggingAcknowledged,
  assertInstanceUserDataTransition,
  assertLegacyGithubUserDataDependenciesPreserved,
  assertLegacyResourcesRetained,
  assertOwnershipTagsComplete,
  assertPinnedInstanceImageTransition,
  assertSafeBridgeChangeSet,
  assertSafeRetentionChangeSet,
  assertStandardDeploymentInstanceSafe,
  assertSynthesizedAssemblyIdentity,
  buildChangeSetParameters,
  buildLegacyRetentionTemplate,
  buildPinnedInstanceBridgeTemplate,
  cloudFormationTemplateTransport,
  decodeInstanceUserDataAttribute,
  establishOwnershipTags,
  extractWorkerStackOutputs,
  inspectInstanceAndRootVolume,
  isRetentionStageComplete,
  isStableMigrationStackStatus,
  normalizePnpmArguments,
  pinDeployedInstanceImage,
  updateDotenvValues,
} from "./existing-deployment-migration";

const stackId = "arn:aws:cloudformation:us-west-1:123456789012:stack/MinecraftStack/stack-id";
const instanceId = `i-${"1".repeat(17)}`;
const volumeId = `vol-${"2".repeat(17)}`;
const physicalImageId = `ami-${"3".repeat(17)}`;
const imageParameterName = "SsmParameterValueLatestAmi";
const storedUserData = "#!/bin/bash\nprintf 'legacy'";
const storedUserDataBytes = Buffer.from(storedUserData, "utf8");
const actualUserData = "#!/bin/bash\nprintf 'Grüße ☃'\n";
const actualUserDataBytes = Buffer.from(actualUserData, "utf8");

describe("existing deployment Worker output synchronization", () => {
  const outputs = [
    { OutputKey: "InstanceId", OutputValue: instanceId },
    { OutputKey: "LifecycleLockTableName", OutputValue: "mc-aws-locks" },
    { OutputKey: "OperationStateTableName", OutputValue: "mc-aws-operations" },
  ];

  it("extracts exact stack outputs and updates dotenv idempotently", () => {
    const values = extractWorkerStackOutputs(outputs, instanceId);
    const updated = updateDotenvValues("# keep\nexport INSTANCE_ID = stale\nAUTH_SECRET=keep\n", values);
    expect(updated).toContain(`INSTANCE_ID=${instanceId}`);
    expect(updated).toContain("MC_LIFECYCLE_LOCK_TABLE_NAME=mc-aws-locks");
    expect(updated).toContain("MC_OPERATION_STATE_TABLE_NAME=mc-aws-operations");
    expect(updated).toContain("AUTH_SECRET=keep");
    expect(updateDotenvValues(updated, values)).toBe(updated);
  });

  it("rejects missing, duplicate, wrong-instance, and duplicate-dotenv identities", () => {
    expect(() => extractWorkerStackOutputs(outputs.slice(1), instanceId)).toThrow("InstanceId");
    expect(() => extractWorkerStackOutputs([...outputs, outputs[1]], instanceId)).toThrow("exactly one");
    expect(() => extractWorkerStackOutputs(outputs, `i-${"9".repeat(17)}`)).toThrow("ownership-proven");
    expect(() =>
      updateDotenvValues("INSTANCE_ID=one\nexport INSTANCE_ID=two\n", extractWorkerStackOutputs(outputs, instanceId))
    ).toThrow("duplicate effective INSTANCE_ID");
  });
});

describe("dual-v1 rolling deployment compatibility", () => {
  it("initializes bridge metadata before Lambda, exports handoff values, and preserves old Worker SSM acquisition order", () => {
    const stackSource = readFileSync(path.resolve("infra/lib/minecraft-stack.ts"), "utf8");
    const workerLockSource = readFileSync(path.resolve("lib/server-action-lock.ts"), "utf8");
    const lambdaSource = readFileSync(path.resolve("infra/src/lambda/StartMinecraftServer/index.js"), "utf8");
    const migrationCli = readFileSync(path.resolve("scripts/aws/migrate-existing-deployment.ts"), "utf8");

    expect(stackSource).toContain("startLambda.node.addDependency(migrateLockResource)");
    expect(stackSource).toContain('new cdk.CfnOutput(this, "LifecycleLockTableName"');
    expect(stackSource).toContain('new cdk.CfnOutput(this, "OperationStateTableName"');
    expect(workerLockSource.indexOf("acquireLegacyBridgeLock")).toBeLessThan(
      workerLockSource.indexOf("acquireServerActionLock")
    );
    expect(lambdaSource).toContain("bridgeLegacyLifecycleLock");
    expect(migrationCli).toContain('"sync-worker-env"');
    expect(migrationCli).toContain("Synchronized INSTANCE_ID and DynamoDB table outputs");
  });

  it("requires Worker-first rollback and refuses to report completion while either lifecycle lock remains active", () => {
    const recoverySource = readFileSync(path.resolve("scripts/cloudflare/deploy-cloudflare.sh"), "utf8");
    const guide = readFileSync(path.resolve("docs/OPERATIONS_GUIDE.md"), "utf8");
    expect(recoverySource.indexOf("restore_recorded_routes || return 1")).toBeLessThan(
      recoverySource.indexOf("assert_lifecycle_recovery_unblocked || return 1")
    );
    expect(recoverySource.indexOf("assert_lifecycle_recovery_unblocked || return 1")).toBeLessThan(
      recoverySource.indexOf('finalize_recovery_record "rolled_back"')
    );
    expect(recoverySource).toContain("Lifecycle remains blocked by /minecraft/server-action");
    expect(recoverySource).toContain("DynamoDB lifecycle lease remains active or malformed");
    expect(guide).toContain("restore the previous Worker version first");
  });
});

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
      Properties: {
        ImageId: physicalImageId,
        UserData: { "Fn::Base64": storedUserData },
        BlockDeviceMappings: [{ DeviceName: "/dev/xvda" }],
      },
    },
  },
});

const dynamicLiveTemplate = (): CloudFormationTemplate => {
  const template = liveTemplate();
  template.Parameters = {
    [imageParameterName]: {
      Type: "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>",
      Default: "/aws/service/ami-amazon-linux-latest/example",
    },
  };
  template.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = { Ref: imageParameterName };
  return template;
};

const dynamicStackParameters = () => [
  {
    ParameterKey: imageParameterName,
    ParameterValue: "/aws/service/ami-amazon-linux-latest/example",
    ResolvedValue: physicalImageId,
  },
];

const currentTemplate = (): CloudFormationTemplate => ({
  Resources: {
    [INSTANCE_LOGICAL_ID]: {
      Type: "AWS::EC2::Instance",
      Properties: { ImageId: `ami-${"4".repeat(17)}`, UserData: "remediated", PropagateTagsToVolumeOnCreation: true },
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
          ImageId: physicalImageId,
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
  it("revalidates legacy dependencies against the exact pending template before bridge execution", () => {
    const commandSource = readFileSync(
      path.resolve(process.cwd(), "scripts/aws/migrate-existing-deployment.ts"),
      "utf8"
    );
    const executeBridgeSource = commandSource.slice(
      commandSource.indexOf("function executeBridge("),
      commandSource.indexOf("function assertStandardDeploySafe(")
    );
    expect(executeBridgeSource).toContain("assertLegacyGithubUserDataDependenciesPreserved(live, pendingTemplate)");
    expect(executeBridgeSource.indexOf("assertLegacyGithubUserDataDependenciesPreserved")).toBeLessThan(
      executeBridgeSource.indexOf('"execute-change-set"')
    );
  });

  it("refuses to delete parameters required by physical legacy GitHub UserData", () => {
    const live = liveTemplate();
    live.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] =
      "#!/bin/bash\naws ssm get-parameter --name /minecraft/github-pat\n";
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, currentTemplate())).toThrow(
      "Complete an explicit server-profile transition"
    );
    const compatible = currentTemplate();
    live.Resources[INSTANCE_LOGICAL_ID].Properties.IamInstanceProfile = { Ref: "InstanceProfile" };
    compatible.Resources.LegacyGithubPat = {
      Type: "AWS::SSM::Parameter",
      Properties: { Name: "/minecraft/github-pat", Type: "SecureString" },
    };
    compatible.Resources.InstanceProfile = {
      Type: "AWS::IAM::InstanceProfile",
      Properties: { Roles: [{ Ref: "InstanceRole" }] },
    };
    compatible.Resources.InstanceRole = {
      Type: "AWS::IAM::Role",
      Properties: {
        Policies: [
          {
            PolicyDocument: {
              Statement: [
                {
                  Effect: "Allow",
                  Action: "ssm:GetParameter",
                  Resource: {
                    "Fn::Sub":
                      "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/minecraft/github-pat",
                  },
                },
              ],
            },
          },
        ],
      },
    };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, compatible)).not.toThrow();
    const joinedArn = structuredClone(compatible);
    joinedArn.Resources.InstanceRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource = {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          ":ssm:",
          { Ref: "AWS::Region" },
          ":",
          { Ref: "AWS::AccountId" },
          ":parameter/minecraft/github-pat",
        ],
      ],
    };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, joinedArn)).not.toThrow();
    const exactCustomResource = structuredClone(compatible);
    Reflect.deleteProperty(exactCustomResource.Resources, "LegacyGithubPat");
    const putPat = JSON.stringify({
      service: "SSM",
      action: "putParameter",
      parameters: { Name: "/minecraft/github-pat", Type: "SecureString" },
    });
    exactCustomResource.Resources.LegacyGithubPatCustom = {
      Type: "Custom::AWS",
      Properties: { Create: putPat, Update: putPat },
    };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, exactCustomResource)).not.toThrow();
    const objectCallCustomResource = structuredClone(exactCustomResource);
    objectCallCustomResource.Resources.LegacyGithubPatCustom.Properties.Create = JSON.parse(putPat);
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, objectCallCustomResource)).toThrow(
      "Complete an explicit server-profile transition"
    );
    const mixedTypeCustomResource = structuredClone(exactCustomResource);
    mixedTypeCustomResource.Resources.LegacyGithubPatCustom.Properties.Update = JSON.stringify({
      service: "SSM",
      action: "putParameter",
      parameters: { Name: "/minecraft/github-pat", Type: "String" },
    });
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, mixedTypeCustomResource)).toThrow(
      "Complete an explicit server-profile transition"
    );
    const nearMatchRead = structuredClone(compatible);
    nearMatchRead.Resources.InstanceRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource =
      "arn:aws:ssm:us-west-1:123456789012:parameter/minecraft/github-pat-old";
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, nearMatchRead)).toThrow(
      "exact ssm:GetParameter"
    );
    const conditionedRead = structuredClone(compatible);
    conditionedRead.Resources.InstanceRole.Properties.Policies[0].PolicyDocument.Statement[0].Condition = {
      StringEquals: { "aws:PrincipalTag/Environment": "legacy" },
    };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, conditionedRead)).toThrow(
      "exact ssm:GetParameter"
    );
    const missingRead = structuredClone(compatible);
    missingRead.Resources.InstanceRole.Properties.Policies = [];
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, missingRead)).toThrow("exact ssm:GetParameter");
    const explicitlyDenied = structuredClone(compatible);
    explicitlyDenied.Resources.InstanceRole.Properties.Policies[0].PolicyDocument.Statement.push({
      Effect: "Deny",
      Action: "ssm:*",
      Resource: "*",
    });
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, explicitlyDenied)).toThrow(
      "exact ssm:GetParameter"
    );
    const plaintextPat = structuredClone(compatible);
    plaintextPat.Resources.LegacyGithubPat.Properties.Type = "String";
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, plaintextPat)).toThrow("SecureString");
    const customerKey = structuredClone(compatible);
    customerKey.Resources.LegacyGithubPat.Properties.KeyId = "arn:aws:kms:us-west-1:123456789012:key/key-id";
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, customerKey)).toThrow("kms:Decrypt");
    const unclearKey = structuredClone(compatible);
    unclearKey.Resources.LegacyGithubPat.Properties.KeyId = { Ref: "LegacyKey" };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, unclearKey)).toThrow("dynamic or unclear");
    customerKey.Resources.InstanceRole.Properties.Policies[0].PolicyDocument.Statement.push({
      Effect: "Allow",
      Action: "kms:Decrypt",
      Resource: "arn:aws:kms:us-west-1:123456789012:key/key-id",
    });
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, customerKey)).not.toThrow();
    const nearMatchKey = structuredClone(customerKey);
    nearMatchKey.Resources.InstanceRole.Properties.Policies[0].PolicyDocument.Statement[1].Resource =
      "arn:aws:kms:us-west-1:123456789012:key/key-id-old";
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, nearMatchKey)).toThrow("kms:Decrypt");
    const deleteOnlyCustomResource = structuredClone(compatible);
    Reflect.deleteProperty(deleteOnlyCustomResource.Resources, "LegacyGithubPat");
    deleteOnlyCustomResource.Resources.LegacyGithubPatCustom = {
      Type: "Custom::AWS",
      Properties: {
        Delete: JSON.stringify({
          service: "SSM",
          action: "deleteParameter",
          parameters: { Name: "/minecraft/github-pat" },
        }),
      },
    };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, deleteOnlyCustomResource)).toThrow(
      "Complete an explicit server-profile transition"
    );
    const splitCustomResource = structuredClone(exactCustomResource);
    splitCustomResource.Resources.LegacyGithubPatCustom.Properties.Create = JSON.stringify({
      service: "SSM",
      action: "putParameter",
      unrelated: { Name: "/minecraft/github-pat" },
      parameters: { Name: "/minecraft/github-pat-old", Type: "SecureString" },
    });
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, splitCustomResource)).toThrow(
      "Complete an explicit server-profile transition"
    );
    const unrelatedString = currentTemplate();
    unrelatedString.Resources.Unrelated = {
      Type: "AWS::SNS::Topic",
      Properties: { DisplayName: "/minecraft/github-pat" },
    };
    expect(() => assertLegacyGithubUserDataDependenciesPreserved(live, unrelatedString)).toThrow(
      "Complete an explicit server-profile transition"
    );
  });

  it("accepts the leading separator forwarded by pnpm scripts", () => {
    expect(normalizePnpmArguments(["--", "--stage", "retain"])).toEqual(["--stage", "retain"]);
    expect(normalizePnpmArguments(["--stage", "retain"])).toEqual(["--stage", "retain"]);
  });

  it("changes only legacy SES lifecycle policies in the retention stage", () => {
    const live = liveTemplate();
    const retained = buildLegacyRetentionTemplate(live);

    assertLegacyResourcesRetained(retained);
    expect(retained.Resources[INSTANCE_LOGICAL_ID]).toEqual(live.Resources[INSTANCE_LOGICAL_ID]);
    expect(live.Resources[LEGACY_RULE_SET_LOGICAL_ID].DeletionPolicy).toBe("Delete");
  });

  it("does not treat already-retained policies with a dynamic AMI parameter as fully pinned", () => {
    const retainedDynamic = buildLegacyRetentionTemplate(dynamicLiveTemplate());
    const retainedAgain = buildLegacyRetentionTemplate(retainedDynamic);
    expect(retainedAgain).toEqual(retainedDynamic);

    const pinned = pinDeployedInstanceImage(retainedAgain, dynamicStackParameters(), physicalImageId);
    expect(pinned.template).not.toEqual(retainedDynamic);
    expect(pinned.template.Parameters?.[imageParameterName].Type).toBe("AWS::EC2::Image::Id");
    expect(pinned.parameterOverrides).toEqual({ [imageParameterName]: physicalImageId });
  });

  const completedRetentionTemplate = (): CloudFormationTemplate => {
    const completed = buildLegacyRetentionTemplate(dynamicLiveTemplate());
    completed.Parameters![imageParameterName] = {
      Type: "AWS::EC2::Image::Id",
      Default: physicalImageId,
    };
    completed.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = "#!/bin/bash\nprintf 'Gr??e ?'\n";
    return completed;
  };
  const pinnedStackParameters = () => [{ ParameterKey: imageParameterName, ParameterValue: physicalImageId }];

  it("treats retained, pinned, API-normalized UserData as a completed Stage 1", () => {
    expect(
      isRetentionStageComplete(
        completedRetentionTemplate(),
        pinnedStackParameters(),
        physicalImageId,
        actualUserDataBytes
      )
    ).toBe(true);
  });

  it("requires Stage 1 when the deployed AMI parameter remains dynamic", () => {
    const dynamic = buildLegacyRetentionTemplate(dynamicLiveTemplate());
    dynamic.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = "#!/bin/bash\nprintf 'Gr??e ?'\n";

    expect(isRetentionStageComplete(dynamic, dynamicStackParameters(), physicalImageId, actualUserDataBytes)).toBe(
      false
    );
  });

  it("requires Stage 1 when either legacy Retain policy is missing", () => {
    const missingRetain = completedRetentionTemplate();
    missingRetain.Resources[LEGACY_RULE_SET_LOGICAL_ID].DeletionPolicy = "Delete";

    expect(isRetentionStageComplete(missingRetain, pinnedStackParameters(), physicalImageId, actualUserDataBytes)).toBe(
      false
    );
  });

  it("requires Stage 1 when stored UserData changes physical ASCII bytes", () => {
    const wrongAscii = completedRetentionTemplate();
    wrongAscii.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = "#!/bin/bash\nprintf 'Wrong ASCII'\n";

    expect(isRetentionStageComplete(wrongAscii, pinnedStackParameters(), physicalImageId, actualUserDataBytes)).toBe(
      false
    );
  });

  it("pins the complete deployed instance resource while taking all other resources from current CDK", () => {
    const retained = buildLegacyRetentionTemplate(liveTemplate());
    const current = currentTemplate();
    const bridge = buildPinnedInstanceBridgeTemplate(
      retained,
      current,
      [],
      physicalImageId,
      storedUserDataBytes
    ).template;

    expect(bridge.Resources[INSTANCE_LOGICAL_ID]).toEqual(retained.Resources[INSTANCE_LOGICAL_ID]);
    expect(bridge.Resources.WorkerRuntimeUser).toEqual(current.Resources.WorkerRuntimeUser);
    expect(bridge.Resources[LEGACY_RULE_SET_LOGICAL_ID]).toBeUndefined();
    expect(bridge.Resources[LEGACY_ACTIVATION_LOGICAL_ID]).toBeUndefined();
  });

  it("converts only the dynamic ImageId parameter while preserving the EC2 property bytes", () => {
    const live = dynamicLiveTemplate();
    const originalImageExpression = JSON.stringify(live.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId);
    const originalInstance = JSON.stringify(live.Resources[INSTANCE_LOGICAL_ID]);
    const pinned = pinDeployedInstanceImage(live, dynamicStackParameters(), physicalImageId);

    expect(pinned.template.Parameters?.[imageParameterName]).toEqual({
      Type: "AWS::EC2::Image::Id",
      Default: physicalImageId,
    });
    expect(pinned.parameterOverrides).toEqual({ [imageParameterName]: physicalImageId });
    expect(JSON.stringify(pinned.template.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId)).toBe(
      originalImageExpression
    );
    expect(JSON.stringify(pinned.template.Resources[INSTANCE_LOGICAL_ID])).toBe(originalInstance);
    expect(live.Parameters?.[imageParameterName].Type).toBe("AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>");
  });

  it("adopts exact decoded physical UserData bytes into only a literal Fn::Base64 string", () => {
    const live = liveTemplate();
    const expected = structuredClone(live);
    expected.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = actualUserData;

    const adopted = adoptActualInstanceUserData(live, actualUserDataBytes);

    expect(adopted).toEqual(expected);
    expect(live.Resources[INSTANCE_LOGICAL_ID].Properties.UserData).toEqual({ "Fn::Base64": storedUserData });
    expect(Buffer.from(adopted.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"], "utf8")).toEqual(
      actualUserDataBytes
    );
  });

  it("rejects malformed UserData shapes and empty or invalid decoded bytes", () => {
    for (const malformedUserData of [
      storedUserData,
      { "Fn::Base64": { Ref: "UserDataParameter" } },
      { "Fn::Base64": storedUserData, Extra: true },
      { Other: storedUserData },
    ]) {
      const malformed = liveTemplate();
      malformed.Resources[INSTANCE_LOGICAL_ID].Properties.UserData = malformedUserData;
      expect(() => adoptActualInstanceUserData(malformed, actualUserDataBytes)).toThrow(
        /exactly one literal Fn::Base64 string/
      );
    }
    expect(() => adoptActualInstanceUserData(liveTemplate(), Buffer.alloc(0))).toThrow(/nonempty decoded bytes/);
    expect(() => adoptActualInstanceUserData(liveTemplate(), Buffer.from([0xc3, 0x28]))).toThrow(/not valid UTF-8/);
  });

  it("decodes only identity-bound canonical base64 UserData attribute responses", () => {
    const response = { InstanceId: instanceId, UserData: { Value: actualUserDataBytes.toString("base64") } };
    expect(decodeInstanceUserDataAttribute(instanceId, response)).toEqual(actualUserDataBytes);
    expect(() => decodeInstanceUserDataAttribute(`i-${"9".repeat(17)}`, response)).toThrow(/ownership-proven/);
    expect(() =>
      decodeInstanceUserDataAttribute(instanceId, { InstanceId: instanceId, UserData: { Value: "" } })
    ).toThrow(/nonempty canonical base64/);
    expect(() =>
      decodeInstanceUserDataAttribute(instanceId, { InstanceId: instanceId, UserData: { Value: "YR==" } })
    ).toThrow(/does not round-trip as canonical base64/);
  });

  it("proves adopted template UserData and physical bytes remain byte-exact", () => {
    const adopted = adoptActualInstanceUserData(liveTemplate(), actualUserDataBytes);
    expect(() =>
      assertInstanceUserDataTransition(adopted, structuredClone(adopted), actualUserDataBytes)
    ).not.toThrow();

    const changed = structuredClone(adopted);
    changed.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = actualUserData.trimEnd();
    expect(() => assertInstanceUserDataTransition(adopted, changed, actualUserDataBytes)).toThrow(
      /neither the exact physical UTF-8 text/
    );
    expect(() =>
      assertInstanceUserDataTransition(adopted, adopted, Buffer.from(`${actualUserData}extra`, "utf8"))
    ).toThrow(/neither the exact physical UTF-8 text/);
  });

  it("accepts only exact or complete CloudFormation question-mark normalization of physical Unicode", () => {
    const physical = "prefix\u202Fmiddle-é-💾\n";
    const physicalBytes = Buffer.from(physical, "utf8");
    const exact = adoptActualInstanceUserData(liveTemplate(), physicalBytes);
    const normalized = structuredClone(exact);
    normalized.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = "prefix?middle-?-?\n";

    expect(() => assertInstanceUserDataTransition(exact, normalized, physicalBytes)).not.toThrow();
    expect(() => assertInstanceUserDataTransition(normalized, exact, physicalBytes)).not.toThrow();

    const rejectedRepresentations = [
      "Prefix?middle-?-?\n",
      "prefix?middle-?-?",
      "prefix?middle-?-?\nextra",
      "prefix?middle-é-?\n",
      "prefix!middle-?-?\n",
      "prefix\u00A0middle-?-?\n",
    ];
    for (const rejected of rejectedRepresentations) {
      const candidate = structuredClone(exact);
      candidate.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = rejected;
      expect(() => assertInstanceUserDataTransition(exact, candidate, physicalBytes)).toThrow(
        /neither the exact physical UTF-8 text/
      );
    }
  });

  it("refuses mismatched effective values and malformed or unsupported ImageId refs", () => {
    const mismatched = dynamicStackParameters();
    mismatched[0].ResolvedValue = `ami-${"9".repeat(17)}`;
    expect(() => pinDeployedInstanceImage(dynamicLiveTemplate(), mismatched, physicalImageId)).toThrow(
      /ResolvedValue.*does not exactly match/
    );

    const malformed = dynamicLiveTemplate();
    malformed.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = { Ref: imageParameterName, Extra: true };
    expect(() => pinDeployedInstanceImage(malformed, dynamicStackParameters(), physicalImageId)).toThrow(
      /one exact parameter Ref/
    );

    const unsupported = dynamicLiveTemplate();
    if (unsupported.Parameters) unsupported.Parameters[imageParameterName].Type = "String";
    expect(() => pinDeployedInstanceImage(unsupported, dynamicStackParameters(), physicalImageId)).toThrow(
      /unsupported type/
    );
  });

  it("rejects dynamic ImageId parameter reuse in non-resource sections and Fn::Sub", () => {
    const outputReuse = dynamicLiveTemplate();
    outputReuse.Outputs = { ReusedAmi: { Value: { Ref: imageParameterName } } };
    expect(() => pinDeployedInstanceImage(outputReuse, dynamicStackParameters(), physicalImageId)).toThrow(
      /2 direct Ref\(s\).*[0] Fn::Sub/
    );

    const subReuse = dynamicLiveTemplate();
    subReuse.Metadata = { ReusedAmi: { "Fn::Sub": `ami=${"${SsmParameterValueLatestAmi}"}` } };
    expect(() => pinDeployedInstanceImage(subReuse, dynamicStackParameters(), physicalImageId)).toThrow(
      /1 direct Ref\(s\).*1 Fn::Sub/
    );
  });

  it("handles already-literal and already-pinned ImageIds only when their effective AMI is exact", () => {
    expect(pinDeployedInstanceImage(liveTemplate(), [], physicalImageId).parameterOverrides).toEqual({});
    expect(() => pinDeployedInstanceImage(liveTemplate(), [], `ami-${"9".repeat(17)}`)).toThrow(
      /Literal.*does not exactly match/
    );

    const pinnedLive = dynamicLiveTemplate();
    if (pinnedLive.Parameters) {
      pinnedLive.Parameters[imageParameterName] = { Type: "AWS::EC2::Image::Id", Default: physicalImageId };
    }
    const deployed = [{ ParameterKey: imageParameterName, ParameterValue: physicalImageId }];
    expect(pinDeployedInstanceImage(pinnedLive, deployed, physicalImageId).parameterOverrides).toEqual({
      [imageParameterName]: physicalImageId,
    });
    deployed[0].ParameterValue = `ami-${"8".repeat(17)}`;
    expect(() => pinDeployedInstanceImage(pinnedLive, deployed, physicalImageId)).toThrow(
      /ParameterValue.*does not exactly match/
    );
  });

  it("uses an explicit pinned parameter override instead of UsePreviousValue", () => {
    const live = dynamicLiveTemplate();
    const target = dynamicLiveTemplate();
    target.Parameters = {
      ...target.Parameters,
      ExistingParameter: { Type: "String" },
      NewRequiredParameter: { Type: "String" },
    };
    live.Parameters = { ...live.Parameters, ExistingParameter: { Type: "String" } };

    expect(
      buildChangeSetParameters(
        target,
        live,
        { [imageParameterName]: physicalImageId },
        { MC_AWS_MIGRATION_PARAMETER_NewRequiredParameter: "new-value" }
      )
    ).toEqual([
      { ParameterKey: "ExistingParameter", UsePreviousValue: true },
      { ParameterKey: "NewRequiredParameter", ParameterValue: "new-value" },
      { ParameterKey: imageParameterName, ParameterValue: physicalImageId },
    ]);
    expect(() => buildChangeSetParameters(target, live, { UnknownParameter: physicalImageId }, {})).toThrow(
      /unknown or malformed/
    );
  });

  it("preserves the live instance Ref and pinned parameter definition/value in the stage-3 bridge", () => {
    const retained = buildLegacyRetentionTemplate(dynamicLiveTemplate());
    const current = currentTemplate();
    current.Parameters = {
      [imageParameterName]: {
        Type: "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>",
        Default: "/aws/service/ami-amazon-linux-latest/newer",
      },
    };
    const bridge = buildPinnedInstanceBridgeTemplate(
      retained,
      current,
      dynamicStackParameters(),
      physicalImageId,
      actualUserDataBytes
    );

    expect(bridge.template.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId).toEqual({ Ref: imageParameterName });
    expect(bridge.template.Parameters?.[imageParameterName]).toEqual({
      Type: "AWS::EC2::Image::Id",
      Default: physicalImageId,
    });
    expect(bridge.parameterOverrides).toEqual({ [imageParameterName]: physicalImageId });
    expect(bridge.template.Resources[INSTANCE_LOGICAL_ID].Properties.UserData).toEqual({
      "Fn::Base64": actualUserData,
    });
  });

  it("validates the exact pending and deployed pinned-image template/parameter state", () => {
    const live = buildLegacyRetentionTemplate(dynamicLiveTemplate());
    const bridge = buildPinnedInstanceBridgeTemplate(
      live,
      currentTemplate(),
      dynamicStackParameters(),
      physicalImageId,
      storedUserDataBytes
    );
    const explicitParameters = [{ ParameterKey: imageParameterName, ParameterValue: physicalImageId }];

    expect(() =>
      assertPinnedInstanceImageTransition(live, bridge.template, explicitParameters, physicalImageId, true)
    ).not.toThrow();
    expect(() =>
      assertPinnedInstanceImageTransition(
        live,
        bridge.template,
        [{ ...explicitParameters[0], UsePreviousValue: true }],
        physicalImageId,
        true
      )
    ).toThrow(/does not explicitly supply/);
    expect(() =>
      assertPinnedInstanceImageTransition(live, dynamicLiveTemplate(), dynamicStackParameters(), physicalImageId, true)
    ).toThrow(/does not already contain the exact pinned/);

    const changedExpression = structuredClone(bridge.template);
    changedExpression.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = physicalImageId;
    expect(() =>
      assertPinnedInstanceImageTransition(live, changedExpression, explicitParameters, physicalImageId, true)
    ).toThrow(/changed the deployed EC2 ImageId expression/);
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

  it("does not include property value previews when rejecting an EC2 change", () => {
    expect(() =>
      assertSafeRetentionChangeSet([
        {
          ResourceChange: {
            LogicalResourceId: INSTANCE_LOGICAL_ID,
            Action: "Modify",
            Replacement: "Conditional",
            Scope: ["Properties"],
            Details: [
              {
                ChangeSource: "DirectModification",
                Evaluation: "Static",
                Target: {
                  Attribute: "Properties",
                  Name: "UserData",
                  RequiresRecreation: "Always",
                  BeforeValue: "sensitive-before",
                  AfterValue: "sensitive-after",
                },
              },
            ],
          },
        },
      ])
    ).toThrow(/beforeAfterEqual.*beforeLength.*afterLength/);
    try {
      assertSafeRetentionChangeSet([
        {
          ResourceChange: {
            LogicalResourceId: INSTANCE_LOGICAL_ID,
            Action: "Modify",
            Details: [{ Target: { BeforeValue: "sensitive-before", AfterValue: "sensitive-after" } }],
          },
        },
      ]);
    } catch (error) {
      expect((error as Error).message).not.toContain("sensitive-before");
      expect((error as Error).message).not.toContain("sensitive-after");
    }
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

  it("blocks ordinary deployment when physical UserData differs or retains legacy dependencies", () => {
    const pinnedImageId = `ami-${"5".repeat(17)}`;
    const live = currentTemplate();
    live.Resources[INSTANCE_LOGICAL_ID].Properties.ImageId = pinnedImageId;
    live.Resources[INSTANCE_LOGICAL_ID].Properties.UserData = { "Fn::Base64": "#!/bin/bash\nprintf safe\n" };
    const current = JSON.parse(JSON.stringify(live));

    expect(() =>
      assertStandardDeploymentInstanceSafe(
        live,
        current,
        Buffer.from("#!/bin/bash\naws ssm get-parameter --name /minecraft/github-pat\n")
      )
    ).toThrow(/physical UTF-8 text/);

    const legacyPhysical = "#!/bin/bash\naws ssm get-parameter --name /minecraft/github-pat\n";
    live.Resources[INSTANCE_LOGICAL_ID].Properties.UserData = { "Fn::Base64": legacyPhysical };
    current.Resources[INSTANCE_LOGICAL_ID] = JSON.parse(JSON.stringify(live.Resources[INSTANCE_LOGICAL_ID]));
    expect(() => assertStandardDeploymentInstanceSafe(live, current, Buffer.from(legacyPhysical))).toThrow(
      "Complete an explicit server-profile transition"
    );
  });

  it("allows later pinned-instance bridges after both legacy resources are no longer managed", () => {
    const postBridgeLive = currentTemplate();
    postBridgeLive.Resources[INSTANCE_LOGICAL_ID] = liveTemplate().Resources[INSTANCE_LOGICAL_ID];

    expect(() =>
      buildPinnedInstanceBridgeTemplate(postBridgeLive, currentTemplate(), [], physicalImageId, storedUserDataBytes)
    ).not.toThrow();
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
  it("accepts only completed stable stack statuses, including a completed update rollback", () => {
    for (const status of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]) {
      expect(isStableMigrationStackStatus(status)).toBe(true);
    }
    for (const status of [
      "CREATE_IN_PROGRESS",
      "UPDATE_IN_PROGRESS",
      "UPDATE_FAILED",
      "UPDATE_ROLLBACK_IN_PROGRESS",
      "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
      "UPDATE_ROLLBACK_FAILED",
      "ROLLBACK_COMPLETE",
      undefined,
    ]) {
      expect(isStableMigrationStackStatus(status)).toBe(false);
    }
  });

  it("keeps migration dry-run by default and guards routine setup/CDK deployment", () => {
    const root = path.resolve(process.cwd());
    const migrationCli = readFileSync(path.join(root, "scripts/aws/migrate-existing-deployment.ts"), "utf8");
    const migrationContracts = readFileSync(path.join(root, "scripts/aws/existing-deployment-migration.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const deployOrchestrator = readFileSync(path.join(root, "scripts/aws/deploy-cdk.ts"), "utf8");
    const setup = readFileSync(path.join(root, "setup.sh"), "utf8");

    expect(migrationCli).toContain('stage: "plan"');
    expect(migrationCli).toContain("DRY RUN ONLY");
    expect(migrationCli.match(/--include-property-values/g)).toHaveLength(2);
    expect(migrationCli).toContain('"--unstable=publish-assets"');
    expect(migrationCli).toContain('"describe-instance-attribute"');
    expect(migrationContracts).not.toContain("beforePreview");
    expect(migrationContracts).not.toContain("afterPreview");
    expect(packageJson.scripts["cdk:deploy"]).toContain("scripts/aws/deploy-cdk.ts");
    expect(deployOrchestrator).toContain("--assert-standard-deploy-safe");
    expect(deployOrchestrator.indexOf("--assert-standard-deploy-safe")).toBeLessThan(
      deployOrchestrator.indexOf("dependencies.materialize")
    );
    expect(setup).toContain("scripts/aws/migrate-existing-deployment.ts");
    expect(setup).toContain("--assert-standard-deploy-safe");
  });

  it("requires exclusive-writer acknowledgment only for an executing tags stage", () => {
    expect(() => assertExclusiveTaggingAcknowledged("tags", true, false)).toThrow(/confirm-exclusive-tagging/);
    expect(() => assertExclusiveTaggingAcknowledged("tags", true, true)).not.toThrow();
    expect(() => assertExclusiveTaggingAcknowledged("plan", false, false)).not.toThrow();
    expect(() => assertExclusiveTaggingAcknowledged("retain", true, false)).not.toThrow();

    const migrationCli = readFileSync(path.join(process.cwd(), "scripts/aws/migrate-existing-deployment.ts"), "utf8");
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

describe("CloudFormation bridge template transport", () => {
  const identity = { accountId: "123456789012", region: "us-west-1", stackId, stackName: "MinecraftStack" };
  const assetUrl = "s3://cdk-test-assets-123456789012-us-west-1/template.json";

  it("keeps small templates inline", () => {
    expect(cloudFormationTemplateTransport(identity, assetUrl, "{}")).toEqual({
      kind: "inline",
      request: { TemplateBody: "{}" },
    });
  });

  it("uses a content-addressed template URL for larger templates", () => {
    const transport = cloudFormationTemplateTransport(identity, assetUrl, "x".repeat(51_201));
    expect(transport.kind).toBe("s3");
    if (transport.kind !== "s3") throw new Error("expected S3 template transport");
    expect(transport.bucket).toBe("cdk-test-assets-123456789012-us-west-1");
    expect(transport.key).toMatch(/^mc-aws-bridge-templates\/[a-f0-9]{64}\.json$/);
    expect(transport.request.TemplateURL).toBe(
      `https://${transport.bucket}.s3.us-west-1.amazonaws.com/${transport.key}`
    );
    expect(transport.checksumSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(transport.byteLength).toBe(51_201);
  });

  it("rejects oversized templates and an unexpected asset bucket", () => {
    expect(() => cloudFormationTemplateTransport(identity, assetUrl, "x".repeat(460_801))).toThrow(/460,800-byte/);
    expect(() =>
      cloudFormationTemplateTransport(
        identity,
        "s3://cdk-test-assets-999999999999-us-west-1/template.json",
        "x".repeat(51_201)
      )
    ).toThrow(/confirmed account and region/);
  });
});
