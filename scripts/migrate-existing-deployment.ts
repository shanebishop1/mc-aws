#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CloudFormationTemplate,
  INSTANCE_LOGICAL_ID,
  LEGACY_ACTIVATION_LOGICAL_ID,
  LEGACY_RULE_SET_LOGICAL_ID,
  type OwnershipInspection,
  type StackIdentity,
  assertExclusiveTaggingAcknowledged,
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
  establishOwnershipTags,
  inspectInstanceAndRootVolume,
  legacyResourcesPresentAndRetained,
  normalizePnpmArguments,
  pinDeployedInstanceImage,
  templatesEqual,
} from "./existing-deployment-migration";

// biome-ignore lint/suspicious/noExplicitAny: AWS CLI responses are intentionally handled as open JSON documents.
type JsonRecord = Record<string, any>;
type Stage = "plan" | "retain" | "tags" | "prepare-bridge" | "execute-bridge";

interface Options {
  stage: Stage;
  execute: boolean;
  stackName: string;
  region: string;
  confirmStackId?: string;
  changeSetName?: string;
  assertStandardDeploySafe: boolean;
  confirmExclusiveTagging: boolean;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INFRA_DIR = path.join(ROOT, "infra");
const SAFE_STACK_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);
const BRIDGE_DESCRIPTION = "mc-aws existing-deployment bridge: retain legacy SES removals and pin live EC2 instance";
const RETENTION_DESCRIPTION = "mc-aws existing-deployment stage 1: retain legacy SES resources";
const STACK_ID_PATTERN =
  /^arn:aws(?:-[a-z]+)?:cloudformation:([a-z0-9-]+):(\d{12}):stack\/([A-Za-z][A-Za-z0-9-]{0,127})\/[A-Za-z0-9-]+$/;

class CommandError extends Error {
  readonly output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? ROOT,
      encoding: "utf8",
      env: { ...process.env, AWS_PAGER: "", ...options.env },
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const output = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim();
    throw new CommandError(
      `${command} ${args.slice(0, 4).join(" ")} failed`,
      output || failure.message || "unknown error"
    );
  }
}

function aws(region: string, args: string[]): JsonRecord {
  const output = run("aws", ["--region", region, ...args, "--output", "json"]);
  return output ? JSON.parse(output) : {};
}

function usage(): never {
  console.error(`Usage:
  pnpm migrate:existing
  pnpm migrate:existing -- --stage retain --execute --confirm-stack-id <exact-stack-arn>
  pnpm migrate:existing -- --stage tags --execute --confirm-stack-id <exact-stack-arn> --confirm-exclusive-tagging
  pnpm migrate:existing -- --stage prepare-bridge --execute --confirm-stack-id <exact-stack-arn>
  pnpm migrate:existing -- --stage execute-bridge --execute --confirm-stack-id <exact-stack-arn> --change-set-name <name-or-arn>

Options:
  --stack-name <name>       Default: MinecraftStack
  --region <region>         Default: AWS_REGION/AWS_DEFAULT_REGION/us-west-1
  --assert-standard-deploy-safe  Read-only guard used by normal deployment entry points
  --confirm-exclusive-tagging    Tags stage only: confirms all other stack/EC2 lifecycle/tag writers are paused

Without --execute this command is read-only. Mutation stages require the exact observed StackId ARN.`);
  process.exit(2);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict one-pass CLI parsing keeps unsupported flags fail-closed.
function parseOptions(argv: string[]): Options {
  const arguments_ = normalizePnpmArguments(argv);
  const options: Options = {
    stage: "plan",
    execute: false,
    stackName: "MinecraftStack",
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-1",
    assertStandardDeploySafe: false,
    confirmExclusiveTagging: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = () => arguments_[++index] ?? usage();
    if (argument === "--stage") options.stage = value() as Stage;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--stack-name") options.stackName = value();
    else if (argument === "--region") options.region = value();
    else if (argument === "--confirm-stack-id") options.confirmStackId = value();
    else if (argument === "--change-set-name") options.changeSetName = value();
    else if (argument === "--assert-standard-deploy-safe") options.assertStandardDeploySafe = true;
    else if (argument === "--confirm-exclusive-tagging") options.confirmExclusiveTagging = true;
    else usage();
  }
  if (!new Set<Stage>(["plan", "retain", "tags", "prepare-bridge", "execute-bridge"]).has(options.stage)) usage();
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(options.stackName) || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(options.region))
    usage();
  if (options.execute && options.stage === "plan") usage();
  if (!options.execute && options.stage !== "plan") {
    throw new Error(`--stage ${options.stage} requires --execute; omit both flags for the read-only plan.`);
  }
  assertExclusiveTaggingAcknowledged(options.stage, options.execute, options.confirmExclusiveTagging);
  return options;
}

