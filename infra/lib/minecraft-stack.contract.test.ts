import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  "ADMIN_EMAIL",
  "ALLOWED_EMAILS",
] as const;

const stackEnvironmentNames = [
  ...sesEnvironmentNames,
  "GDRIVE_REMOTE",
  "GDRIVE_ROOT",
  "MC_ALARM_EMAIL",
  "MC_SCHEDULED_BACKUP_ENABLED",
  "MC_SCHEDULED_BACKUP_SCHEDULE",
  "MC_BACKUP_STALE_AFTER_HOURS",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_MC_DOMAIN",
  "CLOUDFLARE_DNS_API_TOKEN",
  "DUCKDNS_DOMAIN",
  "DUCKDNS_TOKEN",
  "AL2023_ARM64_AMI_ID",
  "MC_SERVER_PROFILE_DIR",
  "MC_ALLOW_EMPTY_WHITELIST",
] as const;

const synthesizedTemplates = new Map<string, Template>();
// Asset staging makes a cold CDK synthesis materially slower than a unit test. Keep the
// timeout local to this contract file; cached templates make repeat assertions inexpensive.
const synthesisContractTimeout = 30_000;

const restoreEnvironment = (name: string, previousValue: string | undefined): void => {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
};

const synthesizeStack = (stackEnvironment: Partial<Record<(typeof stackEnvironmentNames)[number], string>> = {}) => {
  const cacheKey = JSON.stringify(
    Object.entries(stackEnvironment)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const cached = synthesizedTemplates.get(cacheKey);
  if (cached) return cached;

  const previousEnvironment = Object.fromEntries(stackEnvironmentNames.map((name) => [name, process.env[name]]));
  for (const name of stackEnvironmentNames) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    AL2023_ARM64_AMI_ID: `ami-${"1".repeat(17)}`,
    MC_ALLOW_EMPTY_WHITELIST: "true",
    ...stackEnvironment,
  });

  const assemblyDirectory = mkdtempSync(path.join(os.tmpdir(), "mc-aws-cdk.out-"));
  const app = new cdk.App({ autoSynth: false, outdir: assemblyDirectory });
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
    const template = Template.fromStack(new MinecraftStack(app, "MinecraftStack", { env: { account, region } }));
    synthesizedTemplates.set(cacheKey, template);
    return template;
  } finally {
    rmSync(assemblyDirectory, { recursive: true, force: true });
    for (const name of stackEnvironmentNames) {
      restoreEnvironment(name, previousEnvironment[name]);
    }
  }
};

describe("minecraft-stack user data shell quoting", { timeout: synthesisContractTimeout }, () => {
  it("keeps synthesized UserData ASCII-stable across CloudFormation GetTemplate", () => {
    const template = synthesizeStack();
    const instance = Object.values(template.findResources("AWS::EC2::Instance"))[0];
    const userData = instance.Properties.UserData["Fn::Base64"] as string;

    expect([...userData].every((character) => character.codePointAt(0)! <= 0x7f)).toBe(true);
  }, 60_000);

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

describe("minecraft-stack server profile assets", { timeout: synthesisContractTimeout }, () => {
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
    expect(deleteStatement).toBeUndefined();
    expect(JSON.stringify(statements)).not.toContain("parameter/minecraft/*");
  });

  it("keeps the repository root and user data out of file asset sources", () => {
    const assemblyDirectory = mkdtempSync(path.join(os.tmpdir(), "mc-aws-cdk.out-"));
    const app = new cdk.App({ autoSynth: false, outdir: assemblyDirectory });
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
      rmSync(assemblyDirectory, { recursive: true, force: true });
      restoreEnvironment("AL2023_ARM64_AMI_ID", previous);
      restoreEnvironment("MC_ALLOW_EMPTY_WHITELIST", previousAllowEmpty);
    }
  });
});

