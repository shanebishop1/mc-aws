import { readFileSync } from "node:fs";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { MinecraftStack } from "./minecraft-stack";

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

const synthesizeStack = () => {
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
  return Template.fromStack(new MinecraftStack(app, "MinecraftStack", { env: { account, region } }));
};

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