function stackIdentity(options: Options): { identity: StackIdentity; stack: JsonRecord } {
  const caller = aws(options.region, ["sts", "get-caller-identity"]);
  const described = aws(options.region, ["cloudformation", "describe-stacks", "--stack-name", options.stackName]);
  if (described.Stacks?.length !== 1) throw new Error(`Expected exactly one stack named ${options.stackName}.`);
  const stack = described.Stacks[0];
  const match = STACK_ID_PATTERN.exec(stack.StackId ?? "");
  if (!match) throw new Error("CloudFormation returned a malformed StackId.");
  const [, region, accountId, stackName] = match;
  if (caller.Account !== accountId || region !== options.region || stackName !== options.stackName) {
    throw new Error("AWS caller, requested region, and exact CloudFormation StackId identity do not agree.");
  }
  if (!SAFE_STACK_STATUSES.has(stack.StackStatus)) {
    throw new Error(`Stack must be stable before migration; found ${stack.StackStatus}.`);
  }
  return { identity: { accountId, region, stackId: stack.StackId, stackName }, stack };
}

function requireMutationConfirmation(options: Options, identity: StackIdentity): void {
  if (!options.execute || options.confirmStackId !== identity.stackId) {
    throw new Error(`Mutation refused. Pass --execute --confirm-stack-id ${identity.stackId}`);
  }
}

function getLiveTemplate(identity: StackIdentity): CloudFormationTemplate {
  const response = aws(identity.region, [
    "cloudformation",
    "get-template",
    "--stack-name",
    identity.stackId,
    "--template-stage",
    "Original",
  ]);
  const body = response.TemplateBody;
  return (typeof body === "string" ? JSON.parse(body) : body) as CloudFormationTemplate;
}

function getChangeSetTemplate(identity: StackIdentity, changeSetName: string): CloudFormationTemplate {
  const response = aws(identity.region, [
    "cloudformation",
    "get-template",
    "--stack-name",
    identity.stackId,
    "--change-set-name",
    changeSetName,
    "--template-stage",
    "Original",
  ]);
  const body = response.TemplateBody;
  return (typeof body === "string" ? JSON.parse(body) : body) as CloudFormationTemplate;
}