describe("minecraft-stack optional SES contract", { timeout: synthesisContractTimeout }, () => {
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
    expect(Object.keys(template.findResources("AWS::SNS::Topic"))).toHaveLength(1);
    expect(template.findResources("AWS::SNS::Subscription")).toEqual({});
    expect(template.findResources("AWS::Events::Rule")).toEqual({});
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
    expect(Object.keys(template.findResources("AWS::SNS::Topic"))).toHaveLength(1);
    expect(template.findResources("AWS::SNS::Subscription")).toEqual({});
    const sendStatements = allIamStatements(template).filter((statement) =>
      actionsFor(statement).includes("ses:SendEmail")
    );
    expect(sendStatements).toHaveLength(1);
    for (const statement of sendStatements) {
      expect(JSON.stringify(statement.Resource)).toContain(
        "arn:aws:ses:us-west-1:111111111111:identity/sender@example.net"
      );
      expect(statement.Resource).not.toBe("*");
    }
    expect(JSON.stringify(allIamStatements(template))).not.toContain("ses:SendRawEmail");
  });

  it("does not seed the notification recipient into the command allowlist", () => {
    const template = synthesizeStack({
      ADMIN_EMAIL: "admin@example.net",
      ALLOWED_EMAILS: "friend@example.net",
      SES_NOTIFICATIONS_ENABLED: "true",
      VERIFIED_SENDER: "sender@example.net",
      NOTIFICATION_EMAIL: "notify@example.net",
    });

    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          PARAM_NAME: "/minecraft/email-allowlist",
          SEED_VALUE: "admin@example.net,friend@example.net",
        }),
      },
    });
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
    expect(Object.keys(template.findResources("AWS::SNS::Topic"))).toHaveLength(2);
    expect(JSON.stringify(template.toJSON())).not.toContain("SetActiveReceiptRuleSet");
    expect(allIamStatements(template).some((statement) => actionsFor(statement).includes("ses:SendEmail"))).toBe(false);

    const inboundLambda = Object.entries(template.findResources("AWS::Lambda::Function")).find(([, resource]) =>
      Boolean(resource.Properties?.Environment?.Variables?.EXPECTED_TOPIC_ARN)
    );
    const lifecycleLambda = Object.entries(template.findResources("AWS::Lambda::Function")).find(([, resource]) =>
      Boolean(resource.Properties?.Environment?.Variables?.INSTANCE_ID)
    );
    expect(inboundLambda).toBeDefined();
    expect(lifecycleLambda).toBeDefined();
    const subscription = Object.values(template.findResources("AWS::SNS::Subscription"))[0];
    expect(JSON.stringify(subscription.Properties.Endpoint)).toContain(inboundLambda![0]);
    expect(JSON.stringify(subscription.Properties.Endpoint)).not.toContain(lifecycleLambda![0]);
    expect(inboundLambda![1].Properties.Environment.Variables).not.toHaveProperty("MIME");
    expect(JSON.stringify(inboundLambda![1].Properties.Environment.Variables)).not.toContain("content");
  });
});

