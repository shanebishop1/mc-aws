import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

import * as ssm from "aws-cdk-lib/aws-ssm";

export class MinecraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/github-pat`],
        }),
      ]),
    });

    // 0.5 SSM Parameters (Cloudflare Credentials for EC2 DNS updates)
    new ssm.StringParameter(this, "CloudflareZoneId", {
      parameterName: "/minecraft/cloudflare-zone-id",
      stringValue: process.env.CLOUDFLARE_ZONE_ID || "error-missing-zone-id",
      description: "Cloudflare Zone ID for DNS updates",
    });

    new ssm.StringParameter(this, "CloudflareDomain", {
      parameterName: "/minecraft/cloudflare-domain",
      stringValue: process.env.CLOUDFLARE_MC_DOMAIN || "error-missing-domain",
      description: "Domain name to update (e.g., mc.example.com)",
    });

    // Cloudflare API Token (SecureString via Custom Resource)
    const cloudflareTokenParam = new cdk.CfnParameter(this, "CloudflareTokenParam", {
      type: "String",
      description: "Cloudflare API Token for DNS updates",
      noEcho: true,
    });

    new cr.AwsCustomResource(this, "CloudflareTokenSecureParam", {
      onUpdate: {
        service: "SSM",
        action: "putParameter",
        parameters: {
          Name: "/minecraft/cloudflare-api-token",
          Value: cloudflareTokenParam.valueAsString,
          Type: "SecureString",
          Overwrite: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of("CloudflareTokenSecureParam"),
      },
      onDelete: {
        service: "SSM",
        action: "deleteParameter",
        parameters: {
          Name: "/minecraft/cloudflare-api-token",
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/cloudflare-api-token`],
        }),
      ]),
    });

    // 1. VPC
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", {
      isDefault: true,
    });

    // 2. IAM Role for EC2
    const ec2Role = new iam.Role(this, "MinecraftServerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    // Add permissions to read/write SSM parameters (GitHub credentials, player count)
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`],
      })
    );

    // Add permission to decrypt (needed for SecureString)
    // Narrowed to account-level KMS keys with encryption context limiting to /minecraft/* SSM parameters
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
        conditions: {
          StringEquals: {
            "kms:EncryptionContext:PARAMETER_ARN": `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`,
          },
        },
      })
    );

    // Add permission to stop itself (restricted via CloudFormation stack tag)
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StopInstances"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "ec2:ResourceTag/aws:cloudformation:stack-id": this.stackId,
          },
        },
      })
    );

    // Add permissions to manage volumes (for hibernate/resume)
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:DescribeVolumes",
          "ec2:DescribeInstances",
          "ec2:DetachVolume",
          "ec2:DeleteVolume",
          "ec2:CreateVolume",
          "ec2:AttachVolume",
        ],
        resources: ["*"],
      })
    );

    // 3. Security Group
    const securityGroup = new ec2.SecurityGroup(this, "MinecraftSecurityGroup", {
      vpc,
      description: "Allow Minecraft and SSH access",
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(25565), "Allow Minecraft");
    // SSH rule removed for security - use SSM Session Manager instead
    // securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), "Allow SSH");

    // 4. EC2 Instance
    const baseUserData = fs
      .readFileSync(path.join(__dirname, "../src/ec2/user_data.sh"), "utf8")
      // Insert exports immediately after the shebang to keep cloud-init happy
      .replace(
        /^#!.*\n/,
        (line) => `${line}export GDRIVE_REMOTE="${driveRemote}"\nexport GDRIVE_ROOT="${driveRoot}"\n`
      );

    // Fallback if no shebang was found (should not happen, but keeps user-data valid)
    const userDataScript = baseUserData.startsWith("#!/")
      ? baseUserData
      : `#!/usr/bin/env bash\nexport GDRIVE_REMOTE="${driveRemote}"\nexport GDRIVE_ROOT="${driveRoot}"\n${baseUserData}`;

    const instance = new ec2.Instance(this, "MinecraftServer", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup,
      role: ec2Role,
      keyPair: process.env.KEY_PAIR_NAME
        ? ec2.KeyPair.fromKeyPairName(this, "KeyPair", process.env.KEY_PAIR_NAME)
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

    // Tag for backups (DLM)
    cdk.Tags.of(instance).add("Backup", "weekly");

    // 5. SNS Topic for Start Trigger
    const startTopic = new sns.Topic(this, "MinecraftStartTopic", {
      displayName: "Minecraft Start Trigger",
    });

    // 6. Lambda Function to Start Server
    const notificationEmail = (process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const allowedEmails = (process.env.ALLOWED_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    const emailAllowlistSeed = Array.from(
      new Set([notificationEmail, adminEmail, ...allowedEmails].filter(Boolean))
    ).join(",");

    // SNS Topic for Notifications
    const notificationTopic = new sns.Topic(this, "MinecraftNotificationTopic", {
      displayName: "Minecraft Server Notifications",
    });

    // Add email subscription to notification topic
    if (notificationEmail) {
      notificationTopic.addSubscription(new subscriptions.EmailSubscription(notificationEmail));
    }

    // SSM Parameters (Notifications)
    new ssm.StringParameter(this, "SnsTopicArn", {
      parameterName: "/minecraft/sns-topic-arn",
      stringValue: notificationTopic.topicArn,
      description: "SNS topic ARN for server notifications",
    });

    new ssm.StringParameter(this, "NotificationEmail", {
      parameterName: "/minecraft/notification-email",
      stringValue: notificationEmail || "",
      description: "Email address for server notifications",
    });

    // Allow EC2 to publish to notification topic
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sns:Publish"],
        resources: [notificationTopic.topicArn],
      })
    );

    const startLambda = new lambda.Function(this, "StartMinecraftLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../src/lambda/StartMinecraftServer")),
      environment: {
        INSTANCE_ID: instance.instanceId,
        VERIFIED_SENDER: process.env.VERIFIED_SENDER || "",
        START_KEYWORD: process.env.START_KEYWORD || "start",
        NOTIFICATION_EMAIL: notificationEmail,
        ADMIN_EMAIL: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
        ALLOWED_EMAILS: allowedEmails.join(","),
        GDRIVE_REMOTE: driveRemote,
        GDRIVE_ROOT: driveRoot,
      },
      timeout: cdk.Duration.seconds(60), // 60 seconds for start operation
    });

    // Ensure email allowlist exists in SSM (seeded from ADMIN_EMAIL + ALLOWED_EMAILS)
    const seedEmailAllowlistLambda = new lambda.Function(this, "SeedEmailAllowlistLambda", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../src/lambda/SeedEmailAllowlist")),
      environment: {
        PARAM_NAME: "/minecraft/email-allowlist",
        SEED_VALUE: emailAllowlistSeed,
      },
      timeout: cdk.Duration.seconds(30),
    });

    seedEmailAllowlistLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/email-allowlist`],
      })
    );

    const seedEmailAllowlistProvider = new cr.Provider(this, "SeedEmailAllowlistProvider", {
      onEventHandler: seedEmailAllowlistLambda,
    });

    new cdk.CustomResource(this, "SeedEmailAllowlist", {
      serviceToken: seedEmailAllowlistProvider.serviceToken,
    });

    // Grant Lambda permissions (scoped to specific instance where possible)
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StartInstances"],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`],
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances"],
        resources: ["*"], // DescribeInstances doesn't support resource-level permissions
      })
    );

    // Grant Lambda permission to send email (for notifications)
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    // Grant Lambda permission to read/write email allowlist in SSM
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/email-allowlist`],
      })
    );

    // Grant Lambda permission to read/write backups cache in SSM
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/backups-cache`],
      })
    );

    // Grant Lambda permission to manage server-action lock parameter
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/server-action`],
      })
    );

    // Grant Lambda permission to run SSM commands on EC2 (scoped to Minecraft instance only)
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:SendCommand"],
        resources: [
          `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
          `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
        ],
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetCommandInvocation"],
        resources: ["*"],
      })
    );

    // Subscribe Lambda to SNS
    startTopic.addSubscription(new subscriptions.LambdaSubscription(startLambda));

    // 7. SES Receipt Rule
    // Note: You must manually verify the domain/email in SES Console first!
    const _ruleSet = ses.ReceiptRuleSet.fromReceiptRuleSetName(this, "RuleSet", "default-rule-set");

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
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ses:SetActiveReceiptRuleSet"],
          resources: ["*"], // SES API requires wildcard resource for this action
        }),
      ]),
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
    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: startLambda.functionName,
    });
  }
}