function requestFile<T>(directory: string, name: string, request: T): string {
  const file = path.join(directory, name);
  writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function physicalInstanceId(identity: StackIdentity): string {
  const response = aws(identity.region, [
    "cloudformation",
    "describe-stack-resource",
    "--stack-name",
    identity.stackId,
    "--logical-resource-id",
    INSTANCE_LOGICAL_ID,
  ]);
  const detail = response.StackResourceDetail;
  if (detail?.ResourceType !== "AWS::EC2::Instance" || !/^i-[a-f0-9]{8,17}$/.test(detail.PhysicalResourceId ?? "")) {
    throw new Error(`CloudFormation did not resolve ${INSTANCE_LOGICAL_ID} to one EC2 instance.`);
  }
  return detail.PhysicalResourceId;
}

function inspectOwnership(identity: StackIdentity): OwnershipInspection {
  const instanceId = physicalInstanceId(identity);
  const instanceResponse = aws(identity.region, ["ec2", "describe-instances", "--instance-ids", instanceId]);
  const instance = instanceResponse.Reservations?.[0]?.Instances?.[0];
  const rootDeviceName = instance?.RootDeviceName;
  const rootVolumeId = instance?.BlockDeviceMappings?.find(
    (mapping: JsonRecord) => mapping.DeviceName === rootDeviceName
  )?.Ebs?.VolumeId;
  if (!/^vol-[a-f0-9]{8,17}$/.test(rootVolumeId ?? ""))
    throw new Error("Could not resolve the instance root EBS volume.");
  const volumeResponse = aws(identity.region, ["ec2", "describe-volumes", "--volume-ids", rootVolumeId]);
  return inspectInstanceAndRootVolume(identity, instanceId, instanceResponse, volumeResponse);
}

function synthesizeCurrentTemplate(identity: StackIdentity, assemblyDirectory: string): CloudFormationTemplate {
  run("pnpm", ["exec", "cdk", "synth", "MinecraftStack", "--quiet", "--output", assemblyDirectory], {
    cwd: INFRA_DIR,
    env: {
      ...process.env,
      CDK_DEFAULT_ACCOUNT: identity.accountId,
      CDK_DEFAULT_REGION: identity.region,
      AWS_DEFAULT_REGION: identity.region,
    },
  });
  assertSynthesizedAssemblyIdentity(identity, {
    manifest: JSON.parse(readFileSync(path.join(assemblyDirectory, "manifest.json"), "utf8")),
    assetManifest: JSON.parse(readFileSync(path.join(assemblyDirectory, "MinecraftStack.assets.json"), "utf8")),
  });
  return JSON.parse(readFileSync(path.join(assemblyDirectory, "MinecraftStack.template.json"), "utf8"));
}

function printInspection(identity: StackIdentity, inspection: OwnershipInspection): void {
  console.log(`StackId: ${identity.stackId}`);
  console.log(`Instance: ${inspection.instanceId} (${inspection.imageId})`);
  console.log(`Root volume: ${inspection.rootVolumeId} (${inspection.rootDeviceName}, DeleteOnTermination=true)`);
  console.log(
    `Missing ownership tags: instance=[${inspection.missingInstanceTags.join(", ") || "none"}], volume=[${inspection.missingVolumeTags.join(", ") || "none"}]`
  );
}

function applyRetention(
  options: Options,
  identity: StackIdentity,
  stack: JsonRecord,
  live: CloudFormationTemplate
): void {
  requireMutationConfirmation(options, identity);
  let retained = buildLegacyRetentionTemplate(live);
  const before = inspectOwnership(identity);
  const pinned = pinDeployedInstanceImage(retained, stack.Parameters ?? [], before.imageId);
  retained = pinned.template;
  if (templatesEqual(retained, live)) {
    console.log("Legacy SES Retain policies and the deployed AMI parameter are already pinned; no update sent.");
    return;
  }
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "mc-aws-retain-"));
  const changeSetName = `mc-aws-existing-retain-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
  try {
    const templateBody = JSON.stringify(retained);
    if (Buffer.byteLength(templateBody, "utf8") > 51_200) {
      throw new Error(
        "Retention template exceeds CloudFormation TemplateBody's 51,200-byte limit; no update was sent."
      );
    }
    const request = {
      StackName: identity.stackId,
      ChangeSetName: changeSetName,
      ChangeSetType: "UPDATE",
      Description: RETENTION_DESCRIPTION,
      TemplateBody: templateBody,
      Parameters: buildChangeSetParameters(retained, live, pinned.parameterOverrides),
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
      ClientToken: `mc-aws-retain-${Date.now()}`,
      IncludeNestedStacks: false,
    };
    const requestPath = requestFile(temporaryDirectory, "create-retention-change-set.json", request);
    aws(identity.region, ["cloudformation", "create-change-set", "--cli-input-json", `file://${requestPath}`]);
    const changeSet = waitForChangeSet(identity, changeSetName);
    try {
      validateAvailableChangeSet(identity, changeSet, RETENTION_DESCRIPTION);
      assertSafeRetentionChangeSet(changeSet.Changes ?? []);
    } catch (error) {
      aws(identity.region, [
        "cloudformation",
        "delete-change-set",
        "--stack-name",
        identity.stackId,
        "--change-set-name",
        changeSetName,
      ]);
      throw error;
    }
    aws(identity.region, [
      "cloudformation",
      "execute-change-set",
      "--stack-name",
      identity.stackId,
      "--change-set-name",
      changeSetName,
      "--client-request-token",
      `mc-aws-retain-execute-${Date.now()}`,
    ]);
    waitForStackUpdate(identity);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  const afterStack = stackIdentity(options);
  if (afterStack.identity.stackId !== identity.stackId) throw new Error("Stack identity changed after retention.");
  const deployed = getLiveTemplate(afterStack.identity);
  assertLegacyResourcesRetained(deployed);
  const after = inspectOwnership(afterStack.identity);
  if (
    after.instanceId !== before.instanceId ||
    after.rootVolumeId !== before.rootVolumeId ||
    after.imageId !== before.imageId
  ) {
    throw new Error("CRITICAL: retention stage completed but instance, root volume, or physical AMI identity changed.");
  }
  assertPinnedInstanceImageTransition(live, deployed, afterStack.stack.Parameters ?? [], before.imageId);
  console.log("Retention stage complete and verified in the deployed template.");
}