describe("minecraft-stack lifecycle Lambda IAM contract", { timeout: synthesisContractTimeout }, () => {
  it("keeps the EC2 role at the exact host call graph and removes obsolete SES/SSM access", () => {
    const template = synthesizeStack();
    const instance = Object.values(template.findResources("AWS::EC2::Instance"))[0];
    const profileLogicalId = instance.Properties.IamInstanceProfile.Ref;
    const profile = template.findResources("AWS::IAM::InstanceProfile")[profileLogicalId];
    const roleLogicalId = profile.Properties.Roles[0].Ref;
    const role = template.findResources("AWS::IAM::Role")[roleLogicalId];
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((resource) =>
      resource.Properties.Roles?.some((candidate: { Ref?: string }) => candidate.Ref === roleLogicalId)
    );
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const actionsFor = (statement: Record<string, unknown>) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resourcesFor = (statement: Record<string, unknown>) =>
      (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]).map(String);
    const reads = statements.find((statement) => actionsFor(statement).includes("ssm:GetParameter"));

    expect(resourcesFor(reads!).sort()).toEqual(
      [
        "cloudflare-api-token",
        "cloudflare-domain",
        "cloudflare-zone-id",
        "duckdns-domain",
        "duckdns-token",
        "gdrive-token",
        "resume-pending",
        "server-profile-manifest",
      ].map((name) => `arn:aws:ssm:us-west-1:111111111111:parameter/minecraft/${name}`)
    );
    const roleActions = statements.flatMap(actionsFor);
    expect(roleActions).not.toContain("ssm:DeleteParameter");
    expect(roleActions.some((action) => String(action).startsWith("ses:"))).toBe(false);
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain("AmazonSSMManagedInstanceCore");

    const ec2SourceDirectory = path.resolve(process.cwd(), "infra/src/ec2");
    const hostScripts = readdirSync(ec2SourceDirectory)
      .filter((name) => name.endsWith(".sh"))
      .map((name) => readFileSync(path.join(ec2SourceDirectory, name), "utf8"))
      .join("\n");
    expect(hostScripts).not.toMatch(/\baws\s+ses\b|SendRawEmail|SendEmailCommand/);
    expect(hostScripts).not.toContain("/minecraft/verified-sender");
    expect(hostScripts).not.toContain("/minecraft/notification-email");
    expect(hostScripts).not.toContain("/minecraft/startup-triggered-by");
  });

  it("builds Lambda deployment assets only through clean production staging", () => {
    const stackSource = readFileSync(stackSourcePath, "utf8");
    const helperSource = readFileSync(path.resolve(process.cwd(), "infra/lib/lambda-assets.ts"), "utf8");
    expect(stackSource).not.toContain('lambda.Code.fromAsset(path.join(__dirname, "../src/lambda');
    expect(stackSource).toContain("createLambdaDeploymentCode");
    expect(helperSource).toContain('["ci", "--omit=dev", "--ignore-scripts"');
    expect(helperSource).toContain("mkdtempSync(path.join(os.tmpdir(), stagingPrefix))");
    expect(helperSource).toContain("removeOwnedStagingDirectory(stagingDirectory)");
    expect(readFileSync(path.resolve(process.cwd(), ".github/workflows/baseline-pr-validation.yml"), "utf8")).toContain(
      "pnpm lambda:assets:audit infra/cdk.out"
    );
  });

  it("serializes lifecycle ingress and keeps retry age within the ownership lease budget", () => {
    const template = synthesizeStack();
    const startLambda = Object.values(template.findResources("AWS::Lambda::Function")).find((resource) =>
      Boolean(resource.Properties?.Environment?.Variables?.INSTANCE_ID)
    );

    expect(startLambda?.Properties).toMatchObject({
      Timeout: 900,
      ReservedConcurrentExecutions: 1,
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumEventAgeInSeconds: 3600,
      MaximumRetryAttempts: 2,
      DestinationConfig: {
        OnFailure: {
          Destination: { "Fn::GetAtt": [Match.stringLikeRegexp("FailureEventSanitizerLambda"), "Arn"] },
        },
      },
    });
    const tables = Object.values(template.findResources("AWS::DynamoDB::Table"));
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.Properties).toMatchObject({
        BillingMode: "PAY_PER_REQUEST",
        SSESpecification: { SSEEnabled: true },
        TimeToLiveSpecification: { AttributeName: "ttlEpochSeconds", Enabled: true },
      });
    }
    expect(tables.map((table) => table.Properties.KeySchema[0].AttributeName).sort()).toEqual([
      "lockKey",
      "operationId",
    ]);
    const lockTable = tables.find((table) => table.Properties.KeySchema[0].AttributeName === "lockKey");
    const operationTable = tables.find((table) => table.Properties.KeySchema[0].AttributeName === "operationId");
    expect(lockTable?.DeletionPolicy).toBe("Delete");
    expect(lockTable?.UpdateReplacePolicy).toBe("Retain");
    expect(operationTable?.DeletionPolicy).toBe("Delete");
    expect(startLambda?.Properties.Environment.Variables).toMatchObject({
      MC_LIFECYCLE_LOCK_TABLE_NAME: { Ref: expect.stringContaining("LifecycleLockTable") },
      MC_OPERATION_STATE_TABLE_NAME: { Ref: expect.stringContaining("OperationStateTable") },
      MC_OPERATION_STATE_RETENTION_DAYS: "30",
    });
  });

  it("initializes replacement-safe dual-protocol metadata without mutating the legacy lock", () => {
    const template = synthesizeStack();
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      Protocol: "dual-v1",
      MarkerVersion: "2",
      LockTableName: { Ref: Match.stringLikeRegexp("LifecycleLockTable") },
    });
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain("dynamodb:UpdateItem");
    expect(serialized).toContain("LifecycleLockTable");
    expect(
      readFileSync(path.resolve(process.cwd(), "infra/src/lambda/MigrateServerActionLock/index.js"), "utf8")
    ).not.toContain("/minecraft/server-action");
  });

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
    expect(statementFor("ssm:PutParameter", "server-action-delete-claim/*")).toBeDefined();
    expect(statementFor("ssm:DeleteParameter", "server-action-delete-claim/*")).toBeDefined();
    expect(statementFor("ssm:PutParameter", "server-action")).toBeDefined();
    expect(statementFor("ssm:DeleteParameter", "server-action")).toBeDefined();
    expect(statementFor("ssm:CancelCommand")?.Resource).toBe("*");
    const dynamoStatement = statementFor("dynamodb:UpdateItem");
    expect(JSON.stringify(dynamoStatement?.Resource)).toContain("LifecycleLockTable");
    expect(JSON.stringify(dynamoStatement?.Resource)).toContain("OperationStateTable");

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

  it("keeps first boot on the reviewed AL2023 repository snapshot and records installed package versions", () => {
    const userData = readFileSync(path.resolve(process.cwd(), "infra/src/ec2/user_data.sh"), "utf8");
    expect(userData).toContain("/etc/dnf/vars/releasever");
    expect(userData).toContain('--releasever="$AL2023_RELEASEVER"');
    expect(userData).toContain("--setopt=metadata_expire=never");
    expect(userData).toContain("/var/lib/mc-aws/os-package-manifest.txt");
    expect(userData).not.toMatch(/\bdnf\s+(?:-y\s+)?update\b/);
  });
});

