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
import { quotePosixShellArgument } from "./posix-shell";
import { createWorkerRuntimePolicyStatements } from "./worker-runtime-policy";

export class MinecraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const driveRemote = process.env.GDRIVE_REMOTE || "gdrive";
    const driveRoot = process.env.GDRIVE_ROOT || "mc-backups";
    const cloudflareZoneId = process.env.CLOUDFLARE_ZONE_ID?.trim() ?? "";
    const cloudflareDomain = process.env.CLOUDFLARE_MC_DOMAIN?.trim() ?? "";
    const cloudflareToken = (process.env.CLOUDFLARE_DNS_API_TOKEN || "").trim();
    const duckdnsDomain = process.env.DUCKDNS_DOMAIN?.trim() ?? "";
    const duckdnsToken = process.env.DUCKDNS_TOKEN?.trim() ?? "";
    const lifecycleProjectTag = "mc-aws";
    const lifecycleStackTag = this.stackName;
    const readOptionalBoolean = (name: string): boolean => {
      const value = (process.env[name] ?? "false").trim().toLowerCase();
      if (value !== "true" && value !== "false") {
        throw new Error(`${name} must be either "true" or "false".`);
      }
      return value === "true";
    };
    const sesNotificationsEnabled = readOptionalBoolean("SES_NOTIFICATIONS_ENABLED");
    const sesInboundCommandsEnabled = readOptionalBoolean("SES_INBOUND_COMMANDS_ENABLED");
    const verifiedSender = (process.env.VERIFIED_SENDER ?? "").trim().toLowerCase();
    const notificationEmail = (process.env.NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const sesInboundRecipient = (process.env.SES_INBOUND_RECIPIENT ?? "").trim().toLowerCase();
    const sesReceiptRuleSetName = (process.env.SES_RECEIPT_RULE_SET_NAME ?? "").trim();
    const startKeyword = (process.env.START_KEYWORD ?? "").trim();
    const al2023Arm64AmiId = (process.env.AL2023_ARM64_AMI_ID ?? "").trim();

    if (!/^ami-[a-f0-9]{8,17}$/.test(al2023Arm64AmiId)) {
      throw new Error(
        "AL2023_ARM64_AMI_ID must be an exact setup-managed AMI ID. Run bash ./setup.sh or the explicit pnpm ami:upgrade workflow."
      );
    }

    if (sesNotificationsEnabled && (!verifiedSender || !notificationEmail)) {
      throw new Error(
        "SES notifications require VERIFIED_SENDER and NOTIFICATION_EMAIL (or ADMIN_EMAIL) to be configured."
      );
    }
    if (sesInboundCommandsEnabled && (!sesInboundRecipient || !sesReceiptRuleSetName || !startKeyword)) {
      throw new Error(
        "Inbound SES commands require SES_INBOUND_RECIPIENT, SES_RECEIPT_RULE_SET_NAME, and START_KEYWORD."
      );
    }

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
      installLatestAwsSdk: false,
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

    const createSecureStringParameter = (id: string, parameterName: string, valueParameter: cdk.CfnParameter) => {
      new cr.AwsCustomResource(this, id, {
        installLatestAwsSdk: false,
        onUpdate: {
          service: "SSM",
          action: "putParameter",
          parameters: {
            Name: parameterName,
            Value: valueParameter.valueAsString,
            Type: "SecureString",
            Overwrite: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(id),
        },
        onDelete: {
          service: "SSM",
          action: "deleteParameter",
          parameters: {
            Name: parameterName,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${parameterName}`],
          }),
        ]),
      });
    };

    // 0.5 Optional DNS provider SSM parameters for EC2 DNS updates.
    if (cloudflareZoneId) {
      new ssm.StringParameter(this, "CloudflareZoneId", {
        parameterName: "/minecraft/cloudflare-zone-id",
        stringValue: cloudflareZoneId,
        description: "Cloudflare Zone ID for DNS updates",
      });
    }

    if (cloudflareDomain) {
      new ssm.StringParameter(this, "CloudflareDomain", {
        parameterName: "/minecraft/cloudflare-domain",
        stringValue: cloudflareDomain,
        description: "Domain name to update (e.g., mc.example.com)",
      });
    }

    if (cloudflareToken) {
      const cloudflareTokenParam = new cdk.CfnParameter(this, "CloudflareTokenParam", {
        type: "String",
        description: "Cloudflare API Token for DNS updates",
        noEcho: true,
      });
      createSecureStringParameter(
        "CloudflareTokenSecureParam",
        "/minecraft/cloudflare-api-token",
        cloudflareTokenParam
      );
    }

    if (duckdnsDomain) {
      new ssm.StringParameter(this, "DuckDnsDomain", {
        parameterName: "/minecraft/duckdns-domain",
        stringValue: duckdnsDomain,
        description: "DuckDNS subdomain without .duckdns.org",
      });
    }

    if (duckdnsToken) {
      const duckDnsTokenParam = new cdk.CfnParameter(this, "DuckDnsTokenParam", {
        type: "String",
        description: "DuckDNS token for DNS updates",
        noEcho: true,
      });
      createSecureStringParameter("DuckDnsTokenSecureParam", "/minecraft/duckdns-token", duckDnsTokenParam);
    }

    // 1. VPC
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", {
      isDefault: true,
    });

    // 2. IAM Role for EC2
    const ec2Role = new iam.Role(this, "MinecraftServerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    // Add permissions to read/write SSM parameters (GitHub credentials, player count, startup trigger)
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
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
          StringLike: {
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
        (line) =>
          `${line}export GDRIVE_REMOTE=${quotePosixShellArgument(driveRemote)}\nexport GDRIVE_ROOT=${quotePosixShellArgument(driveRoot)}\n`
      );

    // Fallback if no shebang was found (should not happen, but keeps user-data valid)
    const userDataScript = baseUserData.startsWith("#!/")
      ? baseUserData
      : `#!/usr/bin/env bash\nexport GDRIVE_REMOTE=${quotePosixShellArgument(driveRemote)}\nexport GDRIVE_ROOT=${quotePosixShellArgument(driveRoot)}\n${baseUserData}`;

    const instance = new ec2.Instance(this, "MinecraftServer", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.genericLinux({ [this.region]: al2023Arm64AmiId }),
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

    // Propagate ownership tags to the initial root volume so lifecycle operations can prove ownership.
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.propagateTagsToVolumeOnCreation = true;
    cdk.Tags.of(instance).add("Backup", "weekly");
    cdk.Tags.of(instance).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(instance).add("McAwsStack", lifecycleStackTag);
    cdk.Tags.of(instance).add("McAwsManagedRoot", "true");

    // 5. Lambda Function to Start Server
    // Story 1.1 runtime budget alignment:
    // - Mutating flows now budget up to ~12 minutes in worst-case chained paths (resume + restore).
    // - Keep timeout at Lambda maximum to avoid premature termination of legitimate long-running operations.
    // - Disable async retries to avoid duplicate non-idempotent mutating actions.
    const startMinecraftLambdaTimeout = cdk.Duration.minutes(15);
    const startMinecraftLambdaMaxEventAge = cdk.Duration.minutes(15);

    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const allowedEmails = (process.env.ALLOWED_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    const emailAllowlistSeed = Array.from(
      new Set([notificationEmail, adminEmail, ...allowedEmails].filter(Boolean))
    ).join(",");

    if (sesNotificationsEnabled) {
      // SSM parameters are created only when EC2 notifications are enabled.
      new ssm.StringParameter(this, "VerifiedSender", {
        parameterName: "/minecraft/verified-sender",
        stringValue: verifiedSender,
        description: "Verified SES sender email for notifications",
      });

      new ssm.StringParameter(this, "NotificationEmail", {
        parameterName: "/minecraft/notification-email",
        stringValue: notificationEmail,
        description: "Email address for server notifications",
      });

      const senderIdentityArn = `arn:aws:ses:${this.region}:${this.account}:identity/${verifiedSender}`;
      ec2Role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: [senderIdentityArn],
        })
      );
    }

    const startLambda = new lambda.Function(this, "StartMinecraftLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../src/lambda/StartMinecraftServer")),
      environment: {
        INSTANCE_ID: instance.instanceId,
        VERIFIED_SENDER: sesNotificationsEnabled ? verifiedSender : "",
        START_KEYWORD: sesInboundCommandsEnabled ? startKeyword : "",
        SES_INBOUND_COMMANDS_ENABLED: String(sesInboundCommandsEnabled),
        NOTIFICATION_EMAIL: sesNotificationsEnabled ? notificationEmail : "",
        ADMIN_EMAIL: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
        ALLOWED_EMAILS: allowedEmails.join(","),
        GDRIVE_REMOTE: driveRemote,
        GDRIVE_ROOT: driveRoot,
        MC_PROJECT_TAG: lifecycleProjectTag,
        MC_STACK_TAG: lifecycleStackTag,
      },
      timeout: startMinecraftLambdaTimeout,
      maxEventAge: startMinecraftLambdaMaxEventAge,
      retryAttempts: 0,
    });

    // Dedicated Cloudflare Worker runtime identity. Access keys are deliberately
    // not CloudFormation resources: setup creates them in memory and uploads
    // them directly to Wrangler so no key value enters a template or output.
    const workerRuntimeUser = new iam.User(this, "WorkerRuntimeUser");
    cdk.Tags.of(workerRuntimeUser).add("McAwsProject", "mc-aws");
    cdk.Tags.of(workerRuntimeUser).add("McAwsPurpose", "CloudflareWorkerRuntime");
    cdk.Tags.of(workerRuntimeUser).add("McAwsStack", this.stackName);

    const parameterArn = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`;
    const serverActionArn = parameterArn("/minecraft/server-action");
    const serverActionClaimArn = parameterArn("/minecraft/server-action-delete-claim/*");
    const operationPathArn = parameterArn("/minecraft/operations");
    const operationChildrenArn = parameterArn("/minecraft/operations/*");
    const readableParameterArns = [
      parameterArn("/minecraft/email-allowlist"),
      parameterArn("/minecraft/player-count"),
      parameterArn("/minecraft/backups-cache"),
      parameterArn("/minecraft/gdrive-token"),
      serverActionArn,
      serverActionClaimArn,
      operationPathArn,
      operationChildrenArn,
    ];
    const writableParameterArns = [
      parameterArn("/minecraft/email-allowlist"),
      parameterArn("/minecraft/gdrive-token"),
      serverActionArn,
      serverActionClaimArn,
      operationChildrenArn,
    ];
    const deletableParameterArns = [serverActionArn, serverActionClaimArn, operationChildrenArn];
    const includeCostExplorer = (process.env.AWS_COST_EXPLORER_ENABLED ?? "true").trim().toLowerCase() !== "false";

    const workerRuntimePolicy = new iam.ManagedPolicy(this, "WorkerRuntimeManagedPolicy", {
      statements: createWorkerRuntimePolicyStatements({
        instanceArn: `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
        lifecycleLambdaArn: startLambda.functionArn,
        stackArn: `arn:aws:cloudformation:${this.region}:${this.account}:stack/${this.stackName}/*`,
        runShellScriptDocumentArn: `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
        readableParameterArns,
        writableParameterArns,
        deletableParameterArns,
        operationParameterPathArns: [operationPathArn, operationChildrenArn],
        includeCostExplorer,
      }),
    });
    workerRuntimePolicy.attachToUser(workerRuntimeUser);

    // Ensure email allowlist exists in SSM (seeded from ADMIN_EMAIL + ALLOWED_EMAILS)
    const seedEmailAllowlistLambda = new lambda.Function(this, "SeedEmailAllowlistLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
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
        actions: ["ec2:StartInstances", "ec2:StopInstances", "ec2:AttachVolume", "ec2:DetachVolume"],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`],
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:DescribeImages", "ec2:DescribeVolumes"],
        resources: ["*"], // These EC2 describe actions don't support resource-level permissions.
      })
    );

    const lifecycleVolumeArn = `arn:aws:ec2:${this.region}:${this.account}:volume/*`;
    const lifecycleVolumeConditions = {
      StringEquals: {
        "ec2:ResourceTag/McAwsProject": lifecycleProjectTag,
        "ec2:ResourceTag/McAwsStack": lifecycleStackTag,
        "ec2:ResourceTag/McAwsManagedRoot": "true",
      },
    };
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume"],
        resources: [lifecycleVolumeArn],
        conditions: lifecycleVolumeConditions,
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateVolume"],
        resources: [lifecycleVolumeArn],
        conditions: {
          StringEquals: {
            "aws:RequestTag/McAwsProject": lifecycleProjectTag,
            "aws:RequestTag/McAwsStack": lifecycleStackTag,
            "aws:RequestTag/McAwsInstanceId": instance.instanceId,
            "aws:RequestTag/McAwsManagedRoot": "true",
            "aws:RequestTag/McAwsReconstructed": "true",
          },
          "ForAllValues:StringEquals": {
            "aws:TagKeys": [
              "Name",
              "Backup",
              "McAwsProject",
              "McAwsStack",
              "McAwsInstanceId",
              "McAwsManagedRoot",
              "McAwsReconstructed",
              "ReconstructionSourceImageId",
              "ReconstructionSourceSnapshotId",
            ],
          },
        },
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateVolume"],
        resources: [`arn:aws:ec2:${this.region}:*:snapshot/*`],
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: [lifecycleVolumeArn],
        conditions: {
          StringEquals: {
            "ec2:CreateAction": "CreateVolume",
            "aws:RequestTag/McAwsProject": lifecycleProjectTag,
            "aws:RequestTag/McAwsStack": lifecycleStackTag,
            "aws:RequestTag/McAwsInstanceId": instance.instanceId,
            "aws:RequestTag/McAwsManagedRoot": "true",
            "aws:RequestTag/McAwsReconstructed": "true",
          },
        },
      })
    );

    if (sesNotificationsEnabled) {
      startLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${verifiedSender}`],
        })
      );
    }

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

    // Grant Lambda permission to manage server-action lock and durable operation state parameters
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/server-action`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/startup-triggered-by`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/operations/*`,
        ],
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

    if (sesInboundCommandsEnabled) {
      const startTopic = new sns.Topic(this, "MinecraftStartTopic", {
        displayName: "Minecraft inbound email command trigger",
      });
      startTopic.addSubscription(new subscriptions.LambdaSubscription(startLambda));

      // The rule set is account-wide SES configuration owned by the operator. Importing
      // it ensures this stack creates and deletes only its own receipt rule.
      const existingRuleSet = ses.ReceiptRuleSet.fromReceiptRuleSetName(
        this,
        "ExistingReceiptRuleSet",
        sesReceiptRuleSetName
      );
      existingRuleSet.addRule("InboundCommandRule", {
        receiptRuleName: `mc-aws-${this.stackName}-inbound-commands`.slice(0, 64),
        recipients: [sesInboundRecipient],
        scanEnabled: true,
        tlsPolicy: ses.TlsPolicy.REQUIRE,
        actions: [new sesActions.Sns({ topic: startTopic })],
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: startLambda.functionName,
    });
    new cdk.CfnOutput(this, "WorkerRuntimeIamUserName", {
      description: "Dedicated least-privilege IAM user for the Cloudflare Worker runtime (never a human deploy user)",
      value: workerRuntimeUser.userName,
    });
  }
}