function applyTags(options: Options, identity: StackIdentity, live: CloudFormationTemplate): void {
  requireMutationConfirmation(options, identity);
  legacyResourcesPresentAndRetained(live);
  const before = inspectOwnership(identity);
  const after = establishOwnershipTags(identity.stackName, before, {
    inspect: () => inspectOwnership(identity),
    createTags: (resourceId, tags) => {
      aws(identity.region, [
        "ec2",
        "create-tags",
        "--resources",
        resourceId,
        "--tags",
        ...Object.entries(tags).map(([key, value]) => `Key=${key},Value=${value}`),
      ]);
    },
    deleteTags: (resourceId, tags) => {
      aws(identity.region, [
        "ec2",
        "delete-tags",
        "--resources",
        resourceId,
        "--tags",
        ...Object.entries(tags).map(([key, value]) => `Key=${key},Value=${value}`),
      ]);
    },
  });
  console.log(`Ownership tags established and re-read on ${after.instanceId} and ${after.rootVolumeId}.`);
}

function bridgeChangeSetName(): string {
  return `mc-aws-existing-bridge-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
}

function waitForChangeSet(identity: StackIdentity, changeSetName: string): JsonRecord {
  try {
    run("aws", [
      "--region",
      identity.region,
      "cloudformation",
      "wait",
      "change-set-create-complete",
      "--stack-name",
      identity.stackId,
      "--change-set-name",
      changeSetName,
    ]);
  } catch (error) {
    const failed = aws(identity.region, [
      "cloudformation",
      "describe-change-set",
      "--stack-name",
      identity.stackId,
      "--change-set-name",
      changeSetName,
    ]);
    throw new Error(`Migration change set failed: ${failed.StatusReason ?? (error as Error).message}`);
  }
  return aws(identity.region, [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    identity.stackId,
    "--change-set-name",
    changeSetName,
  ]);
}

function validateAvailableChangeSet(identity: StackIdentity, changeSet: JsonRecord, description: string): void {
  if (
    changeSet.StackId !== identity.stackId ||
    changeSet.Description !== description ||
    changeSet.Status !== "CREATE_COMPLETE" ||
    changeSet.ExecutionStatus !== "AVAILABLE"
  ) {
    throw new Error("Change set does not belong to the exact stable migration stack update.");
  }
}

function validateChangeSet(identity: StackIdentity, changeSet: JsonRecord, legacyResourcesManaged: boolean): void {
  validateAvailableChangeSet(identity, changeSet, BRIDGE_DESCRIPTION);
  assertSafeBridgeChangeSet(changeSet.Changes ?? [], legacyResourcesManaged);
}

function waitForStackUpdate(identity: StackIdentity): void {
  run("aws", [
    "--region",
    identity.region,
    "cloudformation",
    "wait",
    "stack-update-complete",
    "--stack-name",
    identity.stackId,
  ]);
}

function prepareBridge(
  options: Options,
  identity: StackIdentity,
  stack: JsonRecord,
  live: CloudFormationTemplate,
  inspection: OwnershipInspection
): void {
  requireMutationConfirmation(options, identity);
  const legacyResourcesManaged = legacyResourcesPresentAndRetained(live);
  assertOwnershipTagsComplete(inspection);
  const assemblyDirectory = mkdtempSync(path.join(tmpdir(), "mc-aws-bridge-"));
  let changeSetName: string | undefined;
  try {
    const current = synthesizeCurrentTemplate(identity, assemblyDirectory);
    const pinnedBridge = buildPinnedInstanceBridgeTemplate(live, current, stack.Parameters ?? [], inspection.imageId);
    const templateBody = JSON.stringify(pinnedBridge.template);
    if (Buffer.byteLength(templateBody, "utf8") > 51_200) {
      throw new Error(
        "Bridge template exceeds CloudFormation TemplateBody's 51,200-byte limit; no assets were published."
      );
    }

    run("pnpm", ["exec", "cdk", "--app", assemblyDirectory, "publish-assets", "MinecraftStack"], {
      cwd: INFRA_DIR,
      env: {
        ...process.env,
        CDK_DEFAULT_ACCOUNT: identity.accountId,
        CDK_DEFAULT_REGION: identity.region,
        AWS_DEFAULT_REGION: identity.region,
      },
    });

    changeSetName = bridgeChangeSetName();
    const request = {
      StackName: identity.stackId,
      ChangeSetName: changeSetName,
      ChangeSetType: "UPDATE",
      Description: BRIDGE_DESCRIPTION,
      TemplateBody: templateBody,
      Parameters: buildChangeSetParameters(pinnedBridge.template, live, pinnedBridge.parameterOverrides),
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
      ClientToken: `mc-aws-bridge-${Date.now()}`,
      IncludeNestedStacks: false,
    };
    const requestPath = requestFile(assemblyDirectory, "create-change-set.json", request);
    aws(identity.region, ["cloudformation", "create-change-set", "--cli-input-json", `file://${requestPath}`]);
    const changeSet = waitForChangeSet(identity, changeSetName);
    try {
      validateChangeSet(identity, changeSet, legacyResourcesManaged);
    } catch (error) {
      aws(identity.region, [
        "cloudformation",
        "delete-change-set",
        "--stack-name",
        identity.stackId,
        "--change-set-name",
        changeSetName,
      ]);
      throw error;
    }
    console.log(`Bridge change set prepared and validated (not executed): ${changeSet.ChangeSetId ?? changeSetName}`);
    console.log("Review it in CloudFormation, then run the execute-bridge stage with that exact name or ARN.");
  } finally {
    rmSync(assemblyDirectory, { recursive: true, force: true });
  }
}