describe("minecraft-stack production observability contract", { timeout: synthesisContractTimeout }, () => {
  it("retains every Lambda/custom-resource log group for 30 days and hardens async failure handling", () => {
    const template = synthesizeStack();
    const lambdaFunctions = Object.values(template.findResources("AWS::Lambda::Function"));
    const logGroups = Object.values(template.findResources("AWS::Logs::LogGroup"));

    expect(lambdaFunctions.length).toBeGreaterThanOrEqual(5);
    for (const fn of lambdaFunctions) {
      expect(fn.Properties.LoggingConfig?.LogGroup).toBeDefined();
    }
    expect(logGroups.length).toBeGreaterThanOrEqual(lambdaFunctions.length);
    for (const logGroup of logGroups) {
      expect(logGroup.Properties.RetentionInDays).toBe(30);
      expect(logGroup.DeletionPolicy).toBe("Delete");
      expect(logGroup.UpdateReplacePolicy).toBe("Delete");
    }

    const queues = Object.values(template.findResources("AWS::SQS::Queue"));
    expect(queues).toHaveLength(2);
    for (const queue of queues) {
      expect(queue.Properties).toMatchObject({
        MessageRetentionPeriod: 1_209_600,
        SqsManagedSseEnabled: true,
      });
    }
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumEventAgeInSeconds: 3600,
      MaximumRetryAttempts: 2,
      DestinationConfig: {
        OnFailure: {
          Destination: Match.anyValue(),
        },
      },
    });
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      LogGroupNames: Match.anyValue(),
      RetentionInDays: 30,
      MigrationVersion: "3",
    });
    expect(JSON.stringify(template.findResources("AWS::CloudFormation::CustomResource"))).not.toContain(
      "LogGroupPrefix"
    );
    expect(JSON.stringify(template.findResources("AWS::IAM::Policy"))).toContain("logs:PutRetentionPolicy");
    const lambdaResourcesById = template.findResources("AWS::Lambda::Function");
    const seedHandlerLogicalId = Object.entries(lambdaResourcesById).find(([, resource]) =>
      Boolean(resource.Properties?.Environment?.Variables?.PARAM_NAME)
    )?.[0];
    const seedProviderFrameworkLogicalId = Object.entries(lambdaResourcesById).find(
      ([, resource]) =>
        resource.Properties?.Environment?.Variables?.USER_ON_EVENT_FUNCTION_ARN?.["Fn::GetAtt"]?.[0] ===
        seedHandlerLogicalId
    )?.[0];
    expect(seedProviderFrameworkLogicalId).toBeDefined();
    const retentionResource = Object.values(template.findResources("AWS::CloudFormation::CustomResource")).find(
      (resource) => resource.Properties?.MigrationVersion === "3"
    );
    expect(JSON.stringify(retentionResource?.Properties.LogGroupNames)).toContain(seedProviderFrameworkLogicalId);
    const retentionPolicies = Object.values(template.findResources("AWS::IAM::Policy")).filter((resource) =>
      resource.Properties.PolicyDocument.Statement.some((statement: Record<string, unknown>) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes("logs:PutRetentionPolicy")
      )
    );
    expect(retentionPolicies).toHaveLength(1);
    const retentionPolicyResources = JSON.stringify(
      retentionPolicies[0].Properties.PolicyDocument.Statement.find((statement: Record<string, unknown>) =>
        (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes("logs:PutRetentionPolicy")
      )?.Resource
    );
    expect(retentionPolicyResources).toContain(seedProviderFrameworkLogicalId);
    expect(retentionPolicyResources).not.toContain("*");
    expect(readFileSync(path.resolve(process.cwd(), "infra/src/lambda/RetainLambdaLogs/index.js"), "utf8")).toContain(
      'event.RequestType === "Delete"'
    );

    const sanitizer = Object.values(template.findResources("AWS::Lambda::Function")).find((resource) =>
      Boolean(resource.Properties?.Environment?.Variables?.FAILURE_QUEUE_URL)
    );
    expect(sanitizer).toBeDefined();
    expect(sanitizer?.Properties.DeadLetterConfig?.TargetArn).toBeDefined();
    const sanitizerSource = readFileSync(
      path.resolve(process.cwd(), "infra/src/lambda/FailureEventSanitizer/index.js"),
      "utf8"
    );
    for (const forbidden of ["senderEmail", "subject", "body", "content", "responsePayload"]) {
      expect(sanitizerSource).not.toContain(forbidden);
    }

    const metricNames = Object.values(template.findResources("AWS::CloudWatch::Alarm")).map(
      (alarm) => alarm.Properties.MetricName
    );
    expect(metricNames).toEqual(
      expect.arrayContaining([
        "StatusCheckFailed",
        "Errors",
        "LifecycleOperationFailures",
        "Duration",
        "Throttles",
        "AsyncEventAge",
        "ApproximateNumberOfMessagesVisible",
      ])
    );
  });

  it("creates no surprise alarm subscription and enables explicit scheduled backup hardening", () => {
    const enabled = synthesizeStack({
      MC_ALARM_EMAIL: "operator@example.net",
      MC_SCHEDULED_BACKUP_ENABLED: "true",
      MC_SCHEDULED_BACKUP_SCHEDULE: "cron(0 5 ? * SUN *)",
      MC_BACKUP_STALE_AFTER_HOURS: "192",
    });
    enabled.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "operator@example.net",
    });
    const rules = Object.values(enabled.findResources("AWS::Events::Rule"));
    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.Properties.ScheduleExpression)).toEqual(
      expect.arrayContaining(["cron(0 5 ? * SUN *)", "cron(15 6 * * ? *)"])
    );
    const serializedTargets = JSON.stringify(rules.flatMap((rule) => rule.Properties.Targets));
    expect(serializedTargets).toContain("scheduledBackup");
    expect(serializedTargets).toContain("backupFreshnessCheck");
    expect(serializedTargets).toContain("DeadLetterConfig");
    expect(serializedTargets).toContain("MaximumEventAgeInSeconds");

    const enabledMetricNames = Object.values(enabled.findResources("AWS::CloudWatch::Alarm")).map(
      (alarm) => alarm.Properties.MetricName
    );
    expect(enabledMetricNames).toEqual(expect.arrayContaining(["ScheduledBackupFailure", "ScheduledBackupStale"]));
    const freshnessAlarm = Object.values(enabled.findResources("AWS::CloudWatch::Alarm")).find(
      (alarm) => alarm.Properties.MetricName === "ScheduledBackupStale"
    );
    expect(freshnessAlarm?.Properties.TreatMissingData).toBe("notBreaching");
  });

  it("uses exact scheduled-backup IAM and never puts DNS secret values in CloudFormation", () => {
    const secretSentinel = "dns-secret-must-not-enter-template";
    const template = synthesizeStack({
      CLOUDFLARE_ZONE_ID: "zone-id",
      CLOUDFLARE_MC_DOMAIN: "mc.example.net",
      CLOUDFLARE_DNS_API_TOKEN: secretSentinel,
      DUCKDNS_TOKEN: "unused-second-secret",
    });
    const lifecycleFunction = Object.entries(template.findResources("AWS::Lambda::Function")).find(([, resource]) =>
      Boolean(resource.Properties?.Environment?.Variables?.INSTANCE_ID)
    );
    const roleLogicalId = lifecycleFunction?.[1].Properties.Role["Fn::GetAtt"][0];
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((resource) => resource.Properties.Roles?.some((role: { Ref?: string }) => role.Ref === roleLogicalId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const scheduledParameterStatements = statements.filter((statement) =>
      JSON.stringify(statement.Resource).includes("last-scheduled-backup-success")
    );
    expect(scheduledParameterStatements).not.toHaveLength(0);
    for (const statement of scheduledParameterStatements) {
      expect(statement.Resource).not.toBe("*");
      expect(JSON.stringify(statement.Resource)).not.toContain("parameter/minecraft/*");
    }

    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).not.toContain(secretSentinel);
    expect(serialized).not.toContain("unused-second-secret");
    expect(serialized).not.toContain("CloudflareTokenParam");
    expect(serialized).not.toContain("DuckDnsTokenParam");
    template.hasResourceProperties("Custom::AWS", {
      ParameterName: "/minecraft/cloudflare-api-token",
      MigrationVersion: "1",
    });
    expect(serialized).toContain("AdoptDnsSecureString");
    expect(readFileSync(path.resolve(process.cwd(), "infra/src/lambda/StartMinecraftServer/ssm.js"), "utf8")).toContain(
      'error.name === "ParameterNotFound"'
    );
  });
});

