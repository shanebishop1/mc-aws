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
import { deriveBackupFencePublicKeyPem } from "../../lib/agent/runtime/backup-fence-key";
import { resolveServerProfileDirectory, validateServerProfile } from "../../lib/server-profile";
import { requireSuccessfulIsolatedBuildChild } from "../../scripts/validation/build-child-isolation";
import { validateAgentSkillExclusion } from "../../scripts/validation/validate-agent-skill-exclusion";
import { createLambdaDeploymentCode } from "./lambda-assets";
import { quotePosixShellArgument } from "./posix-shell";
import { createWorkerRuntimePolicyStatements } from "./worker-runtime-policy";

interface HostReleaseBuild {
  archive: string;
  sha256: string;
  bytes: number;
  releaseManifestSha256: string;
  releaseManifestBytes: number;
  agentRuntimeSha256: string;
  agentRuntimeBytes: number;
  agentRuntimeManifestSha256: string;
  agentRuntimeManifestBytes: number;
}

let cachedHostReleaseBuild: HostReleaseBuild | undefined;

export class MinecraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const driveRemote = process.env.GDRIVE_REMOTE || "gdrive";
    const driveRoot = process.env.GDRIVE_ROOT || "mc-backups";
    const cloudflareZoneId = process.env.CLOUDFLARE_ZONE_ID?.trim() ?? "";
    const cloudflareDomain = process.env.CLOUDFLARE_MC_DOMAIN?.trim() ?? "";
    const duckdnsDomain = process.env.DUCKDNS_DOMAIN?.trim() ?? "";
    const requestedDnsMode = (process.env.MC_CONNECTION_MODE?.trim() ?? "").toLowerCase();
    const lifecycleProjectTag = "mc-aws";
    const lifecycleStackTag = this.stackName;
    const setupClaimToken = process.env.MC_AWS_SETUP_CLAIM_TOKEN?.trim() ?? "";
    if (setupClaimToken && !/^[a-f0-9-]{36}$/.test(setupClaimToken)) {
      throw new Error("MC_AWS_SETUP_CLAIM_TOKEN must be a UUID when supplied.");
    }
    if (setupClaimToken) cdk.Tags.of(this).add("McAwsClaimToken", setupClaimToken);
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
    const agentRuntimeEnabled = readOptionalBoolean("MC_AGENT_RUNTIME_ENABLED");
    const backupFencePrivateKey = process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8?.trim() ?? "";
    const recoveryCapsuleAdopted = (process.env.MC_BACKUP_RECOVERY_CAPSULE_ADOPTED ?? "false").trim().toLowerCase();
    const recoveryCapsuleAdoptionDeferred = readOptionalBoolean("MC_BACKUP_RECOVERY_CAPSULE_ADOPTION_DEFERRED");
    const adoptedBackupServerIdentity = process.env.MC_BACKUP_SERVER_IDENTITY?.trim() ?? "";
    const recoveryCapsuleKeyIds = (process.env.MC_BACKUP_RECOVERY_CAPSULE_KEY_IDS ?? "")
      .split(",")
      .map((keyId) => keyId.trim())
      .filter(Boolean);
    const recoveryCapsuleCheckpoint = Number(process.env.MC_BACKUP_RECOVERY_CAPSULE_CHECKPOINT_GENERATION ?? "0");
    const recoveryCapsuleFloor = Number(process.env.MC_BACKUP_RECOVERY_CAPSULE_FLOOR_GENERATION ?? "0");
    const recoveryCapsuleEffectiveCheckpoint = Number(
      process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_GENERATION ??
        process.env.MC_BACKUP_RECOVERY_CAPSULE_CHECKPOINT_GENERATION ??
        "0"
    );
    const recoveryCapsuleEffectiveFloor = Number(
      process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_GENERATION ??
        process.env.MC_BACKUP_RECOVERY_CAPSULE_FLOOR_GENERATION ??
        "0"
    );
    const recoveryCapsuleVerifierSha256 = (process.env.MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_SHA256 ?? "").trim();
    const recoveryCapsuleKeyringSha256 = (process.env.MC_BACKUP_RECOVERY_CAPSULE_KEYRING_SHA256 ?? "").trim();
    const recoveryCapsuleDigest = (process.env.MC_BACKUP_RECOVERY_CAPSULE_DIGEST ?? "").trim();
    const recoveryCapsuleVerifierMetadata = (process.env.MC_BACKUP_RECOVERY_CAPSULE_VERIFIER_METADATA ?? "").trim();
    const recoveryCapsuleCheckpointBackupId =
      process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_BACKUP_ID?.trim() ?? "";
    const recoveryCapsuleFloorBackupId = process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_BACKUP_ID?.trim() ?? "";
    if (recoveryCapsuleAdopted !== "true" && recoveryCapsuleAdopted !== "false") {
      throw new Error("MC_BACKUP_RECOVERY_CAPSULE_ADOPTED must be either true or false.");
    }
    if (recoveryCapsuleAdopted === "true" && !recoveryCapsuleAdoptionDeferred) {
      if (!adoptedBackupServerIdentity || recoveryCapsuleKeyIds.length === 0) {
        throw new Error("Explicit recovery-capsule adoption requires server identity and verifier key IDs.");
      }
      if (
        !Number.isSafeInteger(recoveryCapsuleCheckpoint) ||
        !Number.isSafeInteger(recoveryCapsuleFloor) ||
        recoveryCapsuleFloor > recoveryCapsuleCheckpoint
      ) {
        throw new Error("Recovery-capsule adoption requires a non-decreasing checkpoint/floor.");
      }
      if (
        !Number.isSafeInteger(recoveryCapsuleEffectiveCheckpoint) ||
        !Number.isSafeInteger(recoveryCapsuleEffectiveFloor) ||
        recoveryCapsuleEffectiveFloor > recoveryCapsuleEffectiveCheckpoint ||
        !/^[a-f0-9]{64}$/.test(recoveryCapsuleVerifierSha256) ||
        !/^[a-f0-9]{64}$/.test(recoveryCapsuleKeyringSha256) ||
        !/^[a-f0-9]{64}$/.test(recoveryCapsuleDigest) ||
        !recoveryCapsuleVerifierMetadata ||
        createHash("sha256").update(recoveryCapsuleVerifierMetadata).digest("hex") !== recoveryCapsuleVerifierSha256 ||
        (recoveryCapsuleEffectiveCheckpoint > 0 && !/^[a-f0-9]{32}$/.test(recoveryCapsuleCheckpointBackupId)) ||
        (recoveryCapsuleEffectiveFloor > 0 && !/^[a-f0-9]{32}$/.test(recoveryCapsuleFloorBackupId))
      ) {
        throw new Error(
          "Recovery-capsule adoption requires exact authenticated verifier and monotonic state metadata."
        );
      }
    } else if (adoptedBackupServerIdentity && !recoveryCapsuleAdoptionDeferred) {
      throw new Error("MC_BACKUP_SERVER_IDENTITY requires explicit recovery-capsule adoption.");
    }
    if (agentRuntimeEnabled && !backupFencePrivateKey) {
      throw new Error("MC_AGENT_RUNTIME_ENABLED=true requires MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8.");
    }
    const backupFencePublicKeyPemBase64 = backupFencePrivateKey
      ? Buffer.from(deriveBackupFencePublicKeyPem(backupFencePrivateKey), "ascii").toString("base64")
      : "";
    const metricNamespace = `McAws/${this.stackName}`;
    const dnsMode =
      requestedDnsMode ||
      (duckdnsDomain && process.env.DUCKDNS_TOKEN?.trim()
        ? "duckdns"
        : cloudflareDomain && cloudflareZoneId && process.env.CLOUDFLARE_DNS_API_TOKEN?.trim()
          ? "cloudflare"
          : "raw_ip");
    const dnsHostname =
      dnsMode === "duckdns" ? `${duckdnsDomain}.duckdns.org` : dnsMode === "cloudflare" ? cloudflareDomain : "";

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
    if (!["cloudflare", "duckdns", "raw_ip"].includes(dnsMode)) {
      throw new Error("MC_CONNECTION_MODE must select cloudflare, duckdns, or raw_ip.");
    }
    const cloudflareDnsConfigured = dnsMode === "cloudflare";
    const duckDnsConfigured = dnsMode === "duckdns";
    if (
      cloudflareDnsConfigured &&
      (!cloudflareZoneId || !cloudflareDomain || !process.env.CLOUDFLARE_DNS_API_TOKEN?.trim())
    ) {
      throw new Error("Cloudflare DNS requires both CLOUDFLARE_ZONE_ID and CLOUDFLARE_MC_DOMAIN.");
    }
    if (duckDnsConfigured && !duckdnsDomain) {
      throw new Error("DuckDNS requires DUCKDNS_DOMAIN.");
    }
    if (dnsMode === "cloudflare" && duckdnsDomain) {
      throw new Error("Cloudflare mode cannot include a DuckDNS domain.");
    }
    if (dnsMode === "duckdns" && (cloudflareZoneId || cloudflareDomain)) {
      throw new Error("DuckDNS mode cannot include Cloudflare Minecraft DNS values.");
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

    // DNS credentials and the backup authentication keyring are materialized at
    // fixed paths before deployment. The authoritative dns-mode value is also
    // setup-managed; it is intentionally not a CloudFormation-owned fixed-name
    // parameter, avoiding replacement/ownership races during provider changes.
    if (cloudflareDnsConfigured) {
      new ssm.StringParameter(this, "CloudflareZoneId", {
        parameterName: "/minecraft/cloudflare-zone-id",
        stringValue: cloudflareZoneId,
        description: "Cloudflare Zone ID for DNS updates",
      }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }

    if (cloudflareDnsConfigured) {
      new ssm.StringParameter(this, "CloudflareDomain", {
        parameterName: "/minecraft/cloudflare-domain",
        stringValue: cloudflareDomain,
        description: "Domain name to update (e.g., mc.example.com)",
      }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }

    if (duckDnsConfigured) {
      new ssm.StringParameter(this, "DuckDnsDomain", {
        parameterName: "/minecraft/duckdns-domain",
        stringValue: duckdnsDomain,
        description: "DuckDNS subdomain without .duckdns.org",
      }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }

    const lifecycleLockTable = new dynamodb.Table(this, "LifecycleLockTable", {
      partitionKey: { name: "lockKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttlEpochSeconds",
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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const operationStateCfnTable = operationStateTable.node.defaultChild as dynamodb.CfnTable;
    operationStateCfnTable.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
    cdk.Tags.of(operationStateTable).add("McAwsProject", lifecycleProjectTag);
    cdk.Tags.of(operationStateTable).add("McAwsStack", lifecycleStackTag);
    cdk.Tags.of(operationStateTable).add("McAwsPurpose", "OperationState");

    const legacyBridgeMutationDenyStatement = () =>
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["ssm:PutParameter", "ssm:DeleteParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/server-action`],
      });

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
    const migrateLockLegacyBridgeDenyPolicy = new iam.Policy(this, "MigrateLockLegacyBridgeDenyPolicy", {
      roles: migrateLockLambda.role ? [migrateLockLambda.role] : [],
      statements: [legacyBridgeMutationDenyStatement()],
    });
    migrateLockLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/server-action`],
      })
    );
    const migrateLockProviderLogGroup = createProjectLogGroup("MigrateServerActionLockProviderLogGroup");
    const migrateLockProvider = new cr.Provider(this, "MigrateServerActionLockProvider", {
      onEventHandler: migrateLockLambda,
      logGroup: migrateLockProviderLogGroup,
    });
    const migrateLockResource = new cdk.CustomResource(this, "MigrateServerActionLock", {
      serviceToken: migrateLockProvider.serviceToken,
      properties: {
        Protocol: "dual-v1",
        MarkerVersion: "3",
        MigrationVersion: "3",
        LockTableName: lifecycleLockTable.tableName,
        LegacyParameterName: "/minecraft/server-action",
      },
    });
    migrateLockResource.node.addDependency(lifecycleLockTable);
    migrateLockResource.node.addDependency(operationStateTable);
    migrateLockResource.node.addDependency(migrateLockLegacyBridgeDenyPolicy);

    const retainedParameterResources: cdk.CustomResource[] = [];
    const secureParameterNames = [
      ...(recoveryCapsuleAdoptionDeferred ? [] : ["/minecraft/backup-auth-keyring"]),
      ...(cloudflareDnsConfigured ? ["/minecraft/cloudflare-api-token"] : []),
      ...(duckDnsConfigured ? ["/minecraft/duckdns-token"] : []),
    ];
    const mutableStateParameterNames = recoveryCapsuleAdoptionDeferred
      ? []
      : [
          "/minecraft/backup-generation-checkpoint",
          "/minecraft/restore-generation-floor",
          "/minecraft/backup-transfer-authorization",
        ];
    const recoveryIdentityParameterNames = recoveryCapsuleAdoptionDeferred
      ? []
      : ["/minecraft/backup-server-identity", "/minecraft/backup-verifier-metadata"];
    let backupServerIdentity: cdk.CustomResource | undefined;
    if (
      secureParameterNames.length > 0 ||
      mutableStateParameterNames.length > 0 ||
      recoveryIdentityParameterNames.length > 0
    ) {
      const adoptionLogGroup = createProjectLogGroup("AdoptDnsSecureStringLambdaLogGroup");
      const adoptionLambda = new lambda.Function(this, "AdoptDnsSecureStringLambda", {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: createLambdaDeploymentCode(
          "AdoptDnsSecureString",
          path.join(__dirname, "../src/lambda/AdoptDnsSecureString")
        ),
        timeout: cdk.Duration.seconds(30),
        environment: { MC_OPERATION_STATE_TABLE_NAME: operationStateTable.tableName },
        logGroup: adoptionLogGroup,
      });
      new iam.Policy(this, "AdoptionLegacyBridgeDenyPolicy", {
        roles: adoptionLambda.role ? [adoptionLambda.role] : [],
        statements: [legacyBridgeMutationDenyStatement()],
      });
      adoptionLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            ...secureParameterNames,
            ...mutableStateParameterNames,
            ...recoveryIdentityParameterNames,
            "/minecraft/backup-recovery-adoption-lock",
            "/minecraft/stack-ownership-claim",
          ].map((name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`),
        })
      );
      adoptionLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:PutParameter"],
          resources: [
            ...mutableStateParameterNames,
            ...recoveryIdentityParameterNames,
            "/minecraft/stack-ownership-claim",
          ].map((name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`),
        })
      );
      adoptionLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [operationStateTable.tableArn],
        })
      );
      adoptionLambda.addPermission("CloudFormationInvokeDnsSecretAdoption", {
        principal: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
        sourceAccount: this.account,
      });
      const adoptParameter = (
        id: string,
        parameterName: string,
        parameterType: "SecureString" | "String",
        properties: Record<string, string> = {}
      ) => {
        const resource = new cdk.CustomResource(this, id, {
          resourceType: "Custom::AWS",
          serviceToken: adoptionLambda.functionArn,
          properties: {
            ParameterName: parameterName,
            ParameterType: parameterType,
            ...(parameterType === "String" ? { InitialValue: "UNINITIALIZED" } : {}),
            ...properties,
            MigrationVersion: "2",
          },
        });
        retainedParameterResources.push(resource);
        return resource;
      };
      const stackOwnershipClaim = setupClaimToken
        ? new cdk.CustomResource(this, "StackOwnershipClaim", {
            resourceType: "Custom::StackOwnershipClaim",
            serviceToken: adoptionLambda.functionArn,
            properties: {
              StackOwnershipClaim: "true",
              ClaimParameter: "/minecraft/stack-ownership-claim",
              ClaimToken: setupClaimToken,
            },
          })
        : undefined;
      adoptParameter("BackupAuthKeyringSecureParam", "/minecraft/backup-auth-keyring", "SecureString");
      if (cloudflareDnsConfigured)
        adoptParameter("CloudflareTokenSecureParam", "/minecraft/cloudflare-api-token", "SecureString");
      if (duckDnsConfigured) adoptParameter("DuckDnsTokenSecureParam", "/minecraft/duckdns-token", "SecureString");
      if (!recoveryCapsuleAdoptionDeferred) {
        backupServerIdentity = adoptParameter(
          "BackupServerIdentityParam",
          "/minecraft/backup-server-identity",
          "String",
          {
            ExpectedValue: adoptedBackupServerIdentity || this.stackId,
          }
        );
      }
      if (!recoveryCapsuleAdoptionDeferred) {
        adoptParameter("BackupVerifierMetadataParam", "/minecraft/backup-verifier-metadata", "String");
        adoptParameter("BackupGenerationCheckpointParam", "/minecraft/backup-generation-checkpoint", "String");
        adoptParameter("RestoreGenerationFloorParam", "/minecraft/restore-generation-floor", "String");
        adoptParameter("BackupTransferAuthorizationParam", "/minecraft/backup-transfer-authorization", "String");
      }
      if (stackOwnershipClaim) {
        for (const resource of retainedParameterResources) resource.node.addDependency(stackOwnershipClaim);
      }
      // No parameter-adoption or lifecycle runtime may become available until
      // the provider has observed an empty legacy bridge and committed the
      // DynamoDB cutover barrier.
      for (const resource of retainedParameterResources) resource.node.addDependency(migrateLockResource);
      if (recoveryCapsuleAdopted === "true" && !recoveryCapsuleAdoptionDeferred) {
        const adoption = new cdk.CustomResource(this, "BackupRecoveryCapsuleAdoption", {
          resourceType: "Custom::BackupRecoveryCapsuleAdoption",
          serviceToken: adoptionLambda.functionArn,
          properties: {
            ParameterName: "/minecraft/backup-auth-keyring",
            ParameterType: "SecureString",
            RecoveryCapsuleAdoption: "true",
            ExpectedServerIdentity: adoptedBackupServerIdentity,
            ExpectedKeyIds: recoveryCapsuleKeyIds,
            ExpectedKeyringSha256: recoveryCapsuleKeyringSha256,
            ExpectedVerifierSha256: recoveryCapsuleVerifierSha256,
            ExpectedVerifierMetadata: recoveryCapsuleVerifierMetadata,
            ExpectedCapsuleDigest: recoveryCapsuleDigest,
            ExpectedAccountId: this.account,
            ExpectedRegion: this.region,
            ExpectedStackName: this.stackName,
            ExpectedCheckpointGeneration: String(recoveryCapsuleEffectiveCheckpoint),
            ExpectedRestoreFloorGeneration: String(recoveryCapsuleEffectiveFloor),
            ...(process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_BACKUP_ID
              ? { ExpectedCheckpointBackupId: process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_CHECKPOINT_BACKUP_ID }
              : {}),
            ...(process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_BACKUP_ID
              ? { ExpectedRestoreFloorBackupId: process.env.MC_BACKUP_RECOVERY_CAPSULE_EFFECTIVE_FLOOR_BACKUP_ID }
              : {}),
            RecoveryLockParameter: "/minecraft/backup-recovery-adoption-lock",
            RecoverySchemaVersion: "3",
            MigrationVersion: "3",
          },
        });
        for (const resource of retainedParameterResources) adoption.node.addDependency(resource);
      }
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
    const ec2LegacyBridgeDenyPolicy = new iam.Policy(this, "Ec2LegacyBridgeDenyPolicy", {
      roles: [ec2Role],
      statements: [legacyBridgeMutationDenyStatement()],
    });
    const repositoryRoot = path.resolve(__dirname, "../..");
    const profileDirectory = resolveServerProfileDirectory(repositoryRoot);
    const allowEmptyWhitelist = (process.env.MC_ALLOW_EMPTY_WHITELIST ?? "false").trim().toLowerCase();
    if (allowEmptyWhitelist !== "true" && allowEmptyWhitelist !== "false") {
      throw new Error("MC_ALLOW_EMPTY_WHITELIST must be exactly true or false when set.");
    }
    const profileValidation = validateServerProfile(profileDirectory, {
      allowEmptyWhitelist: allowEmptyWhitelist === "true",
    });
    const hostReleaseBuild =
      cachedHostReleaseBuild ??
      (JSON.parse(
        requireSuccessfulIsolatedBuildChild(
          process.execPath,
          [path.join(repositoryRoot, "scripts/setup/build-host-release.mjs"), "package"],
          repositoryRoot,
          {
            cwd: repositoryRoot,
            home: path.join(repositoryRoot, ".local-artifacts/cdk-build-isolation/home"),
            tmpdir: path.join(repositoryRoot, ".local-artifacts/cdk-build-isolation/tmp"),
            overrides: { NODE_ENV: "production" },
            networkSandbox: process.env.NODE_ENV === "test" ? "test-only" : "required",
          }
        )
      ) as HostReleaseBuild);
    if (
      !path.isAbsolute(hostReleaseBuild.archive) ||
      path.basename(hostReleaseBuild.archive) !== `${hostReleaseBuild.sha256}.zip`
    ) {
      throw new Error("Host release archive path must be an absolute content-addressed file.");
    }
    const hostReleaseDescriptor = fs.openSync(
      hostReleaseBuild.archive,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    let hostReleaseBytes: Buffer;
    let hostReleaseStatus: fs.Stats;
    try {
      hostReleaseStatus = fs.fstatSync(hostReleaseDescriptor);
      if (!hostReleaseStatus.isFile() || hostReleaseStatus.nlink !== 1) {
        throw new Error("Host release archive is not one regular file.");
      }
      hostReleaseBytes = fs.readFileSync(hostReleaseDescriptor);
    } finally {
      fs.closeSync(hostReleaseDescriptor);
    }
    if (
      !/^[a-f0-9]{64}$/.test(hostReleaseBuild.sha256) ||
      !/^[a-f0-9]{64}$/.test(hostReleaseBuild.releaseManifestSha256) ||
      !hostReleaseStatus.isFile() ||
      hostReleaseStatus.size !== hostReleaseBuild.bytes ||
      path.basename(hostReleaseBuild.archive) !== `${hostReleaseBuild.sha256}.zip` ||
      !Number.isSafeInteger(hostReleaseBuild.releaseManifestBytes) ||
      hostReleaseBuild.releaseManifestBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(hostReleaseBuild.agentRuntimeSha256) ||
      !Number.isSafeInteger(hostReleaseBuild.agentRuntimeBytes) ||
      hostReleaseBuild.agentRuntimeBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(hostReleaseBuild.agentRuntimeManifestSha256) ||
      !Number.isSafeInteger(hostReleaseBuild.agentRuntimeManifestBytes) ||
      hostReleaseBuild.agentRuntimeManifestBytes < 1
    ) {
      throw new Error("Host release packaging did not return one content-addressed archive.");
    }
    if (createHash("sha256").update(hostReleaseBytes).digest("hex") !== hostReleaseBuild.sha256) {
      throw new Error("Host release archive content does not match its returned SHA-256 descriptor.");
    }
    const descriptorCheck = JSON.parse(
      requireSuccessfulIsolatedBuildChild(
        "python3",
        [
          "-c",
          `import hashlib,json,sys,zipfile
archive,manifest_hash,manifest_bytes,agent_hash,agent_bytes,agent_manifest_hash,agent_manifest_bytes=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
  names=z.namelist()
  if names.count("release-manifest.json") != 1: raise SystemExit("release manifest descriptor is missing or duplicated")
  raw=z.read("release-manifest.json")
  if len(raw) != int(manifest_bytes) or hashlib.sha256(raw).hexdigest() != manifest_hash: raise SystemExit("release manifest descriptor/hash mismatch")
  value=json.loads(raw)
  agent=value.get("agentRuntime",{})
  expected={"bytes":int(agent_bytes),"sha256":agent_hash,"bundleManifestBytes":int(agent_manifest_bytes),"bundleManifestSha256":agent_manifest_hash}
  if any(agent.get(k) != v for k,v in expected.items()): raise SystemExit("agent runtime descriptor mismatch")
print(json.dumps({"ok":True}))`,
          hostReleaseBuild.archive,
          hostReleaseBuild.releaseManifestSha256,
          String(hostReleaseBuild.releaseManifestBytes),
          hostReleaseBuild.agentRuntimeSha256,
          String(hostReleaseBuild.agentRuntimeBytes),
          hostReleaseBuild.agentRuntimeManifestSha256,
          String(hostReleaseBuild.agentRuntimeManifestBytes),
        ],
        repositoryRoot,
        {
          cwd: repositoryRoot,
          home: path.join(repositoryRoot, ".local-artifacts/cdk-build-isolation/home"),
          tmpdir: path.join(repositoryRoot, ".local-artifacts/cdk-build-isolation/tmp"),
          overrides: { NODE_ENV: "production" },
          networkSandbox: process.env.NODE_ENV === "test" ? "test-only" : "required",
        }
      )
    );
    const parsedDescriptor =
      typeof descriptorCheck === "string"
        ? (JSON.parse(descriptorCheck) as { ok?: boolean })
        : (descriptorCheck as { ok?: boolean });
    if (parsedDescriptor.ok !== true) {
      throw new Error("Host release descriptor validation failed.");
    }
    cachedHostReleaseBuild = hostReleaseBuild;
    const hostReleaseAsset = new s3assets.Asset(this, "MinecraftHostReleaseAsset", {
      path: hostReleaseBuild.archive,
    });
    const cdkOutputDirectory = path.resolve(cdk.Stage.of(this)?.outdir ?? "cdk.out");
    const profileStagingDirectory = path.join(cdkOutputDirectory, "profile-staging");
    fs.rmSync(profileStagingDirectory, { recursive: true, force: true });
    fs.mkdirSync(profileStagingDirectory, { recursive: true, mode: 0o700 });
    // Copy only after the source has passed the profile validator, then validate
    // the actual tree that will be archived. This closes the old gap where CDK
    // received the selected directory and could package an unreviewed new entry.
    const copyProfileTree = (source: string, destination: string): void => {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        if (
          source === profileValidation.directory &&
          ["bootstrap-pins.json", "mise-pins.json"].includes(entry.name.toLowerCase())
        ) {
          continue;
        }
        const destinationPath = path.join(destination, entry.name);
        const sourceStat = fs.lstatSync(sourcePath);
        if (sourceStat.isSymbolicLink() || (!sourceStat.isDirectory() && !sourceStat.isFile())) {
          throw new Error(`Profile changed during CDK staging: ${path.relative(profileDirectory, sourcePath)}`);
        }
        if (sourceStat.isDirectory()) {
          fs.mkdirSync(destinationPath, { recursive: false, mode: 0o700 });
          copyProfileTree(sourcePath, destinationPath);
          continue;
        }
        const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(descriptor);
          if (opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino || !opened.isFile()) {
            throw new Error(`Profile changed during CDK staging: ${path.relative(profileDirectory, sourcePath)}`);
          }
          fs.writeFileSync(destinationPath, fs.readFileSync(descriptor), { mode: 0o600, flag: "wx" });
        } finally {
          fs.closeSync(descriptor);
        }
      }
    };
    copyProfileTree(profileValidation.directory, profileStagingDirectory);
    const stagedProfileValidation = validateServerProfile(profileStagingDirectory, {
      allowEmptyWhitelist: allowEmptyWhitelist === "true",
    });
    if (JSON.stringify(stagedProfileValidation.plugins) !== JSON.stringify(profileValidation.plugins)) {
      throw new Error("Profile changed while preparing the CDK asset.");
    }
    validateAgentSkillExclusion([profileStagingDirectory]);
    requireSuccessfulIsolatedBuildChild(
      "python3",
      [
        "-c",
        `import os,stat,sys,zipfile
root,out=sys.argv[1:]
with zipfile.ZipFile(out,"w",zipfile.ZIP_STORED) as z:
  for current,dirs,files in os.walk(root):
    dirs.sort(); files.sort()
    for name in files:
      source=os.path.join(current,name); rel=os.path.relpath(source,root).replace(os.sep,"/")
      info=zipfile.ZipInfo(rel,(2020,1,1,0,0,0)); info.create_system=3; info.external_attr=((0o100755 if os.stat(source).st_mode&0o111 else 0o100644)&0xffff)<<16
      with open(source,"rb") as item: z.writestr(info,item.read())`,
        profileStagingDirectory,
        path.join(cdkOutputDirectory, "profile.zip"),
      ],
      repositoryRoot,
      {
        cwd: repositoryRoot,
        home: path.join(repositoryRoot, ".local-artifacts/cdk-build-isolation/home"),
        tmpdir: path.join(repositoryRoot, ".local-artifacts/cdk-build-isolation/tmp"),
        overrides: { NODE_ENV: "production" },
        networkSandbox: process.env.NODE_ENV === "test" ? "test-only" : "required",
      }
    );
    const profileArchivePath = path.join(cdkOutputDirectory, "profile.zip");
    const profileAsset = new s3assets.Asset(this, "MinecraftServerProfileAsset", { path: profileArchivePath });
    const archiveSha256 = (asset: s3assets.Asset): string => {
      const assemblyDirectory = cdk.Stage.of(this)?.outdir;
      const archivePath = path.isAbsolute(asset.assetPath)
        ? asset.assetPath
        : path.resolve(assemblyDirectory ?? process.cwd(), asset.assetPath);
      return createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    };
    const profileManifestParameter = new ssm.StringParameter(this, "ServerProfileManifest", {
      parameterName: "/minecraft/server-profile-manifest",
      description: "Atomic content-addressed Minecraft host release and server profile asset manifest",
      stringValue: JSON.stringify({
        version: 3,
        hostRelease: {
          uri: `s3://${hostReleaseAsset.s3BucketName}/${hostReleaseAsset.s3ObjectKey}`,
          sha256: archiveSha256(hostReleaseAsset),
          bytes: hostReleaseBuild.bytes,
          releaseManifestSha256: hostReleaseBuild.releaseManifestSha256,
          releaseManifestBytes: hostReleaseBuild.releaseManifestBytes,
        },
        profile: {
          uri: `s3://${profileAsset.s3BucketName}/${profileAsset.s3ObjectKey}`,
          sha256: archiveSha256(profileAsset),
          fileCount: stagedProfileValidation.fileCount,
          totalBytes: stagedProfileValidation.totalBytes,
          plugins: stagedProfileValidation.plugins,
        },
      }),
    });
    profileManifestParameter.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          hostReleaseAsset.bucket.arnForObjects(hostReleaseAsset.s3ObjectKey),
          profileAsset.bucket.arnForObjects(profileAsset.s3ObjectKey),
        ],
      })
    );

    const ec2ParameterArn = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`;
    const ec2ReadableParameters = [
      "/minecraft/server-profile-manifest",
      "/minecraft/gdrive-token",
      "/minecraft/backup-auth-keyring",
      "/minecraft/backup-server-identity",
      "/minecraft/backup-generation-checkpoint",
      "/minecraft/restore-generation-floor",
      "/minecraft/backup-transfer-authorization",
      "/minecraft/cloudflare-zone-id",
      "/minecraft/cloudflare-domain",
      "/minecraft/cloudflare-api-token",
      "/minecraft/duckdns-domain",
      "/minecraft/duckdns-token",
      "/minecraft/dns-mode",
    ];
    const ec2EncryptedParameters = [
      "/minecraft/gdrive-token",
      "/minecraft/backup-auth-keyring",
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
        resources: [
          ec2ParameterArn("/minecraft/player-count"),
          ec2ParameterArn("/minecraft/backup-generation-checkpoint"),
        ],
      })
    );
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"],
        resources: [operationStateTable.tableArn],
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
          `${line}export GDRIVE_REMOTE=${quotePosixShellArgument(driveRemote)}\nexport GDRIVE_ROOT=${quotePosixShellArgument(driveRoot)}\nexport MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_PEM_BASE64=${quotePosixShellArgument(backupFencePublicKeyPemBase64)}\nexport MC_OPERATION_STATE_TABLE_NAME=${quotePosixShellArgument(operationStateTable.tableName)}\n`
      );

    // Fallback if no shebang was found (should not happen, but keeps user-data valid)
    const userDataScript = baseUserData.startsWith("#!/")
      ? baseUserData
      : `#!/usr/bin/env bash\nexport GDRIVE_REMOTE=${quotePosixShellArgument(driveRemote)}\nexport GDRIVE_ROOT=${quotePosixShellArgument(driveRoot)}\nexport MC_AGENT_BACKUP_FENCE_PUBLIC_KEY_PEM_BASE64=${quotePosixShellArgument(backupFencePublicKeyPemBase64)}\nexport MC_OPERATION_STATE_TABLE_NAME=${quotePosixShellArgument(operationStateTable.tableName)}\n${baseUserData}`;

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
    if (backupServerIdentity) instance.node.addDependency(backupServerIdentity);
    for (const retainedParameter of retainedParameterResources) instance.node.addDependency(retainedParameter);

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
      }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

      new ssm.StringParameter(this, "NotificationEmail", {
        parameterName: "/minecraft/notification-email",
        stringValue: notificationEmail,
        description: "Email address for server notifications",
      }).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
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
        MC_BACKUP_SERVER_IDENTITY: recoveryCapsuleAdoptionDeferred
          ? this.stackId
          : adoptedBackupServerIdentity || this.stackId,
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
    const startLambdaLegacyBridgeDenyPolicy = new iam.Policy(this, "StartLambdaLegacyBridgeDenyPolicy", {
      roles: startLambda.role ? [startLambda.role] : [],
      statements: [legacyBridgeMutationDenyStatement()],
    });
    const parameterArn = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`;

    // The Worker must not read credential-bearing SSM parameters. This small
    // broker is the only runtime principal that can access the Drive token;
    // its response is deliberately reduced to a configured/not-configured
    // status and its write target is fixed in code.
    const gdriveTokenBrokerLogGroup = createProjectLogGroup("GDriveTokenBrokerLambdaLogGroup");
    const gdriveTokenBrokerLambda = new lambda.Function(this, "GDriveTokenBrokerLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: createLambdaDeploymentCode("GDriveTokenBroker", path.join(__dirname, "../src/lambda/GDriveTokenBroker")),
      timeout: cdk.Duration.seconds(30),
      logGroup: gdriveTokenBrokerLogGroup,
    });
    gdriveTokenBrokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [parameterArn("/minecraft/gdrive-token")],
      })
    );

    // Dedicated Cloudflare Worker runtime identity. Access keys are deliberately
    // not CloudFormation resources: setup creates them in memory and uploads
    // them directly to Wrangler so no key value enters a template or output.
    const workerRuntimeUser = new iam.User(this, "WorkerRuntimeUser");
    cdk.Tags.of(workerRuntimeUser).add("McAwsProject", "mc-aws");
    cdk.Tags.of(workerRuntimeUser).add("McAwsPurpose", "CloudflareWorkerRuntime");
    cdk.Tags.of(workerRuntimeUser).add("McAwsStack", this.stackName);

    const serverActionArn = parameterArn("/minecraft/server-action");
    const operationPathArn = parameterArn("/minecraft/operations");
    const operationChildrenArn = parameterArn("/minecraft/operations/*");
    const readableParameterArns = [
      parameterArn("/minecraft/email-allowlist"),
      parameterArn("/minecraft/player-count"),
      parameterArn("/minecraft/backups-cache"),
      serverActionArn,
      operationPathArn,
      operationChildrenArn,
    ];
    const writableParameterArns = [parameterArn("/minecraft/email-allowlist"), operationChildrenArn];
    const includeCostExplorer = (process.env.AWS_COST_EXPLORER_ENABLED ?? "true").trim().toLowerCase() !== "false";

    const workerRuntimePolicy = new iam.ManagedPolicy(this, "WorkerRuntimeManagedPolicy", {
      statements: [
        ...createWorkerRuntimePolicyStatements({
          instanceArn: `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
          lifecycleLambdaArn: startLambda.functionArn,
          gdriveTokenBrokerLambdaArn: gdriveTokenBrokerLambda.functionArn,
          stackArn: `arn:aws:cloudformation:${this.region}:${this.account}:stack/${this.stackName}/*`,
          readableParameterArns,
          writableParameterArns,
          operationParameterPathArns: [operationPathArn, operationChildrenArn],
          lifecycleStateTableArns: [lifecycleLockTable.tableArn, operationStateTable.tableArn],
          includeCostExplorer,
        }),
      ],
    });
    const workerRuntimeLegacyBridgeDenyPolicy = new iam.Policy(this, "WorkerRuntimeLegacyBridgeDenyPolicy", {
      users: [workerRuntimeUser],
      statements: [legacyBridgeMutationDenyStatement()],
    });
    workerRuntimePolicy.attachToUser(workerRuntimeUser);
    migrateLockResource.node.addDependency(ec2LegacyBridgeDenyPolicy);
    migrateLockResource.node.addDependency(startLambdaLegacyBridgeDenyPolicy);
    migrateLockResource.node.addDependency(workerRuntimeLegacyBridgeDenyPolicy);

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
        actions: ["ssm:GetParameter"],
        resources: [serverActionArn],
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
        actions: ["ec2:DescribeInstances", "ec2:DescribeImages", "ec2:DescribeSnapshots", "ec2:DescribeVolumes"],
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

    // Startup attribution is separate from resume coordination. Resume intent
    // is discovered and finalized directly in the retained operation table.
    startLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/startup-triggered-by`],
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
    for (const dependency of [
      migrateLockLambda,
      failureSanitizerLambda,
      startLambda,
      gdriveTokenBrokerLambda,
      seedEmailAllowlistLambda,
    ]) {
      retentionMigrationResource.node.addDependency(dependency);
    }
    retentionMigrationResource.node.addDependency(seedEmailAllowlistProvider);
    if (inboundEmailLambda) retentionMigrationResource.node.addDependency(inboundEmailLambda);

    // Outputs
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: startLambda.functionName,
    });
    new cdk.CfnOutput(this, "GDriveTokenBrokerFunctionName", {
      description: "Exact least-privilege Lambda used by the Worker for Drive token status and storage",
      value: gdriveTokenBrokerLambda.functionName,
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