function executeBridge(
  options: Options,
  identity: StackIdentity,
  live: CloudFormationTemplate,
  inspection: OwnershipInspection
): void {
  requireMutationConfirmation(options, identity);
  if (!options.changeSetName || !/^[A-Za-z0-9][-A-Za-z0-9:/.]{0,1023}$/.test(options.changeSetName)) {
    throw new Error("execute-bridge requires --change-set-name with the reviewed change set name or ARN.");
  }
  const legacyResourcesManaged = legacyResourcesPresentAndRetained(live);
  assertOwnershipTagsComplete(inspection);
  const changeSet = aws(identity.region, [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    identity.stackId,
    "--change-set-name",
    options.changeSetName,
  ]);
  validateChangeSet(identity, changeSet, legacyResourcesManaged);
  if (typeof changeSet.ChangeSetId !== "string" || !changeSet.ChangeSetId) {
    throw new Error("Reviewed bridge change set has no immutable ChangeSetId.");
  }
  const pendingTemplate = getChangeSetTemplate(identity, changeSet.ChangeSetId);
  assertPinnedInstanceImageTransition(live, pendingTemplate, changeSet.Parameters ?? [], inspection.imageId, true);
  const originalInstanceId = inspection.instanceId;
  const originalVolumeId = inspection.rootVolumeId;
  const originalImageId = inspection.imageId;
  aws(identity.region, [
    "cloudformation",
    "execute-change-set",
    "--stack-name",
    identity.stackId,
    "--change-set-name",
    changeSet.ChangeSetId,
    "--client-request-token",
    `mc-aws-execute-${Date.now()}`,
  ]);
  waitForStackUpdate(identity);
  const afterStack = stackIdentity(options);
  if (afterStack.identity.stackId !== identity.stackId) {
    throw new Error("Stack identity changed after bridge execution.");
  }
  const after = inspectOwnership(afterStack.identity);
  assertOwnershipTagsComplete(after);
  if (
    after.instanceId !== originalInstanceId ||
    after.rootVolumeId !== originalVolumeId ||
    after.imageId !== originalImageId
  ) {
    throw new Error("CRITICAL: bridge completed but instance, root volume, or physical AMI identity changed.");
  }
  const deployed = getLiveTemplate(afterStack.identity);
  assertPinnedInstanceImageTransition(live, deployed, afterStack.stack.Parameters ?? [], originalImageId);
  if (deployed.Resources[LEGACY_RULE_SET_LOGICAL_ID] || deployed.Resources[LEGACY_ACTIVATION_LOGICAL_ID]) {
    throw new Error("Bridge completed but legacy SES resources remain in the managed template.");
  }
  console.log(`Bridge complete. Preserved instance ${after.instanceId} and root volume ${after.rootVolumeId}.`);
  console.log(
    "The CDK source remains unmodified; normal deployment must still review and resolve its instance diff explicitly."
  );
}

