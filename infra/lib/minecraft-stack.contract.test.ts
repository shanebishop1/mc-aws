import { readFileSync } from "node:fs";
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
  it("uses StringLike encryption-context scoping for /minecraft/* parameters", () => {
    const source = readFileSync(stackSourcePath, "utf8");

    expect(source).toContain('actions: ["kms:Decrypt"]');
    expect(source).toContain("resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`]");
    expect(source).toContain("StringLike");
    expect(source).toContain(
      '"kms:EncryptionContext:PARAMETER_ARN": `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`'
    );
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

const synthesizeStack = (sesEnvironment: Partial<Record<(typeof sesEnvironmentNames)[number], string>> = {}) => {
  const previousEnvironment = Object.fromEntries(sesEnvironmentNames.map((name) => [name, process.env[name]]));
  for (const name of sesEnvironmentNames) {
    delete process.env[name];
  }
  Object.assign(process.env, sesEnvironment);

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
    for (const name of sesEnvironmentNames) {
      const previousValue = previousEnvironment[name];
      if (previousValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousValue;
      }
    }
  }
};

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
    expect(
      allIamStatements(template).some((statement) => actionsFor(statement).includes("ses:SendEmail"))
    ).toBe(false);
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

describe("minecraft-stack Cloudflare Worker runtime IAM contract", () => {
  const getRuntimeIdentity = (template: Template) => {
    const users = template.findResources("AWS::IAM::User");
    const [userLogicalId, user] = Object.entries(users).find(([, resource]) =>
      resource.Properties?.Tags?.some(
        (tag: { Key?: string; Value?: string }) => tag.Key === "McAwsPurpose" && tag.Value === "CloudflareWorkerRuntime"
      )
    )!;
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((resource) =>
      resource.Properties.Users?.some((candidate: { Ref?: string }) => candidate.Ref === userLogicalId)
    );
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    return { userLogicalId, user, statements };
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
