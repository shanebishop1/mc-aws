import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { MinecraftStack } from "./minecraft-stack";
import {
  createWorkerRuntimePolicyStatements,
  workerRuntimeAwsCallGraph,
  workerRuntimeRequiredAwsActions,
} from "./worker-runtime-policy";

const stackSourcePath = path.resolve(process.cwd(), "infra/lib/minecraft-stack.ts");

describe("minecraft-stack SecureString/KMS policy contract", () => {
  it("scopes decryption context to exact EC2-readable SecureString parameters", () => {
    const source = readFileSync(stackSourcePath, "utf8");

    expect(source).toContain('actions: ["kms:Decrypt"]');
    expect(source).toContain("resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`]");
    expect(source).toContain("StringEquals");
    expect(source).toContain('"kms:EncryptionContext:PARAMETER_ARN": ec2EncryptedParameters.map(ec2ParameterArn)');
  });
});

const sesEnvironmentNames = [
  "SES_NOTIFICATIONS_ENABLED",
  "SES_INBOUND_COMMANDS_ENABLED",
  "VERIFIED_SENDER",
  "NOTIFICATION_EMAIL",
  "SES_INBOUND_RECIPIENT",
  "SES_RECEIPT_RULE_SET_NAME",
  "START_KEYWORD",
] as const;

const stackEnvironmentNames = [
  ...sesEnvironmentNames,
  "GDRIVE_REMOTE",
  "GDRIVE_ROOT",
  "AL2023_ARM64_AMI_ID",
  "MC_SERVER_PROFILE_DIR",
  "MC_ALLOW_EMPTY_WHITELIST",
] as const;

const synthesizeStack = (stackEnvironment: Partial<Record<(typeof stackEnvironmentNames)[number], string>> = {}) => {
  const previousEnvironment = Object.fromEntries(stackEnvironmentNames.map((name) => [name, process.env[name]]));
  for (const name of stackEnvironmentNames) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    AL2023_ARM64_AMI_ID: `ami-${"1".repeat(17)}`,
    MC_ALLOW_EMPTY_WHITELIST: "true",
    ...stackEnvironment,
  });

  const app = new cdk.App();
  const account = "111111111111";
  const region = "us-west-1";
  app.node.setContext(
    `vpc-provider:account=${account}:filter.isDefault=true:region=${region}:returnAsymmetricSubnets=true`,
    {
      vpcId: "vpc-12345",
      vpcCidrBlock: "10.0.0.0/16",
      ownerAccountId: account,
      availabilityZones: [],
      subnetGroups: [
        {
          name: "Public",
          type: "Public",
          subnets: [
            {
              subnetId: "subnet-12345",
              cidr: "10.0.0.0/24",
              availabilityZone: "us-west-1a",
              routeTableId: "rtb-12345",
            },
          ],
        },
      ],
    }
  );
  try {
    return Template.fromStack(new MinecraftStack(app, "MinecraftStack", { env: { account, region } }));
  } finally {
    for (const name of stackEnvironmentNames) {
      const previousValue = previousEnvironment[name];
      if (previousValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousValue;
      }
    }
  }
};

