import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import * as fs from "fs";
import * as path from "path";
import * as cr from "aws-cdk-lib/custom-resources";

import * as ssm from "aws-cdk-lib/aws-ssm";

export class MinecraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const driveTokenSecretArn =
      process.env.GDRIVE_TOKEN_SECRET_ARN || "";
    const driveRemote = process.env.GDRIVE_REMOTE || "gdrive";
    const driveRoot = process.env.GDRIVE_ROOT || "mc-backups";

    // 0. SSM Parameters (GitHub Credentials)
    new ssm.StringParameter(this, "GithubUserParam", {
      parameterName: "/minecraft/github-user",
      stringValue: process.env.GITHUB_USER || "error-missing-user",
    });

    new ssm.StringParameter(this, "GithubRepoParam", {
      parameterName: "/minecraft/github-repo",
      stringValue: process.env.GITHUB_REPO || "error-missing-repo",
    });

    // Read GitHub Token (Passed as a deployment parameter to keep it out of the template)
    const githubTokenParam = new cdk.CfnParameter(this, "GithubTokenParam", {
      type: "String",
      description: "GitHub Personal Access Token (PAT)",
      noEcho: true, // Critical: Prevents the value from being stored in the template
    });

    // Use Custom Resource to put the parameter into SSM securely
    new cr.AwsCustomResource(this, "GithubTokenSecureParam", {
      onUpdate: {
        service: "SSM",
        action: "putParameter",
        parameters: {
          Name: "/minecraft/github-pat",
          Value: githubTokenParam.valueAsString,
          Type: "SecureString",
          Overwrite: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of("GithubTokenSecureParam"),
      },
      onDelete: {
        service: "SSM",
        action: "deleteParameter",
        parameters: {
          Name: "/minecraft/github-pat",
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    // 1. VPC
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", {
      isDefault: true,
    });

    // 2. IAM Role for EC2
    const ec2Role = new iam.Role(this, "MinecraftServerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    // Add permissions to read SSM parameters (GitHub credentials)
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`,
        ],
      }),
    );

    // Add permission to decrypt (needed for SecureString)
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"], // Scope this down if you have a specific KMS key
      }),
    );

    // Add permission to stop itself
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StopInstances"],
        resources: ["*"], // We can't easily restrict to "self" in IAM without tags, but the script uses instance metadata to find its own ID
      }),
    );

    // 3. Security Group
    const securityGroup = new ec2.SecurityGroup(
      this,
      "MinecraftSecurityGroup",
      {
        vpc,
        description: "Allow Minecraft and SSH access",
        allowAllOutbound: true,
      },
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(25565),
      "Allow Minecraft",
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Allow SSH",
    );

    // 4. EC2 Instance
    const baseUserData = fs
      .readFileSync(path.join(__dirname, "../src/ec2/user_data.sh"), "utf8")
      // Insert exports immediately after the shebang to keep cloud-init happy
      .replace(
        /^#!.*\n/,
        (line) =>
          `${line}export GDRIVE_TOKEN_SECRET_ARN="${driveTokenSecretArn}"\n` +
          `export GDRIVE_REMOTE="${driveRemote}"\n` +
          `export GDRIVE_ROOT="${driveRoot}"\n`,
      );

    // Fallback if no shebang was found (should not happen, but keeps user-data valid)
    const userDataScript = baseUserData.startsWith("#!/")
      ? baseUserData
      : `#!/usr/bin/env bash\nexport GDRIVE_TOKEN_SECRET_ARN="${driveTokenSecretArn}"\nexport GDRIVE_REMOTE="${driveRemote}"\nexport GDRIVE_ROOT="${driveRoot}"\n${baseUserData}`;

    const instance = new ec2.Instance(this, "MinecraftServer", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MEDIUM,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup,
      role: ec2Role,
      keyName: process.env.KEY_PAIR_NAME
        ? process.env.KEY_PAIR_NAME
        : undefined,
      userData: ec2.UserData.custom(userDataScript),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    if (driveTokenSecretArn) {
      ec2Role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [driveTokenSecretArn],
        }),
      );
    }

    // Tag for backups (DLM)
    cdk.Tags.of(instance).add("Backup", "weekly");

    // 5. SNS Topic for Start Trigger
    const startTopic = new sns.Topic(this, "MinecraftStartTopic", {
      displayName: "Minecraft Start Trigger",
    });

    // 6. Lambda Function to Start Server
    // Read email allowlist if it exists
    const allowlistPath = path.join(__dirname, "../.allowlist");
    let allowlistContent = "";
    if (fs.existsSync(allowlistPath)) {
      allowlistContent = fs.readFileSync(allowlistPath, "utf8")
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .join(',');
      console.log("Email allowlist found and loaded.");
    } else {
      console.log("No .allowlist file found. All emails will be allowed.");
    }

    const startLambda = new lambda.Function(this, "StartMinecraftLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../src/lambda/StartMinecraftServer"),
      ),
      environment: {
        INSTANCE_ID: instance.instanceId,
        // These need to be provided via context or manually set after deploy if not hardcoded
        CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID || "",
        CLOUDFLARE_RECORD_ID: process.env.CLOUDFLARE_RECORD_ID || "",
        CLOUDFLARE_MC_DOMAIN: process.env.CLOUDFLARE_MC_DOMAIN || "",
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
        VERIFIED_SENDER: process.env.VERIFIED_SENDER || "",
        START_KEYWORD: process.env.START_KEYWORD || "start",
        NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL || "",
        EMAIL_ALLOWLIST: allowlistContent,
      },
      timeout: cdk.Duration.seconds(60), // Give it time to poll EC2
    });

    // Lambda to update DNS during deploy (no email trigger needed)
    const updateDnsLambda = new lambda.Function(this, "UpdateDnsLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../src/lambda/UpdateDns"),
      ),
      environment: {
        INSTANCE_ID: instance.instanceId,
        CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID || "",
        CLOUDFLARE_RECORD_ID: process.env.CLOUDFLARE_RECORD_ID || "",
        CLOUDFLARE_MC_DOMAIN: process.env.CLOUDFLARE_MC_DOMAIN || "",
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
      },
      timeout: cdk.Duration.seconds(300),
    });

    updateDnsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      }),
    );

    const updateDnsProvider = new cr.Provider(this, "UpdateDnsProvider", {
      onEventHandler: updateDnsLambda,
    });

    const updateDnsResource = new cdk.CustomResource(this, "UpdateDnsOnDeploy", {
      serviceToken: updateDnsProvider.serviceToken,
    });
    updateDnsResource.node.addDependency(instance);

    // Grant Lambda permissions
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StartInstances", "ec2:DescribeInstances"],
        resources: ["*"],
      }),
    );

    // Grant Lambda permission to send email (for notifications)
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      }),
    );

    // Subscribe Lambda to SNS
    startTopic.addSubscription(
      new subscriptions.LambdaSubscription(startLambda),
    );

    // 7. SES Receipt Rule
    // Note: You must manually verify the domain/email in SES Console first!
    const ruleSet = ses.ReceiptRuleSet.fromReceiptRuleSetName(
      this,
      "RuleSet",
      "default-rule-set",
    );

    // Create a new SES Receipt Rule Set
    const mcRuleSet = new ses.ReceiptRuleSet(this, "MinecraftRuleSet", {
      receiptRuleSetName: "MinecraftRuleSet",
    });

    // Automatically activate the Rule Set using a Custom Resource
    new cr.AwsCustomResource(this, "ActivateRuleSet", {
      onUpdate: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: {
          RuleSetName: mcRuleSet.receiptRuleSetName,
        },
        physicalResourceId: cr.PhysicalResourceId.of("ActivateRuleSet"),
      },
      onDelete: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: {
          RuleSetName: null, // Deactivate on destroy
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    mcRuleSet.addRule("StartServerRule", {
      recipients: [process.env.VERIFIED_SENDER || "start@example.com"], // The email to listen for
      actions: [
        new sesActions.Sns({
          topic: startTopic,
        }),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "PublicIp", { value: instance.instancePublicIp });
    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: startLambda.functionName,
    });
  }
}
