import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

import * as ssm from "aws-cdk-lib/aws-ssm";
import { resolveServerProfileDirectory, validateServerProfile } from "../../lib/server-profile";
import { createLambdaDeploymentCode } from "./lambda-assets";
import { quotePosixShellArgument } from "./posix-shell";
import { createWorkerRuntimePolicyStatements } from "./worker-runtime-policy";

export class MinecraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const driveRemote = process.env.GDRIVE_REMOTE || "gdrive";
    const driveRoot = process.env.GDRIVE_ROOT || "mc-backups";
    const cloudflareZoneId = process.env.CLOUDFLARE_ZONE_ID?.trim() ?? "";
    const cloudflareDomain = process.env.CLOUDFLARE_MC_DOMAIN?.trim() ?? "";
    const duckdnsDomain = process.env.DUCKDNS_DOMAIN?.trim() ?? "";
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
    const alarmEmail = (process.env.MC_ALARM_EMAIL ?? "").trim().toLowerCase();
    const scheduledBackupEnabled = readOptionalBoolean("MC_SCHEDULED_BACKUP_ENABLED");
    const scheduledBackupExpression = (process.env.MC_SCHEDULED_BACKUP_SCHEDULE ?? "").trim() || "cron(0 5 ? * SUN *)";
    const backupStaleAfterHoursText = (process.env.MC_BACKUP_STALE_AFTER_HOURS ?? "").trim() || "192";
    const backupStaleAfterHours = Number(backupStaleAfterHoursText);
    const operationRetentionDaysText = (process.env.MC_OPERATION_STATE_RETENTION_DAYS ?? "").trim() || "30";
    const operationRetentionDays = Number(operationRetentionDaysText);
    const metricNamespace = `McAws/${this.stackName}`;
    const dnsMode = duckdnsDomain ? "duckdns" : cloudflareDomain ? "cloudflare" : "raw_ip";
    const dnsHostname = duckdnsDomain ? `${duckdnsDomain}.duckdns.org` : cloudflareDomain;

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
    if (alarmEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alarmEmail)) {
      throw new Error("MC_ALARM_EMAIL must be a valid email address when set.");
    }
    if (!/^(?:cron|rate)\([^\r\n]{1,120}\)$/.test(scheduledBackupExpression)) {
      throw new Error("MC_SCHEDULED_BACKUP_SCHEDULE must be one EventBridge cron(...) or rate(...) expression.");
    }
    if (!Number.isSafeInteger(backupStaleAfterHours) || backupStaleAfterHours < 25 || backupStaleAfterHours > 720) {
      throw new Error("MC_BACKUP_STALE_AFTER_HOURS must be an integer from 25 through 720.");
    }
    if (!Number.isSafeInteger(operationRetentionDays) || operationRetentionDays < 1 || operationRetentionDays > 3650) {
      throw new Error("MC_OPERATION_STATE_RETENTION_DAYS must be an integer between 1 and 3650");
    }
    const cloudflareDnsConfigured = Boolean(cloudflareZoneId || cloudflareDomain);
    const duckDnsConfigured = Boolean(duckdnsDomain);
    if (cloudflareDnsConfigured && (!cloudflareZoneId || !cloudflareDomain)) {
      throw new Error("Cloudflare DNS requires both CLOUDFLARE_ZONE_ID and CLOUDFLARE_MC_DOMAIN.");
    }
    if (cloudflareDnsConfigured && duckDnsConfigured) {
      throw new Error("Configure either Cloudflare DNS or DuckDNS, not both.");
    }

    const createProjectLogGroup = (id: string) => {
      const logGroup = new logs.LogGroup(this, id, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      cdk.Tags.of(logGroup).add("McAwsProject", lifecycleProjectTag);
      cdk.Tags.of(logGroup).add("McAwsStack", lifecycleStackTag);
      return logGroup;
    };

    // 0.5 Optional DNS provider SSM parameters for EC2 DNS updates.
    // DNS credentials are pre-materialized with `pnpm dns:secrets:materialize`
    // at the fixed SecureString paths before synthesis/deployment.
    // CloudFormation has no native AWS::SSM::Parameter SecureString resource type, and
    // resolving a NoEcho/dynamic reference into custom-resource properties would expose
    // the plaintext value to that provider event. This stack therefore never accepts it.
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

    if (duckdnsDomain) {
      new ssm.StringParameter(this, "DuckDnsDomain", {
        parameterName: "/minecraft/duckdns-domain",
        stringValue: duckdnsDomain,
        description: "DuckDNS subdomain without .duckdns.org",
      });
    }

    const dnsSecretAdoptionResources: cdk.CustomResource[] = [];
    const dnsSecureParameterNames = [
      ...(cloudflareDnsConfigured ? ["/minecraft/cloudflare-api-token"] : []),
      ...(duckDnsConfigured ? ["/minecraft/duckdns-token"] : []),
    ];
    if (dnsSecureParameterNames.length > 0) {
      const adoptionLogGroup = createProjectLogGroup("AdoptDnsSecureStringLambdaLogGroup");
      const adoptionLambda = new lambda.Function(this, "AdoptDnsSecureStringLambda", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: createLambdaDeploymentCode(
          "AdoptDnsSecureString",
          path.join(__dirname, "../src/lambda/AdoptDnsSecureString")
        ),
        timeout: cdk.Duration.seconds(30),
        logGroup: adoptionLogGroup,
      });
      adoptionLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: dnsSecureParameterNames.map(
            (name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`
          ),
        })
      );
      adoptionLambda.addPermission("CloudFormationInvokeDnsSecretAdoption", {
        principal: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
        sourceAccount: this.account,
      });
      const adoptParameter = (id: string, parameterName: string) => {
        const resource = new cdk.CustomResource(this, id, {
          resourceType: "Custom::AWS",
          serviceToken: adoptionLambda.functionArn,
          properties: { ParameterName: parameterName, MigrationVersion: "1" },
        });
        dnsSecretAdoptionResources.push(resource);
      };
      if (cloudflareDnsConfigured) adoptParameter("CloudflareTokenSecureParam", "/minecraft/cloudflare-api-token");
      if (duckDnsConfigured) adoptParameter("DuckDnsTokenSecureParam", "/minecraft/duckdns-token");
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

    const repositoryRoot = path.resolve(__dirname, "../..");
    const profileDirectory = resolveServerProfileDirectory(repositoryRoot);
    const allowEmptyWhitelist = (process.env.MC_ALLOW_EMPTY_WHITELIST ?? "false").trim().toLowerCase();
    if (allowEmptyWhitelist !== "true" && allowEmptyWhitelist !== "false") {
      throw new Error("MC_ALLOW_EMPTY_WHITELIST must be exactly true or false when set.");
    }
    validateServerProfile(profileDirectory, { allowEmptyWhitelist: allowEmptyWhitelist === "true" });
    const createArchiveAsset = (assetId: string, sourceDirectory: string, excludedBasenames: string[]) => {
      const archive = execFileSync(
        "python3",
        [
          "-c",
          `import io,json,os,stat,sys,zipfile
root=os.path.realpath(sys.argv[1]); excluded=set(json.loads(sys.argv[2])); output=io.BytesIO()
with zipfile.ZipFile(output,"w",zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
  for current,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    for name in dirs+files:
      source=os.path.join(current,name); mode=os.lstat(source).st_mode
      if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)): raise SystemExit("asset contains link or special entry")
    for name in files:
      if name in excluded: continue
      source=os.path.join(current,name); relative=os.path.relpath(source,root).replace(os.sep,"/")
      info=zipfile.ZipInfo(relative,(2020,1,1,0,0,0)); info.create_system=3; info.external_attr=(os.stat(source).st_mode&0xffff)<<16
      with open(source,"rb") as item: archive.writestr(info,item.read(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
sys.stdout.buffer.write(output.getvalue())`,
          sourceDirectory,
          JSON.stringify(excludedBasenames),
        ],
        { encoding: "buffer", maxBuffer: 160 * 1024 * 1024 }
      );
      const digest = createHash("sha256").update(archive).digest("hex");
      const generatedDirectory = path.resolve(cdk.Stage.of(this)?.outdir ?? "cdk.out", "mc-asset-archives");
      fs.mkdirSync(generatedDirectory, { recursive: true, mode: 0o700 });
      const archivePath = path.join(generatedDirectory, `${digest}.zip`);
      if (!fs.existsSync(archivePath)) fs.writeFileSync(archivePath, archive, { mode: 0o600 });
      return new s3assets.Asset(this, assetId, { path: archivePath });
    };
    // A prebuilt deterministic ZIP lets the manifest digest the exact bytes CDK publishes.
    const runtimeAsset = createArchiveAsset("MinecraftRuntimeAsset", path.join(__dirname, "../src/ec2"), [
      "user_data.sh",
    ]);
    const profileAsset = createArchiveAsset("MinecraftServerProfileAsset", profileDirectory, []);
    const archiveSha256 = (asset: s3assets.Asset): string => {
      const assemblyDirectory = cdk.Stage.of(this)?.outdir;
      const archivePath = path.isAbsolute(asset.assetPath)
        ? asset.assetPath
        : path.resolve(assemblyDirectory ?? process.cwd(), asset.assetPath);
      if (!fs.statSync(archivePath).isFile()) {
        throw new Error(`Expected CDK file asset ${asset.node.path} to be one staged ZIP archive.`);
      }
      return createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    };
    const profileManifestParameter = new ssm.StringParameter(this, "ServerProfileManifest", {
      parameterName: "/minecraft/server-profile-manifest",
      description: "Atomic content-addressed Minecraft runtime and server profile asset manifest",
      stringValue: JSON.stringify({
        version: 1,
        runtime: {
          uri: `s3://${runtimeAsset.s3BucketName}/${runtimeAsset.s3ObjectKey}`,
          sha256: archiveSha256(runtimeAsset),
        },
        profile: {
          uri: `s3://${profileAsset.s3BucketName}/${profileAsset.s3ObjectKey}`,
          sha256: archiveSha256(profileAsset),
        },
      }),
    });
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          runtimeAsset.bucket.arnForObjects(runtimeAsset.s3ObjectKey),
          profileAsset.bucket.arnForObjects(profileAsset.s3ObjectKey),
        ],
      })
    );

    const ec2ParameterArn = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`;
    const ec2ReadableParameters = [
      "/minecraft/server-profile-manifest",
      "/minecraft/resume-pending",
      "/minecraft/gdrive-token",
      "/minecraft/cloudflare-zone-id",
      "/minecraft/cloudflare-domain",
      "/minecraft/cloudflare-api-token",
      "/minecraft/duckdns-domain",
      "/minecraft/duckdns-token",
    ];
    const ec2EncryptedParameters = [
      "/minecraft/gdrive-token",
      "/minecraft/cloudflare-api-token",
      "/minecraft/duckdns-token",
    ];

    // Runtime reads are exact; the content-addressed manifest is deliberately read-only.
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ec2ReadableParameters.map(ec2ParameterArn),
      })
    );
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [ec2ParameterArn("/minecraft/player-count")],
      })
    );
    // Add permission to decrypt only the exact SecureString parameters read by root-owned helpers.
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
        conditions: {
          StringEquals: {
            "kms:EncryptionContext:PARAMETER_ARN": ec2EncryptedParameters.map(ec2ParameterArn),
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
    instance.node.addDependency(profileManifestParameter);
    for (const dnsSecretAdoption of dnsSecretAdoptionResources) instance.node.addDependency(dnsSecretAdoption);

    // Propagate ownership tags to the initial root volume so lifecycle operations can prove ownership.
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.propagateTagsToVolumeOnCreation = true;
    cdk.Tags.of(instance).add("Backup", "weekly");
    cdk.Tags.of(instance).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(instance).add("McAwsStack", lifecycleStackTag);
    cdk.Tags.of(instance).add("McAwsManagedRoot", "true");

    const lifecycleLockTable = new dynamodb.Table(this, "LifecycleLockTable", {
      partitionKey: { name: "lockKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttlEpochSeconds",
      // Deletion and replacement intentionally differ below: teardown must not
      // orphan PII-bearing lock state, while a replacement must retain the old
      // table for the mixed-version rollback window.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const lifecycleLockCfnTable = lifecycleLockTable.node.defaultChild as dynamodb.CfnTable;
    lifecycleLockCfnTable.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
    cdk.Tags.of(lifecycleLockTable).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(lifecycleLockTable).add("McAwsStack", lifecycleStackTag);
    cdk.Tags.of(lifecycleLockTable).add("McAwsPurpose", "LifecycleLock");

    const operationStateTable = new dynamodb.Table(this, "OperationStateTable", {
      partitionKey: { name: "operationId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttlEpochSeconds",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(operationStateTable).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(operationStateTable).add("McAwsStack", lifecycleStackTag);
    cdk.Tags.of(operationStateTable).add("McAwsPurpose", "OperationState");

    // Initialize replacement-safe DynamoDB metadata. The mixed-version bridge
    // continues using the old-format SSM lock until a later reviewed cutover.
    const migrateLockLambdaLogGroup = createProjectLogGroup("MigrateServerActionLockLambdaLogGroup");
    const migrateLockLambda = new lambda.Function(this, "MigrateServerActionLockLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: createLambdaDeploymentCode(
        "MigrateServerActionLock",
        path.join(__dirname, "../src/lambda/MigrateServerActionLock")
      ),
      timeout: cdk.Duration.minutes(1),
      logGroup: migrateLockLambdaLogGroup,
    });
    migrateLockLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [lifecycleLockTable.tableArn],
      })
    );
    const migrateLockProviderLogGroup = createProjectLogGroup("MigrateServerActionLockProviderLogGroup");
    const migrateLockProvider = new cr.Provider(this, "MigrateServerActionLockProvider", {
      onEventHandler: migrateLockLambda,
      logGroup: migrateLockProviderLogGroup,
    });
    const migrateLockResource = new cdk.CustomResource(this, "MigrateServerActionLock", {
      serviceToken: migrateLockProvider.serviceToken,
      properties: { Protocol: "dual-v1", MarkerVersion: "2", LockTableName: lifecycleLockTable.tableName },
    });

    // 5. Lambda Function to Start Server
    // Story 1.1 runtime budget alignment:
    // - Mutating flows now budget up to ~12 minutes in worst-case chained paths (resume + restore).
    // - Keep timeout at Lambda maximum to avoid premature termination of legitimate long-running operations.
    // - Stable operation identities make async retries idempotent.
    // - Reserved concurrency is the final process-level serialization boundary for API, schedule, and sanitized email ingress.
    const startMinecraftLambdaTimeout = cdk.Duration.minutes(15);
    // One 15-minute execution must leave enough event age for both configured retries.
    const startMinecraftLambdaMaxEventAge = cdk.Duration.hours(1);
    const lifecycleFailureQueue = new sqs.Queue(this, "LifecycleFailureQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(lifecycleFailureQueue).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(lifecycleFailureQueue).add("McAwsStack", lifecycleStackTag);

    // The sanitizer receives the raw Lambda destination envelope. Keep its own
    // terminal failures separate from the sanitized operational queue so they
    // cannot be mistaken for sanitized records, and alarm on any retained item.
    const failureSanitizerDeadLetterQueue = new sqs.Queue(this, "FailureSanitizerDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(failureSanitizerDeadLetterQueue).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(failureSanitizerDeadLetterQueue).add("McAwsStack", lifecycleStackTag);

    const failureSanitizerLogGroup = createProjectLogGroup("FailureEventSanitizerLambdaLogGroup");
    const failureSanitizerLambda = new lambda.Function(this, "FailureEventSanitizerLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: createLambdaDeploymentCode(
        "FailureEventSanitizer",
        path.join(__dirname, "../src/lambda/FailureEventSanitizer")
      ),
      environment: { FAILURE_QUEUE_URL: lifecycleFailureQueue.queueUrl },
      timeout: cdk.Duration.seconds(30),
      maxEventAge: startMinecraftLambdaMaxEventAge,
      retryAttempts: 2,
      deadLetterQueue: failureSanitizerDeadLetterQueue,
      deadLetterQueueEnabled: true,
      logGroup: failureSanitizerLogGroup,
    });
    lifecycleFailureQueue.grantSendMessages(failureSanitizerLambda);

    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const allowedEmails = (process.env.ALLOWED_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    const emailAllowlistSeed = Array.from(new Set([adminEmail, ...allowedEmails].filter(Boolean))).join(",");

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
    }

    const startLambdaLogGroup = createProjectLogGroup("StartMinecraftLambdaLogGroup");
    const startLambda = new lambda.Function(this, "StartMinecraftLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: createLambdaDeploymentCode(
        "StartMinecraftServer",
        path.join(__dirname, "../src/lambda/StartMinecraftServer")
      ),
      environment: {
        INSTANCE_ID: instance.instanceId,
        VERIFIED_SENDER: sesNotificationsEnabled ? verifiedSender : "",
        SES_INBOUND_COMMANDS_ENABLED: String(sesInboundCommandsEnabled),
        NOTIFICATION_EMAIL: sesNotificationsEnabled ? notificationEmail : "",
        ADMIN_EMAIL: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
        GDRIVE_REMOTE: driveRemote,
        GDRIVE_ROOT: driveRoot,
        MC_PROJECT_TAG: lifecycleProjectTag,
        MC_STACK_TAG: lifecycleStackTag,
        MC_LIFECYCLE_LOCK_TABLE_NAME: lifecycleLockTable.tableName,
        MC_OPERATION_STATE_TABLE_NAME: operationStateTable.tableName,
        MC_OPERATION_STATE_RETENTION_DAYS: String(operationRetentionDays),
        MC_DNS_MODE: dnsMode,
        MC_DNS_HOSTNAME: dnsHostname,
        MC_METRIC_NAMESPACE: metricNamespace,
        MC_BACKUP_STALE_AFTER_HOURS: String(backupStaleAfterHours),
      },
      timeout: startMinecraftLambdaTimeout,
      maxEventAge: startMinecraftLambdaMaxEventAge,
      retryAttempts: 2,
      // The destination processor strips request/response payload data before SQS.
      onFailure: new lambdaDestinations.LambdaDestination(failureSanitizerLambda),
      reservedConcurrentExecutions: 1,
      logGroup: startLambdaLogGroup,
    });
    startLambda.node.addDependency(migrateLockResource);

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
        lifecycleStateTableArns: [lifecycleLockTable.tableArn, operationStateTable.tableArn],
        includeCostExplorer,
      }),
    });
    workerRuntimePolicy.attachToUser(workerRuntimeUser);

    // Ensure email allowlist exists in SSM (seeded from ADMIN_EMAIL + ALLOWED_EMAILS)
    const seedEmailAllowlistLambdaLogGroup = createProjectLogGroup("SeedEmailAllowlistLambdaLogGroup");
    const seedEmailAllowlistLambda = new lambda.Function(this, "SeedEmailAllowlistLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: createLambdaDeploymentCode("SeedEmailAllowlist", path.join(__dirname, "../src/lambda/SeedEmailAllowlist")),
      environment: {
        PARAM_NAME: "/minecraft/email-allowlist",
        SEED_VALUE: emailAllowlistSeed,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: seedEmailAllowlistLambdaLogGroup,
    });

    seedEmailAllowlistLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/email-allowlist`],
      })
    );

    const seedEmailAllowlistProviderLogGroup = createProjectLogGroup("SeedEmailAllowlistProviderLogGroup");
    const seedEmailAllowlistProvider = new cr.Provider(this, "SeedEmailAllowlistProvider", {
      onEventHandler: seedEmailAllowlistLambda,
      logGroup: seedEmailAllowlistProviderLogGroup,
    });

    const seedEmailAllowlistResource = new cdk.CustomResource(this, "SeedEmailAllowlist", {
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
        actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [serverActionArn, serverActionClaimArn],
      })
    );
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [lifecycleLockTable.tableArn, operationStateTable.tableArn],
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
          actions: ["ses:SendEmail"],
          resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${verifiedSender}`],
        })
      );
    }

    // Grant Lambda permission to read/write backups cache in SSM
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/backups-cache`],
      })
    );

    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/server-action`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/gdrive-token`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/last-scheduled-backup-success`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/scheduled-backup-enabled-at`,
        ],
      })
    );

    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/last-scheduled-backup-success`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/scheduled-backup-enabled-at`,
        ],
      })
    );

    // Startup trigger and resume marker remain exact SSM coordination records.
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/startup-triggered-by`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/resume-pending`,
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
        actions: ["ssm:GetCommandInvocation", "ssm:CancelCommand"],
        resources: ["*"],
      })
    );

    const alarmTopic = new sns.Topic(this, "ProjectAlarmTopic", {
      displayName: `${this.stackName} operator alarms`,
      enforceSSL: true,
    });
    cdk.Tags.of(alarmTopic).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(alarmTopic).add("McAwsStack", lifecycleStackTag);
    if (alarmEmail) {
      // CloudFormation creates a PendingConfirmation subscription. AWS sends the
      // confirmation request; alerts are not delivered until the operator accepts it.
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    }
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    const addOperatorAlarm = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
      cdk.Tags.of(alarm).add("McAwsProject", lifecycleProjectTag);
      cdk.Tags.of(alarm).add("McAwsStack", lifecycleStackTag);
      return alarm;
    };

    addOperatorAlarm(
      new cloudwatch.Alarm(this, "MinecraftInstanceStatusCheckAlarm", {
        alarmDescription: "Minecraft EC2 instance or system status checks are failing; see docs/OPERATIONS_GUIDE.md.",
        metric: new cloudwatch.Metric({
          namespace: "AWS/EC2",
          metricName: "StatusCheckFailed",
          dimensionsMap: { InstanceId: instance.instanceId },
          period: cdk.Duration.minutes(1),
          statistic: "Sum",
        }),
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "LifecycleLambdaErrorsAlarm", {
        alarmDescription: "The lifecycle Lambda returned an unhandled error or timed out.",
        metric: startLambda.metricErrors({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    const lifecycleOperationFailureFilter = new logs.MetricFilter(this, "LifecycleOperationFailureMetricFilter", {
      logGroup: startLambdaLogGroup,
      metricNamespace,
      metricName: "LifecycleOperationFailures",
      filterPattern: logs.FilterPattern.anyTerm("LIFECYCLE_OPERATION_FAILED"),
      metricValue: "1",
    });
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "LifecycleOperationFailuresAlarm", {
        alarmDescription:
          "A lifecycle action failed after invocation; inspect its durable operation record and Lambda logs.",
        metric: lifecycleOperationFailureFilter.metric({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "LifecycleLambdaDurationAlarm", {
        alarmDescription: "A lifecycle invocation exceeded 13 minutes and is approaching the 15-minute timeout.",
        metric: startLambda.metricDuration({ period: cdk.Duration.minutes(5), statistic: "Maximum" }),
        evaluationPeriods: 1,
        threshold: cdk.Duration.minutes(13).toMilliseconds(),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "LifecycleLambdaThrottlesAlarm", {
        alarmDescription: "Lifecycle work was throttled; reserved concurrency intentionally remains one.",
        metric: startLambda.metricThrottles({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "LifecycleAsyncEventAgeAlarm", {
        alarmDescription: "Lifecycle asynchronous work has waited at least ten minutes in Lambda's internal queue.",
        metric: new cloudwatch.Metric({
          namespace: "AWS/Lambda",
          metricName: "AsyncEventAge",
          dimensionsMap: { FunctionName: startLambda.functionName },
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        evaluationPeriods: 1,
        threshold: cdk.Duration.minutes(10).toMilliseconds(),
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "LifecycleFailureQueueDepthAlarm", {
        alarmDescription: "At least one lifecycle invocation or scheduled delivery exhausted retries and needs review.",
        metric: lifecycleFailureQueue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );
    addOperatorAlarm(
      new cloudwatch.Alarm(this, "FailureSanitizerDeadLetterQueueDepthAlarm", {
        alarmDescription:
          "Failure sanitizer exhausted retries; its raw lifecycle destination envelope requires restricted review.",
        metric: failureSanitizerDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    );

    if (scheduledBackupEnabled) {
      const scheduledBackupRule = new events.Rule(this, "ScheduledDriveBackupRule", {
        description: "Back up to Drive only when the Minecraft instance is already running.",
        schedule: events.Schedule.expression(scheduledBackupExpression),
      });
      scheduledBackupRule.addTarget(
        new eventsTargets.LambdaFunction(startLambda, {
          event: events.RuleTargetInput.fromObject({
            invocationType: "scheduledBackup",
            eventId: events.EventField.eventId,
            scheduledAt: events.EventField.time,
          }),
          deadLetterQueue: lifecycleFailureQueue,
          maxEventAge: startMinecraftLambdaMaxEventAge,
          retryAttempts: 2,
        })
      );

      const backupFreshnessRule = new events.Rule(this, "ScheduledBackupFreshnessRule", {
        description: "Emit a daily heartbeat indicating whether the latest scheduled backup exceeds its RPO window.",
        schedule: events.Schedule.cron({ minute: "15", hour: "6" }),
      });
      backupFreshnessRule.addTarget(
        new eventsTargets.LambdaFunction(startLambda, {
          event: events.RuleTargetInput.fromObject({
            invocationType: "backupFreshnessCheck",
            eventId: events.EventField.eventId,
            scheduledAt: events.EventField.time,
          }),
          deadLetterQueue: lifecycleFailureQueue,
          maxEventAge: startMinecraftLambdaMaxEventAge,
          retryAttempts: 2,
        })
      );

      addOperatorAlarm(
        new cloudwatch.Alarm(this, "ScheduledBackupFailuresAlarm", {
          alarmDescription: "An automated Drive backup failed while the server was running.",
          metric: new cloudwatch.Metric({
            namespace: metricNamespace,
            metricName: "ScheduledBackupFailure",
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          evaluationPeriods: 1,
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        })
      );
      addOperatorAlarm(
        new cloudwatch.Alarm(this, "ScheduledBackupStalenessAlarm", {
          alarmDescription: `No scheduled Drive backup has succeeded within the configured ${backupStaleAfterHours}-hour RPO window.`,
          metric: new cloudwatch.Metric({
            namespace: metricNamespace,
            metricName: "ScheduledBackupStale",
            period: cdk.Duration.days(1),
            statistic: "Maximum",
          }),
          evaluationPeriods: 1,
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          // The first evaluator invocation establishes and emits a fresh baseline.
          // Missing data before that first datapoint must not page the operator.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        })
      );
    }

    let inboundEmailLambda: lambda.Function | undefined;
    if (sesInboundCommandsEnabled) {
      const startTopic = new sns.Topic(this, "MinecraftStartTopic", {
        displayName: "Minecraft inbound email command trigger",
      });
      const inboundEmailLogGroup = createProjectLogGroup("InboundEmailCommandLambdaLogGroup");
      inboundEmailLambda = new lambda.Function(this, "InboundEmailCommandLambda", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: createLambdaDeploymentCode(
          "InboundEmailCommand",
          path.join(__dirname, "../src/lambda/InboundEmailCommand")
        ),
        environment: {
          LIFECYCLE_FUNCTION_NAME: startLambda.functionName,
          EXPECTED_TOPIC_ARN: startTopic.topicArn,
          EXPECTED_RECIPIENT: sesInboundRecipient,
          START_KEYWORD: startKeyword,
          ADMIN_EMAIL: adminEmail,
          ALLOWED_EMAILS: allowedEmails.join(","),
        },
        timeout: cdk.Duration.seconds(30),
        maxEventAge: cdk.Duration.minutes(5),
        retryAttempts: 2,
        logGroup: inboundEmailLogGroup,
      });
      startLambda.grantInvoke(inboundEmailLambda);
      inboundEmailLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter", "ssm:PutParameter"],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/email-allowlist`],
        })
      );
      const inboundSubscription = startTopic.addSubscription(new subscriptions.LambdaSubscription(inboundEmailLambda));
      inboundSubscription.node.addDependency(seedEmailAllowlistResource);

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

    // Existing service-created /aws/lambda/<function-name> groups cannot be adopted
    // by the new explicit LogGroup resources. Update only exact CloudFormation-owned
    // function names; a stack-name prefix could include unrelated same-prefix stacks.
    const seedEmailAllowlistProviderFunctionName = cdk.Stack.of(this).splitArn(
      seedEmailAllowlistProvider.serviceToken,
      cdk.ArnFormat.COLON_RESOURCE_NAME
    ).resourceName;
    if (!seedEmailAllowlistProviderFunctionName) {
      throw new Error("Could not resolve the exact SeedEmailAllowlist provider framework Lambda name");
    }
    const legacyOwnedLambdaLogGroupNames = [
      migrateLockLambda,
      failureSanitizerLambda,
      startLambda,
      seedEmailAllowlistLambda,
      ...(inboundEmailLambda ? [inboundEmailLambda] : []),
    ]
      .map((fn) => `/aws/lambda/${fn.functionName}`)
      .concat(`/aws/lambda/${seedEmailAllowlistProviderFunctionName}`);
    const retentionMigrationLogGroup = createProjectLogGroup("RetainLambdaLogsLambdaLogGroup");
    const retentionMigrationLambda = new lambda.Function(this, "RetainLambdaLogsLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: createLambdaDeploymentCode("RetainLambdaLogs", path.join(__dirname, "../src/lambda/RetainLambdaLogs")),
      timeout: cdk.Duration.minutes(1),
      logGroup: retentionMigrationLogGroup,
    });
    retentionMigrationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      })
    );
    retentionMigrationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:PutRetentionPolicy"],
        resources: legacyOwnedLambdaLogGroupNames.map(
          (name) => `arn:aws:logs:${this.region}:${this.account}:log-group:${name}`
        ),
      })
    );
    const retentionMigrationProviderLogGroup = createProjectLogGroup("RetainLambdaLogsProviderLogGroup");
    const retentionMigrationProvider = new cr.Provider(this, "RetainLambdaLogsProvider", {
      onEventHandler: retentionMigrationLambda,
      logGroup: retentionMigrationProviderLogGroup,
    });
    const retentionMigrationResource = new cdk.CustomResource(this, "RetainLambdaLogs", {
      serviceToken: retentionMigrationProvider.serviceToken,
      properties: { LogGroupNames: legacyOwnedLambdaLogGroupNames, RetentionInDays: 30, MigrationVersion: "3" },
    });
    for (const dependency of [migrateLockLambda, failureSanitizerLambda, startLambda, seedEmailAllowlistLambda]) {
      retentionMigrationResource.node.addDependency(dependency);
    }
    retentionMigrationResource.node.addDependency(seedEmailAllowlistProvider);
    if (inboundEmailLambda) retentionMigrationResource.node.addDependency(inboundEmailLambda);

    // Outputs
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: startLambda.functionName,
    });
    new cdk.CfnOutput(this, "LifecycleLockTableName", { value: lifecycleLockTable.tableName });
    new cdk.CfnOutput(this, "OperationStateTableName", { value: operationStateTable.tableName });
    new cdk.CfnOutput(this, "AlarmTopicArn", {
      description: "SNS topic used by project CloudWatch alarms; email delivery requires subscription confirmation.",
      value: alarmTopic.topicArn,
    });
    new cdk.CfnOutput(this, "LifecycleFailureQueueUrl", {
      description:
        "Encrypted 14-day queue containing sanitized lifecycle failure records and scheduled delivery events.",
      value: lifecycleFailureQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "FailureSanitizerDeadLetterQueueUrl", {
      description:
        "Restricted raw-envelope queue for terminal sanitizer failures; investigate whenever its depth alarm fires.",
      value: failureSanitizerDeadLetterQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "WorkerRuntimeIamUserName", {
      description: "Dedicated least-privilege IAM user for the Cloudflare Worker runtime (never a human deploy user)",
      value: workerRuntimeUser.userName,
    });
  }
}