describe("minecraft-stack user data shell quoting", () => {
  it("keeps synthesized UserData ASCII-stable across CloudFormation GetTemplate", () => {
    const template = synthesizeStack();
    const instance = Object.values(template.findResources("AWS::EC2::Instance"))[0];
    const userData = instance.Properties.UserData["Fn::Base64"] as string;

    expect([...userData].every((character) => character.codePointAt(0)! <= 0x7f)).toBe(true);
  });

  it("synthesizes Drive settings as literal data instead of executable shell syntax", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-user-data-shell-quote-"));
    const markerPath = path.join(rootDir, "injected");
    const driveRemote = `drive'$(touch "${markerPath}")`;
    const driveRoot = `nested/it's; touch "${markerPath}"; \$(touch "${markerPath}")`;

    try {
      const template = synthesizeStack({ GDRIVE_REMOTE: driveRemote, GDRIVE_ROOT: driveRoot });
      const instances = template.findResources("AWS::EC2::Instance");
      const instance = Object.values(instances)[0];
      const userData = instance.Properties.UserData["Fn::Base64"] as string;
      const exportLines = userData.split("\n").slice(0, 3).join("\n");
      const result = spawnSync("bash", ["-c", `${exportLines}\nprintf '%s\\n%s\\n' "$GDRIVE_REMOTE" "$GDRIVE_ROOT"`], {
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${driveRemote}\n${driveRoot}\n`);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("minecraft-stack server profile assets", () => {
  it("publishes separate runtime/profile assets with one atomic SSM manifest and exact object reads", () => {
    const template = synthesizeStack();
    const json = template.toJSON();
    const serialized = JSON.stringify(json);
    const parameters = Object.values(template.findResources("AWS::SSM::Parameter"));
    const manifest = parameters.find((resource) => resource.Properties.Name === "/minecraft/server-profile-manifest");

    expect(manifest).toBeDefined();
    expect(JSON.stringify(manifest?.Properties.Value)).toContain('\\"version\\":1');
    expect(JSON.stringify(manifest?.Properties.Value)).toMatch(/sha256/);
    expect(JSON.stringify(manifest?.Properties.Value)).toContain("s3://");
    expect(serialized).not.toContain("/minecraft/github-");
    expect(json.Parameters ?? {}).not.toHaveProperty("GithubTokenParam");

    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement
    );
    const s3Reads = statements.filter((statement) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes("s3:GetObject")
    );
    expect(s3Reads).toHaveLength(1);
    expect(s3Reads[0].Resource).toHaveLength(2);
    expect(JSON.stringify(s3Reads[0].Resource)).toContain(".zip");
    expect(JSON.stringify(s3Reads[0].Resource)).not.toContain("/*");
    expect(statements.some((statement) => statement.Action === "s3:ListBucket")).toBe(false);
    expect(JSON.stringify(statements)).not.toContain("s3:GetObjectVersion");
  });

  it("keeps the profile manifest read-only and scopes EC2 SSM mutations to root-script paths", () => {
    const template = synthesizeStack();
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement
    );
    const actionsFor = (statement: Record<string, unknown>) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resourcesFor = (statement: Record<string, unknown>) =>
      (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]).map(String);
    const getStatement = statements.find(
      (statement) =>
        actionsFor(statement).includes("ssm:GetParameter") &&
        resourcesFor(statement).some((resource) => resource.includes("server-profile-manifest"))
    );
    const putStatement = statements.find(
      (statement) =>
        actionsFor(statement).length === 1 &&
        actionsFor(statement).includes("ssm:PutParameter") &&
        resourcesFor(statement).some((resource) => resource.includes("player-count"))
    );
    const deleteStatement = statements.find(
      (statement) =>
        actionsFor(statement).length === 1 &&
        actionsFor(statement).includes("ssm:DeleteParameter") &&
        resourcesFor(statement).some((resource) => resource.includes("startup-triggered-by"))
    );

    expect(getStatement).toBeDefined();
    expect(resourcesFor(getStatement!)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("server-profile-manifest"),
        expect.stringContaining("resume-pending"),
        expect.stringContaining("gdrive-token"),
        expect.stringContaining("cloudflare-api-token"),
        expect.stringContaining("duckdns-token"),
      ])
    );
    expect(actionsFor(getStatement!)).not.toContain("ssm:PutParameter");
    expect(actionsFor(getStatement!)).not.toContain("ssm:DeleteParameter");
    expect(resourcesFor(putStatement!)).toEqual([expect.stringContaining("player-count")]);
    expect(resourcesFor(deleteStatement!)).toEqual([expect.stringContaining("startup-triggered-by")]);
    expect(JSON.stringify(statements)).not.toContain("parameter/minecraft/*");
  });

  it("keeps the repository root and user data out of file asset sources", () => {
    const app = new cdk.App();
    app.node.setContext(
      "vpc-provider:account=111111111111:filter.isDefault=true:region=us-west-1:returnAsymmetricSubnets=true",
      {
        vpcId: "vpc-12345",
        vpcCidrBlock: "10.0.0.0/16",
        ownerAccountId: "111111111111",
        availabilityZones: [],
        subnetGroups: [
          {
            name: "Public",
            type: "Public",
            subnets: [
              {
                subnetId: "subnet-12345",
                cidr: "10.0.0.0/24",
                availabilityZone: "us-west-1a",
                routeTableId: "rtb-12345",
              },
            ],
          },
        ],
      }
    );
    const previous = process.env.AL2023_ARM64_AMI_ID;
    process.env.AL2023_ARM64_AMI_ID = `ami-${"1".repeat(17)}`;
    const previousAllowEmpty = process.env.MC_ALLOW_EMPTY_WHITELIST;
    process.env.MC_ALLOW_EMPTY_WHITELIST = "true";
    try {
      const stack = new MinecraftStack(app, "MinecraftStack", {
        env: { account: "111111111111", region: "us-west-1" },
      });
      const assets = stack.node
        .findAll()
        .filter(
          (node) =>
            node.node.path.includes("MinecraftRuntimeAsset") || node.node.path.includes("MinecraftServerProfileAsset")
        );
      expect(assets.length).toBeGreaterThanOrEqual(2);
      expect(readFileSync(path.resolve(process.cwd(), "infra/src/ec2/user_data.sh"), "utf8")).not.toContain(
        "MC_SERVER_PROFILE_DIR"
      );
    } finally {
      if (previous === undefined) process.env.AL2023_ARM64_AMI_ID = undefined;
      else process.env.AL2023_ARM64_AMI_ID = previous;
      if (previousAllowEmpty === undefined) process.env.MC_ALLOW_EMPTY_WHITELIST = undefined;
      else process.env.MC_ALLOW_EMPTY_WHITELIST = previousAllowEmpty;
    }
  });
});

describe("minecraft-stack optional SES contract", () => {
  const allIamStatements = (template: Template) =>
    Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement
    );
  const actionsFor = (statement: Record<string, unknown>) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action];

  it("creates no inbound SES resources or send permissions when both capabilities are disabled", () => {
    const template = synthesizeStack({
      SES_NOTIFICATIONS_ENABLED: "false",
      SES_INBOUND_COMMANDS_ENABLED: "false",
    });

    expect(template.findResources("AWS::SES::ReceiptRule")).toEqual({});
    expect(template.findResources("AWS::SES::ReceiptRuleSet")).toEqual({});
    expect(template.findResources("AWS::SNS::Topic")).toEqual({});
    expect(
      allIamStatements(template).some((statement) =>
        actionsFor(statement).some((action) => typeof action === "string" && action.startsWith("ses:"))
      )
    ).toBe(false);
  });

  it("grants identity-scoped send access without inbound resources in notifications-only mode", () => {
    const template = synthesizeStack({
      SES_NOTIFICATIONS_ENABLED: "true",
      SES_INBOUND_COMMANDS_ENABLED: "false",
      VERIFIED_SENDER: "sender@example.net",
      NOTIFICATION_EMAIL: "operator@example.net",
    });

    expect(template.findResources("AWS::SES::ReceiptRule")).toEqual({});
    expect(template.findResources("AWS::SES::ReceiptRuleSet")).toEqual({});
    expect(template.findResources("AWS::SNS::Topic")).toEqual({});
    const sendStatements = allIamStatements(template).filter((statement) =>
      actionsFor(statement).includes("ses:SendEmail")
    );
    expect(sendStatements).toHaveLength(2);
    for (const statement of sendStatements) {
      expect(JSON.stringify(statement.Resource)).toContain(
        "arn:aws:ses:us-west-1:111111111111:identity/sender@example.net"
      );
      expect(statement.Resource).not.toBe("*");
    }
  });

  it("adds only the project rule to an explicitly named existing rule set in inbound mode", () => {
    const template = synthesizeStack({
      SES_NOTIFICATIONS_ENABLED: "false",
      SES_INBOUND_COMMANDS_ENABLED: "true",
      SES_INBOUND_RECIPIENT: "commands@example.net",
      SES_RECEIPT_RULE_SET_NAME: "operator-managed-rules",
      START_KEYWORD: "private-keyword",
    });

    expect(template.findResources("AWS::SES::ReceiptRuleSet")).toEqual({});
    expect(Object.keys(template.findResources("AWS::SES::ReceiptRule"))).toHaveLength(1);
    template.hasResourceProperties("AWS::SES::ReceiptRule", {
      RuleSetName: "operator-managed-rules",
      Rule: Match.objectLike({
        Name: "mc-aws-MinecraftStack-inbound-commands",
        Recipients: ["commands@example.net"],
      }),
    });
    expect(Object.keys(template.findResources("AWS::SNS::Topic"))).toHaveLength(1);
    expect(JSON.stringify(template.toJSON())).not.toContain("SetActiveReceiptRuleSet");
    expect(allIamStatements(template).some((statement) => actionsFor(statement).includes("ses:SendEmail"))).toBe(false);
  });
});

describe("minecraft-stack lifecycle Lambda IAM contract", () => {
  it("synthesizes all lifecycle EC2 permissions with mutation scope and ownership conditions", () => {
    const template = synthesizeStack();
    const lambdas = template.findResources("AWS::Lambda::Function");
    const [, startLambda] = Object.entries(lambdas).find(([, resource]) =>
      Boolean(resource.Properties?.Environment?.Variables?.INSTANCE_ID)
    )!;
    const roleLogicalId = startLambda.Properties.Role["Fn::GetAtt"][0];
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((resource) =>
      resource.Properties.Roles?.some((role: { Ref?: string }) => role.Ref === roleLogicalId)
    );
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const actionsFor = (statement: Record<string, unknown>) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const statementFor = (action: string, resourceFragment?: string) =>
      statements.find(
        (statement) =>
          actionsFor(statement).includes(action) &&
          (!resourceFragment || JSON.stringify(statement.Resource).includes(resourceFragment))
      );

    for (const action of ["ec2:DescribeInstances", "ec2:DescribeImages", "ec2:DescribeVolumes"]) {
      expect(statementFor(action)?.Resource).toBe("*");
    }

    for (const action of ["ec2:StartInstances", "ec2:StopInstances", "ec2:AttachVolume", "ec2:DetachVolume"]) {
      const statement = statementFor(action, "instance/");
      expect(statement).toBeDefined();
      expect(statement?.Resource).not.toBe("*");
    }

    for (const action of ["ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume"]) {
      const statement = statementFor(action, "volume/*");
      expect(statement?.Condition?.StringEquals).toMatchObject({
        "ec2:ResourceTag/McAwsProject": "mc-aws",
        "ec2:ResourceTag/McAwsStack": "MinecraftStack",
        "ec2:ResourceTag/McAwsManagedRoot": "true",
      });
    }

    const createVolumeStatement = statementFor("ec2:CreateVolume", "volume/*");
    expect(createVolumeStatement?.Condition?.StringEquals).toMatchObject({
      "aws:RequestTag/McAwsProject": "mc-aws",
      "aws:RequestTag/McAwsStack": "MinecraftStack",
      "aws:RequestTag/McAwsManagedRoot": "true",
      "aws:RequestTag/McAwsReconstructed": "true",
    });
    expect(statementFor("ec2:CreateVolume", "snapshot/*")).toBeDefined();
    expect(statementFor("ec2:CreateTags", "volume/*")?.Condition?.StringEquals).toMatchObject({
      "ec2:CreateAction": "CreateVolume",
      "aws:RequestTag/McAwsProject": "mc-aws",
    });

    const mutations = new Set([
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:CreateVolume",
      "ec2:CreateTags",
      "ec2:AttachVolume",
      "ec2:DetachVolume",
      "ec2:DeleteVolume",
    ]);
    expect(
      statements.some(
        (statement) => statement.Resource === "*" && actionsFor(statement).some((action) => mutations.has(action))
      )
    ).toBe(false);
  });

  it("propagates project ownership tags to the initial root volume", () => {
    const template = synthesizeStack();
    template.hasResourceProperties("AWS::EC2::Instance", {
      PropagateTagsToVolumeOnCreation: true,
      Tags: Match.arrayWith([
        { Key: "McAwsManagedRoot", Value: "true" },
        { Key: "McAwsProject", Value: "mc-aws" },
        { Key: "McAwsStack", Value: "MinecraftStack" },
      ]),
    });
  });
});

describe("minecraft-stack immutable AMI contract", () => {
  it("synthesizes the exact configured AMI without a latest-SSM parameter", () => {
    const imageId = `ami-${"a".repeat(17)}`;
    const template = synthesizeStack({ AL2023_ARM64_AMI_ID: imageId }).toJSON();
    const instance = Object.values(
      template.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>
    ).find((resource) => resource.Type === "AWS::EC2::Instance");

    expect(instance?.Properties.ImageId).toBe(imageId);
    expect(JSON.stringify(template)).not.toContain("ami-amazon-linux-latest");
    expect(JSON.stringify(template.Parameters ?? {})).not.toContain("AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>");
  });

  it("fails synthesis without an exact AMI pin", () => {
    expect(() => synthesizeStack({ AL2023_ARM64_AMI_ID: "latest" })).toThrow("must be an exact setup-managed AMI ID");
  });
});

describe("minecraft-stack Cloudflare Worker runtime IAM contract", () => {
  const getRuntimeIdentity = (template: Template) => {
    const users = template.findResources("AWS::IAM::User");
    const [userLogicalId, user] = Object.entries(users).find(([, resource]) =>
      resource.Properties?.Tags?.some(
        (tag: { Key?: string; Value?: string }) => tag.Key === "McAwsPurpose" && tag.Value === "CloudflareWorkerRuntime"
      )
    )!;
    const inlinePolicies = Object.values(template.findResources("AWS::IAM::Policy")).filter((resource) =>
      resource.Properties.Users?.some((candidate: { Ref?: string }) => candidate.Ref === userLogicalId)
    );
    const managedPolicies = Object.entries(template.findResources("AWS::IAM::ManagedPolicy")).filter(
      ([policyLogicalId, resource]) =>
        resource.Properties.Users?.some((candidate: { Ref?: string }) => candidate.Ref === userLogicalId) ||
        user.Properties.ManagedPolicyArns?.some((arn: unknown) => JSON.stringify(arn).includes(policyLogicalId))
    );
    expect(managedPolicies).toHaveLength(1);
    const [managedPolicyLogicalId, managedPolicy] = managedPolicies[0];
    const policyDocument = managedPolicy.Properties.PolicyDocument;
    return {
      userLogicalId,
      user,
      inlinePolicies,
      managedPolicy,
      managedPolicyLogicalId,
      policyDocument,
      statements: policyDocument.Statement,
    };
  };

  it("creates a tagged dedicated runtime user without provisioning or outputting an access key", () => {
    const template = synthesizeStack();
    const { user } = getRuntimeIdentity(template);

    expect(user.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: "McAwsProject", Value: "mc-aws" },
        { Key: "McAwsPurpose", Value: "CloudflareWorkerRuntime" },
        { Key: "McAwsStack", Value: "MinecraftStack" },
      ])
    );
    expect(template.findResources("AWS::IAM::AccessKey")).toEqual({});

    const outputs = template.toJSON().Outputs as Record<string, { Value?: unknown }>;
    expect(outputs.WorkerRuntimeIamUserName).toBeDefined();
    expect(Object.keys(outputs).some((key) => /accesskey|secret/i.test(key))).toBe(false);
  });

  it("attaches the runtime permissions as one customer-managed policy within its document quota", () => {
    const template = synthesizeStack();
    const { inlinePolicies, managedPolicy, managedPolicyLogicalId, policyDocument } = getRuntimeIdentity(template);
    const nonWhitespacePolicySize = JSON.stringify(policyDocument).replace(/\s/g, "").length;

    expect(inlinePolicies).toEqual([]);
    expect(managedPolicy.Type).toBe("AWS::IAM::ManagedPolicy");
    expect(managedPolicyLogicalId).toMatch(/^WorkerRuntimeManagedPolicy/);
    expect(managedPolicyLogicalId).not.toBe("WorkerRuntimePolicyD3BC636A");
    expect(template.toJSON().Resources.WorkerRuntimePolicyD3BC636A).toBeUndefined();
    expect(nonWhitespacePolicySize).toBeGreaterThan(2_048);
    expect(nonWhitespacePolicySize).toBeLessThanOrEqual(6_144);
  });

  it("scopes runtime mutations to the managed instance, lifecycle Lambda, stack, and runtime SSM paths", () => {
    const template = synthesizeStack();
    const { statements } = getRuntimeIdentity(template);
    const actionsFor = (statement: Record<string, unknown>) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const statementFor = (action: string) => statements.find((statement) => actionsFor(statement).includes(action));
    const serializedResource = (action: string) => JSON.stringify(statementFor(action)?.Resource);

    expect(statementFor("ec2:DescribeInstances")?.Resource).toBe("*");
    expect(serializedResource("ec2:StopInstances")).toContain("instance/");
    expect(statementFor("ec2:StopInstances")?.Resource).not.toBe("*");
    expect(serializedResource("lambda:InvokeFunction")).toContain("StartMinecraftLambda");
    expect(serializedResource("cloudformation:DescribeStacks")).toContain("stack/MinecraftStack/*");

    const sendCommandResources = serializedResource("ssm:SendCommand");
    expect(sendCommandResources).toContain("document/AWS-RunShellScript");
    expect(sendCommandResources).toContain("instance/");
    expect(statementFor("ssm:GetCommandInvocation")?.Resource).toBe("*");

    for (const action of ["ssm:GetParameter", "ssm:GetParametersByPath", "ssm:PutParameter", "ssm:DeleteParameter"]) {
      const resources = serializedResource(action);
      expect(resources).toContain("parameter/minecraft/");
      expect(statementFor(action)?.Resource).not.toBe("*");
    }

    const putResources = serializedResource("ssm:PutParameter");
    expect(putResources).toContain("email-allowlist");
    expect(putResources).toContain("gdrive-token");
    expect(putResources).toContain("server-action");
    expect(putResources).toContain("operations/*");
    expect(serializedResource("ce:GetCostAndUsage")).toBe('"*"');
  });

  it("matches the deployed application AWS command call graph and excludes deployment/admin actions", () => {
    const sourceByOperation = {
      instanceStatus: readFileSync(path.resolve(process.cwd(), "lib/aws/ec2-client.ts"), "utf8"),
      stopInstance: readFileSync(path.resolve(process.cwd(), "lib/aws/ec2-client.ts"), "utf8"),
      invokeLifecycle: readFileSync(path.resolve(process.cwd(), "lib/aws/lambda-client.ts"), "utf8"),
      stackStatus: readFileSync(path.resolve(process.cwd(), "lib/aws/cloudformation-client.ts"), "utf8"),
      runInstanceCommand: readFileSync(path.resolve(process.cwd(), "lib/aws/ssm-client.ts"), "utf8"),
      readRuntimeParameters: readFileSync(path.resolve(process.cwd(), "lib/aws/ssm-client.ts"), "utf8"),
      writeRuntimeParameters: readFileSync(path.resolve(process.cwd(), "lib/aws/ssm-client.ts"), "utf8"),
      optionalCostData: readFileSync(path.resolve(process.cwd(), "lib/aws/cost-client.ts"), "utf8"),
    };
    const commandClassByAction: Record<string, string> = {
      "ec2:DescribeInstances": "DescribeInstancesCommand",
      "ec2:StopInstances": "StopInstancesCommand",
      "lambda:InvokeFunction": "InvokeCommand",
      "cloudformation:DescribeStacks": "DescribeStacksCommand",
      "ssm:SendCommand": "SendCommandCommand",
      "ssm:GetCommandInvocation": "GetCommandInvocationCommand",
      "ssm:GetParameter": "GetParameterCommand",
      "ssm:GetParametersByPath": "GetParametersByPathCommand",
      "ssm:PutParameter": "PutParameterCommand",
      "ssm:DeleteParameter": "DeleteParameterCommand",
      "ce:GetCostAndUsage": "GetCostAndUsageCommand",
    };

    for (const [operation, actions] of Object.entries(workerRuntimeAwsCallGraph)) {
      const source = sourceByOperation[operation as keyof typeof sourceByOperation];
      for (const action of actions) {
        expect(source, `${operation} must call ${commandClassByAction[action]}`).toContain(
          commandClassByAction[action]
        );
      }
    }

    const template = synthesizeStack();
    const policyActions = new Set(
      getRuntimeIdentity(template).statements.flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      )
    );
    for (const action of [...workerRuntimeRequiredAwsActions, ...workerRuntimeAwsCallGraph.optionalCostData]) {
      expect(policyActions.has(action)).toBe(true);
    }
    for (const forbidden of ["iam:*", "cloudformation:UpdateStack", "ec2:TerminateInstances", "ec2:StartInstances"]) {
      expect(policyActions.has(forbidden)).toBe(false);
    }
  });

  it("omits optional Cost Explorer access when cost data is disabled", () => {
    const statements = createWorkerRuntimePolicyStatements({
      instanceArn: "arn:aws:ec2:us-west-1:111111111111:instance/i-managed",
      lifecycleLambdaArn: "arn:aws:lambda:us-west-1:111111111111:function:lifecycle",
      stackArn: "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/*",
      runShellScriptDocumentArn: "arn:aws:ssm:us-west-1::document/AWS-RunShellScript",
      readableParameterArns: ["arn:aws:ssm:us-west-1:111111111111:parameter/minecraft/player-count"],
      writableParameterArns: ["arn:aws:ssm:us-west-1:111111111111:parameter/minecraft/server-action"],
      deletableParameterArns: ["arn:aws:ssm:us-west-1:111111111111:parameter/minecraft/server-action"],
      operationParameterPathArns: ["arn:aws:ssm:us-west-1:111111111111:parameter/minecraft/operations/*"],
      includeCostExplorer: false,
    });
    const actions = statements.flatMap((statement) => {
      const action = statement.toStatementJson().Action;
      return Array.isArray(action) ? action : [action];
    });

    expect(actions).not.toContain("ce:GetCostAndUsage");
  });
});