function assertStandardDeploySafe(options: Options): void {
  let identity: StackIdentity;
  try {
    identity = stackIdentity(options).identity;
  } catch (error) {
    if (error instanceof CommandError && /does not exist/i.test(error.output)) return;
    throw error;
  }
  const live = getLiveTemplate(identity);
  if (live.Resources[LEGACY_RULE_SET_LOGICAL_ID] || live.Resources[LEGACY_ACTIVATION_LOGICAL_ID]) {
    throw new Error(
      "Standard deployment blocked: this stack still manages legacy account-wide SES resources. Run pnpm migrate:existing."
    );
  }
  const assemblyDirectory = mkdtempSync(path.join(tmpdir(), "mc-aws-deploy-guard-"));
  try {
    const current = synthesizeCurrentTemplate(identity, assemblyDirectory);
    assertStandardDeploymentInstanceSafe(live, current);
  } finally {
    rmSync(assemblyDirectory, { recursive: true, force: true });
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (options.assertStandardDeploySafe) {
    assertStandardDeploySafe(options);
    return;
  }
  const { identity, stack } = stackIdentity(options);
  const live = getLiveTemplate(identity);

  if (options.stage === "retain") {
    applyRetention(options, identity, stack, live);
    return;
  }
  const inspection = inspectOwnership(identity);
  if (options.stage === "tags") {
    applyTags(options, identity, live);
    return;
  }
  if (options.stage === "prepare-bridge") {
    prepareBridge(options, identity, stack, live, inspection);
    return;
  }
  if (options.stage === "execute-bridge") {
    executeBridge(options, identity, live, inspection);
    return;
  }

  printInspection(identity, inspection);
  const legacyResourcesManaged = Boolean(
    live.Resources[LEGACY_RULE_SET_LOGICAL_ID] || live.Resources[LEGACY_ACTIVATION_LOGICAL_ID]
  );
  const retained = legacyResourcesManaged ? buildLegacyRetentionTemplate(live) : live;
  const pinnedRetention = pinDeployedInstanceImage(retained, stack.Parameters ?? [], inspection.imageId).template;
  console.log(
    legacyResourcesManaged
      ? templatesEqual(pinnedRetention, live)
        ? "Stage 1: legacy SES Retain policies and the AMI parameter pin are already deployed."
        : "Stage 1 required: deploy Retain policies and/or the AMI parameter pin without changing EC2 properties."
      : "Stage 1: legacy SES resources are no longer managed by this stack."
  );
  console.log(
    inspection.missingInstanceTags.length || inspection.missingVolumeTags.length
      ? "Stage 2 required: establish exact ownership tags after identity checks."
      : "Stage 2: ownership tags are already exact."
  );
  const assemblyDirectory = mkdtempSync(path.join(tmpdir(), "mc-aws-plan-"));
  try {
    const current = synthesizeCurrentTemplate(identity, assemblyDirectory);
    buildPinnedInstanceBridgeTemplate(retained, current, stack.Parameters ?? [], inspection.imageId);
    console.log(
      "Stage 3: a current non-instance bridge can be synthesized while pinning the complete live EC2 resource."
    );
  } finally {
    rmSync(assemblyDirectory, { recursive: true, force: true });
  }
  console.log("DRY RUN ONLY: no AWS resource, tag, asset, or change set was created or changed.");
}

try {
  main();
} catch (error) {
  console.error(`Migration refused: ${(error as Error).message}`);
  if (error instanceof CommandError && error.output) console.error(error.output);
  process.exit(1);
}