describe("minecraft-stack immutable AMI contract", { timeout: synthesisContractTimeout }, () => {
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

describe("minecraft-stack Cloudflare Worker runtime IAM contract", { timeout: synthesisContractTimeout }, () => {
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
    expect(putResources).toContain("operations/*");
    expect(putResources).toContain("server-action");
    expect(putResources).toContain("server-action-delete-claim/*");
    const lifecycleTables = serializedResource("dynamodb:UpdateItem");
    expect(lifecycleTables).toContain("LifecycleLockTable");
    expect(lifecycleTables).toContain("OperationStateTable");
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
      manageLifecycleState: [
        readFileSync(path.resolve(process.cwd(), "lib/server-action-lock.ts"), "utf8"),
        readFileSync(path.resolve(process.cwd(), "lib/aws/dynamodb-operation-store.ts"), "utf8"),
      ].join("\n"),
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
      "dynamodb:GetItem": "GetItemCommand",
      "dynamodb:UpdateItem": "UpdateItemCommand",
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
      lifecycleStateTableArns: ["arn:aws:dynamodb:us-west-1:111111111111:table/mc-lifecycle"],
      includeCostExplorer: false,
    });
    const actions = statements.flatMap((statement) => {
      const action = statement.toStatementJson().Action;
      return Array.isArray(action) ? action : [action];
    });

    expect(actions).not.toContain("ce:GetCostAndUsage");
  });
});
