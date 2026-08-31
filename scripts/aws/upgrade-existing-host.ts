#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { bootstrapPinsFingerprint, validateBootstrapPins } from "../../lib/bootstrap-pins";
import {
  type CloudFormationTemplate,
  INSTANCE_LOGICAL_ID,
  assertStandardDeploymentInstanceSafe,
} from "./existing-deployment-migration";
import {
  type HostIdentity,
  assertApplicationBackupProof,
  assertCompletedRootSnapshot,
  assertExactReplacementConfirmations,
  assertReviewedInstanceReplacementPlan,
  assertSafeToReleaseRuntimeRollout,
  assertSafeToReleaseUpgradeQuiescence,
  envOutputLines,
  replacementConfirmationPhrase,
  runtimeFileDigest,
  validateRequiredStackOutputs,
} from "./existing-host-upgrade";

// biome-ignore lint/suspicious/noExplicitAny: AWS CLI documents are intentionally open records.
type JsonRecord = Record<string, any>;
type Command = "plan" | "rollout-runtime" | "prepare-replacement" | "execute-replacement" | "recover";

interface Options {
  command: Command;
  region: string;
  stackName: string;
  confirmStackId?: string;
  confirmInstanceId?: string;
  confirmPins?: string;
  confirmSnapshotId?: string;
  confirmChangeSetId?: string;
  confirmReplacement?: string;
  confirmRecovery?: string;
}

interface UpgradeState {
  schemaVersion: 1;
  status: "prepared" | "executing" | "recovery-required" | "complete";
  identity: HostIdentity;
  snapshotId: string;
  changeSetId: string;
  backupName: string;
  backupProof: { name: string; size: number; modifiedAt: string };
  newInstanceId?: string;
  quiescenceLockValue?: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INFRA = path.join(ROOT, "infra");
const STATE_PATH = path.resolve(process.env.MC_AWS_HOST_UPGRADE_STATE || ".mc-aws-host-upgrade.json");
const PINS = validateBootstrapPins(
  JSON.parse(readFileSync(path.join(ROOT, "config/bootstrap-pins.json"), "utf8")) as unknown
);
const PINS_SHA256 = bootstrapPinsFingerprint(PINS);

class CommandFailure extends Error {
  constructor(
    message: string,
    readonly output: string
  ) {
    super(message);
  }
}

function usage(): never {
  console.error(`Usage:
  pnpm host:upgrade -- plan [--region <region>] [--stack-name <name>]
  pnpm host:upgrade -- rollout-runtime --confirm-stack-id <arn> --confirm-instance-id <id> --confirm-pins <sha256>
  pnpm host:upgrade -- prepare-replacement --confirm-stack-id <arn> --confirm-instance-id <id>
  pnpm host:upgrade -- execute-replacement --confirm-stack-id <arn> --confirm-instance-id <old-id> \\
    --confirm-snapshot-id <snap-id> --confirm-change-set-id <arn> --confirm-replacement '<exact phrase>'
  pnpm host:upgrade -- recover --confirm-stack-id <arn> --confirm-instance-id <new-id> \\
    --confirm-recovery 'RESTORE <new-id> FROM <backup.tar.gz>'

plan is read-only. rollout-runtime is the supported idempotent existing-host path.
prepare creates a fresh Drive backup, stops EC2, creates a billed EBS snapshot,
publishes assets, and prepares (but does not execute) a replacement change set.`);
  process.exit(2);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict CLI parsing rejects unsupported confirmation combinations fail-closed.
function parseOptions(argv: string[]): Options {
  if (argv[0] === "--") argv.shift();
  const command = argv.shift() as Command;
  if (
    !new Set<Command>(["plan", "rollout-runtime", "prepare-replacement", "execute-replacement", "recover"]).has(command)
  )
    usage();
  const options: Options = {
    command,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-1",
    stackName: "MinecraftStack",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => argv[++index] ?? usage();
    if (argument === "--region") options.region = value();
    else if (argument === "--stack-name") options.stackName = value();
    else if (argument === "--confirm-stack-id") options.confirmStackId = value();
    else if (argument === "--confirm-instance-id") options.confirmInstanceId = value();
    else if (argument === "--confirm-pins") options.confirmPins = value();
    else if (argument === "--confirm-snapshot-id") options.confirmSnapshotId = value();
    else if (argument === "--confirm-change-set-id") options.confirmChangeSetId = value();
    else if (argument === "--confirm-replacement") options.confirmReplacement = value();
    else if (argument === "--confirm-recovery") options.confirmRecovery = value();
    else usage();
  }
  return options;
}

function run(command: string, args: string[], cwd = ROOT): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, AWS_PAGER: "" },
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const output = `${failure.stderr ?? ""}${failure.stdout ?? ""}`.trim();
    throw new CommandFailure(
      `${command} ${args.slice(0, 4).join(" ")} failed`,
      output || failure.message || "unknown error"
    );
  }
}

function aws(region: string, args: string[]): JsonRecord {
  const output = run("aws", ["--region", region, ...args, "--output", "json"]);
  return output ? JSON.parse(output) : {};
}

function writeState(state: UpgradeState): void {
  const temporary = `${STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, STATE_PATH);
}

function readState(): UpgradeState {
  const linkStatus = lstatSync(STATE_PATH);
  const status = statSync(STATE_PATH);
  if (
    linkStatus.isSymbolicLink() ||
    !linkStatus.isFile() ||
    status.nlink !== 1 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    (status.mode & 0o777) !== 0o600
  ) {
    throw new Error("Host-upgrade recovery state must be one current-user-owned 0600 regular file");
  }
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as UpgradeState;
  if (state.schemaVersion !== 1) throw new Error("Unsupported host-upgrade recovery state");
  return state;
}

function stack(options: Options): JsonRecord {
  const response = aws(options.region, ["cloudformation", "describe-stacks", "--stack-name", options.stackName]);
  if (response.Stacks?.length !== 1) throw new Error("Expected exactly one target stack");
  const found = response.Stacks[0];
  if (!new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]).has(found.StackStatus)) {
    throw new Error(`Host workflow requires a stable stack; found ${found.StackStatus}`);
  }
  return found;
}

function stackOutputs(found: JsonRecord): Record<string, unknown> {
  return Object.fromEntries((found.Outputs ?? []).map((output: JsonRecord) => [output.OutputKey, output.OutputValue]));
}

function liveTemplate(options: Options, found: JsonRecord): CloudFormationTemplate {
  const response = aws(options.region, [
    "cloudformation",
    "get-template",
    "--stack-name",
    found.StackId,
    "--template-stage",
    "Original",
  ]);
  return (
    typeof response.TemplateBody === "string" ? JSON.parse(response.TemplateBody) : response.TemplateBody
  ) as CloudFormationTemplate;
}

function hostIdentity(options: Options, found: JsonRecord): HostIdentity {
  const outputs = stackOutputs(found);
  const instanceId = outputs.InstanceId;
  if (typeof instanceId !== "string") throw new Error("Stack has no InstanceId output");
  const response = aws(options.region, ["ec2", "describe-instances", "--instance-ids", instanceId]);
  const instance = response.Reservations?.[0]?.Instances?.[0];
  const root = instance?.BlockDeviceMappings?.find(
    (mapping: JsonRecord) => mapping.DeviceName === instance.RootDeviceName
  );
  if (!instance || !root?.Ebs?.VolumeId || root.Ebs.DeleteOnTermination !== true) {
    throw new Error("Could not prove the live DeleteOnTermination root volume");
  }
  const volume = aws(options.region, ["ec2", "describe-volumes", "--volume-ids", root.Ebs.VolumeId]).Volumes?.[0];
  if (
    !volume ||
    volume.Encrypted !== true ||
    volume.State !== "in-use" ||
    volume.Attachments?.length !== 1 ||
    volume.Attachments[0].InstanceId !== instanceId ||
    volume.Attachments[0].State !== "attached"
  ) {
    throw new Error("Could not prove one encrypted root volume attached only to the live instance");
  }
  const targetAmiId = (process.env.AL2023_ARM64_AMI_ID ?? "").trim();
  if (!/^ami-[a-f0-9]{8,17}$/.test(targetAmiId)) {
    throw new Error("AL2023_ARM64_AMI_ID must be loaded from the reviewed deployment environment");
  }
  return {
    stackId: found.StackId,
    instanceId,
    rootVolumeId: root.Ebs.VolumeId,
    currentAmiId: instance.ImageId,
    targetAmiId,
  };
}

function assertBasicConfirmation(options: Options, identity: HostIdentity): void {
  if (options.confirmStackId !== identity.stackId || options.confirmInstanceId !== identity.instanceId) {
    throw new Error(
      `Mutation refused. Pass --confirm-stack-id ${identity.stackId} --confirm-instance-id ${identity.instanceId}`
    );
  }
}

function ssmCommand(region: string, instanceId: string, commands: string[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-host-command-"));
  try {
    const input = path.join(directory, "request.json");
    writeFileSync(
      input,
      JSON.stringify({ InstanceIds: [instanceId], DocumentName: "AWS-RunShellScript", Parameters: { commands } }),
      { mode: 0o600 }
    );
    const sent = aws(region, ["ssm", "send-command", "--cli-input-json", `file://${input}`]);
    const commandId = sent.Command?.CommandId;
    if (typeof commandId !== "string") throw new Error("SSM did not return a command ID");
    run("aws", [
      "--region",
      region,
      "ssm",
      "wait",
      "command-executed",
      "--command-id",
      commandId,
      "--instance-id",
      instanceId,
    ]);
    const result = aws(region, [
      "ssm",
      "get-command-invocation",
      "--command-id",
      commandId,
      "--instance-id",
      instanceId,
    ]);
    if (result.Status !== "Success")
      throw new Error(`Host command failed: ${result.StandardErrorContent || result.Status}`);
    return String(result.StandardOutputContent ?? "").trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function acquireQuiescence(options: Options, leaseMs = 2 * 60 * 60 * 1000): { value: string; release: () => void } {
  const name = "/minecraft/server-action";
  const lifecycleTable = stackOutputs(stack(options)).LifecycleLockTableName;
  if (typeof lifecycleTable === "string" && lifecycleTable) {
    const metadata = aws(options.region, [
      "dynamodb",
      "get-item",
      "--table-name",
      lifecycleTable,
      "--key",
      '{"lockKey":{"S":"protocol#dual-v1"}}',
      "--consistent-read",
    ]);
    if (metadata.Item?.protocolVersion?.S !== "dual-v1") {
      throw new Error("Lifecycle quiescence refused: dual-v1 protocol metadata is missing");
    }
    const current = aws(options.region, [
      "dynamodb",
      "get-item",
      "--table-name",
      lifecycleTable,
      "--key",
      '{"lockKey":{"S":"minecraft-server-lifecycle"}}',
      "--consistent-read",
    ]).Item;
    if (current && current.released?.BOOL !== true && Number(current.leaseExpiresAt?.N ?? Number.NaN) >= Date.now()) {
      throw new Error("Lifecycle quiescence refused: a dual-v1 DynamoDB lifecycle action is active");
    }
  }
  try {
    aws(options.region, ["ssm", "get-parameter", "--name", name]);
    throw new Error("Lifecycle quiescence refused: /minecraft/server-action already exists");
  } catch (error) {
    if (!(error instanceof CommandFailure) || !/ParameterNotFound/.test(error.output)) throw error;
  }
  const now = Date.now();
  const value = JSON.stringify({
    lockId: randomUUID(),
    action: "backup",
    ownerEmail: "host-upgrade@local.invalid",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
  });
  aws(options.region, ["ssm", "put-parameter", "--name", name, "--type", "String", "--value", value]);
  return {
    value,
    release: () => {
      const current = aws(options.region, ["ssm", "get-parameter", "--name", name]);
      if (current.Parameter?.Value !== value)
        throw new Error("Quiescence lock identity changed; refusing to delete it");
      aws(options.region, ["ssm", "delete-parameter", "--name", name]);
    },
  };
}

function rolloutRuntime(options: Options, identity: HostIdentity): void {
  assertBasicConfirmation(options, identity);
  if (options.confirmPins !== PINS_SHA256) throw new Error(`Pass --confirm-pins ${PINS_SHA256}`);
  // A failed in-place rollout may have replaced helpers before dependency checks
  // finish. Keep lifecycle operations fail-closed for a long recovery window;
  // only an entirely verified rollout releases this exact owner lock.
  const quiescence = acquireQuiescence(options, Date.parse("9999-12-31T23:59:59.999Z") - Date.now());
  let rolloutVerified = false;
  try {
    const sources = ["mc-wait-ready.sh", "mc-runtime-rollout.sh"].map((name) => {
      const bytes = readFileSync(path.join(ROOT, "infra/src/ec2", name));
      return { name, bytes, digest: runtimeFileDigest(bytes) };
    });
    const installCommands = sources.flatMap(({ name, bytes, digest }) => [
      `printf '%s' '${bytes.toString("base64")}' | base64 -d > '/tmp/${name}.${digest}'`,
      `printf '%s  %s\n' '${digest}' '/tmp/${name}.${digest}' | sha256sum --check --status`,
      `install -o root -g root -m 0755 '/tmp/${name}.${digest}' '/usr/local/bin/${name}'`,
    ]);
    const paperSha = PINS.artifacts.paper.sha256;
    const output = ssmCommand(options.region, identity.instanceId, [
      "set -euo pipefail; umask 077",
      ...installCommands,
      `/usr/local/bin/mc-runtime-rollout.sh --confirm-pins '${PINS_SHA256}'`,
      `grep -Fx 'pins ${PINS_SHA256}' /var/lib/mc-aws/runtime-hashes.sha256`,
      `grep -Fx 'paper ${paperSha}' /var/lib/mc-aws/runtime-hashes.sha256`,
      ...sources.map(
        ({ name, digest }) => `grep -Fx '${name.replace(/\.sh$/, "")} ${digest}' /var/lib/mc-aws/runtime-hashes.sha256`
      ),
    ]);
    assertSafeToReleaseRuntimeRollout({
      rolloutSucceeded: true,
      helperHashesMatch: true,
      dependencyVersionsMatch: true,
    });
    rolloutVerified = true;
    console.log(output);
  } finally {
    if (rolloutVerified) quiescence.release();
    else
      console.error(
        "Runtime rollout fail-closed: lifecycle quiescence remains for recovery; do not delete it until helpers, dependencies, hashes, and readiness are verified."
      );
  }
}

function plan(options: Options, found: JsonRecord, identity: HostIdentity): void {
  const live = liveTemplate(options, found);
  const liveInstance = live.Resources?.[INSTANCE_LOGICAL_ID];
  if (!liveInstance) throw new Error(`Live template has no ${INSTANCE_LOGICAL_ID}`);
  console.log(`Stack: ${identity.stackId}`);
  console.log(`Instance/root: ${identity.instanceId} / ${identity.rootVolumeId}`);
  console.log(`AMI: ${identity.currentAmiId} -> ${identity.targetAmiId}`);
  console.log(`Bootstrap pins: ${PINS_SHA256}`);
  if (identity.currentAmiId === identity.targetAmiId) {
    console.log("AMI is unchanged. Use rollout-runtime for an idempotent in-place bootstrap/security pin rollout.");
  } else {
    console.log("AMI differs: CloudFormation replacement is required; UserData will run only on the new instance.");
    console.log("Next: prepare-replacement with exact StackId and instance confirmations shown above.");
  }
  console.log("No AWS resource was changed.");
}

function waitInstance(region: string, instanceId: string, state: "running" | "stopped"): void {
  run("aws", ["--region", region, "ec2", "wait", `instance-${state}`, "--instance-ids", instanceId]);
}

function readRemoteBackupProof(region: string, instanceId: string, backupName: string): UpgradeState["backupProof"] {
  const output = ssmCommand(region, instanceId, [
    "sudo /usr/local/bin/mc-rclone-config.sh >/dev/null",
    `sudo RCLONE_CONFIG=/opt/setup/rclone/rclone.conf rclone lsjson --files-only --no-mimetype "$(cat /etc/minecraft/gdrive-remote):$(cat /etc/minecraft/gdrive-root)/${backupName}" | python3 -c 'import json,sys; v=json.load(sys.stdin); x=v[0] if isinstance(v,list) else v; print(json.dumps({"name":x.get("Name") or x.get("Path"),"size":x["Size"],"modifiedAt":x["ModTime"]},separators=(",",":")))'`,
  ]);
  const item = JSON.parse(output.split("\n").slice(-1)[0]);
  const proof = {
    name: String(item?.name ?? ""),
    size: Number(item?.size),
    modifiedAt: String(item?.modifiedAt ?? ""),
  };
  assertApplicationBackupProof(backupName, proof);
  return proof;
}

function prepareReplacement(options: Options, found: JsonRecord, identity: HostIdentity): void {
  assertBasicConfirmation(options, identity);
  if (identity.currentAmiId === identity.targetAmiId)
    throw new Error("AMI is unchanged; use rollout-runtime instead of replacement");
  const quiescence = acquireQuiescence(options);
  let instanceStopped = false;
  try {
    const backupBase = `host-upgrade-${new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14)}`;
    const backupName = `${backupBase}.tar.gz`;
    ssmCommand(options.region, identity.instanceId, [`sudo /usr/local/bin/mc-backup.sh '${backupBase}'`]);
    const backupProof = readRemoteBackupProof(options.region, identity.instanceId, backupName);

    ssmCommand(options.region, identity.instanceId, ["sudo systemctl stop minecraft.service"]);
    aws(options.region, ["ec2", "stop-instances", "--instance-ids", identity.instanceId]);
    waitInstance(options.region, identity.instanceId, "stopped");
    instanceStopped = true;
    const created = aws(options.region, [
      "ec2",
      "create-snapshot",
      "--volume-id",
      identity.rootVolumeId,
      "--description",
      `mc-aws reviewed host upgrade ${identity.stackId}`,
      "--tag-specifications",
      `ResourceType=snapshot,Tags=[{Key=McAwsProject,Value=mc-aws},{Key=McAwsStack,Value=${options.stackName}},{Key=McAwsPurpose,Value=HostUpgradeRollback}]`,
    ]);
    const snapshotId = created.SnapshotId;
    run("aws", ["--region", options.region, "ec2", "wait", "snapshot-completed", "--snapshot-ids", snapshotId]);
    const snapshot = aws(options.region, ["ec2", "describe-snapshots", "--snapshot-ids", snapshotId]).Snapshots?.[0];
    assertCompletedRootSnapshot(identity, snapshot);

    const changeSetName = `mc-aws-host-replacement-${Date.now()}`;
    run(
      "pnpm",
      [
        "exec",
        "cdk",
        "deploy",
        "MinecraftStack",
        "--method",
        "prepare-change-set",
        "--change-set-name",
        changeSetName,
        "--require-approval",
        "never",
      ],
      INFRA
    );
    const changeSet = aws(options.region, [
      "cloudformation",
      "describe-change-set",
      "--stack-name",
      found.StackId,
      "--change-set-name",
      changeSetName,
      "--include-property-values",
    ]);
    assertReviewedInstanceReplacementPlan(identity, changeSet, INSTANCE_LOGICAL_ID);
    const changeSetId = changeSet.ChangeSetId;
    const state: UpgradeState = {
      schemaVersion: 1,
      status: "prepared",
      identity,
      snapshotId,
      changeSetId,
      backupName,
      backupProof,
    };
    writeState(state);
    console.log(`Prepared and validated replacement: ${changeSetId}`);
    console.log(`Completed rollback snapshot (billed until deleted): ${snapshotId}`);
    console.log(`Verified Drive backup: ${backupName}`);
    console.log(`Confirmation: ${replacementConfirmationPhrase(identity, snapshotId)}`);
  } finally {
    if (instanceStopped) {
      aws(options.region, ["ec2", "start-instances", "--instance-ids", identity.instanceId]);
      waitInstance(options.region, identity.instanceId, "running");
    }
    quiescence.release();
  }
}

function writeEnvValue(file: string, name: string, value: string): void {
  const absolute = path.resolve(file);
  const linkStatus = lstatSync(absolute);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) throw new Error(`${file} must be a regular file`);
  const original = readFileSync(absolute, "utf8");
  const lines = original.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (!line.startsWith(`${name}=`)) return line;
    found = true;
    return `${name}=${value}`;
  });
  if (!found) updated.push(`${name}=${value}`);
  const temporary = `${absolute}.tmp.${process.pid}`;
  writeFileSync(temporary, `${updated.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, absolute);
}

function persistOutputs(found: JsonRecord): void {
  const outputs = validateRequiredStackOutputs(stackOutputs(found));
  for (const [name, value] of Object.entries(envOutputLines(outputs))) {
    writeEnvValue(".env.production", name, value);
    writeEnvValue(".env.local", name, value);
  }
  run("node", [
    "scripts/shared/deployment-manifest.mjs",
    "aws-deployed",
    "--stack-id",
    found.StackId,
    "--instance-id",
    outputs.InstanceId,
    "--runtime-user",
    outputs.WorkerRuntimeIamUserName,
  ]);
}

function postRestore(options: Options, state: UpgradeState, newInstanceId: string): void {
  waitInstance(options.region, newInstanceId, "running");
  let managed = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = aws(options.region, [
      "ssm",
      "describe-instance-information",
      "--filters",
      `Key=InstanceIds,Values=${newInstanceId}`,
    ]);
    if (
      response.InstanceInformationList?.some(
        (item: JsonRecord) => item.InstanceId === newInstanceId && item.PingStatus === "Online"
      )
    ) {
      managed = true;
      break;
    }
    run("sleep", ["5"]);
  }
  if (!managed) throw new Error("Replacement instance did not become SSM-online");
  const backupBase = state.backupName.replace(/\.tar\.gz$/, "");
  const waitReadyDigest = runtimeFileDigest(readFileSync(path.join(ROOT, "infra/src/ec2/mc-wait-ready.sh")));
  const rolloutDigest = runtimeFileDigest(readFileSync(path.join(ROOT, "infra/src/ec2/mc-runtime-rollout.sh")));
  const output = ssmCommand(options.region, newInstanceId, [
    "while [[ ! -f /var/lib/mc-aws/bootstrap-complete ]]; do sleep 5; done",
    `sudo /usr/local/bin/mc-resume.sh named '${backupBase}.tar.gz'`,
    "sudo /usr/local/bin/mc-wait-ready.sh raw_ip '' ''",
    `grep -Fx 'pins ${PINS_SHA256}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -Fx 'paper ${PINS.artifacts.paper.sha256}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -Fx 'mc-wait-ready ${waitReadyDigest}' /var/lib/mc-aws/runtime-hashes.sha256`,
    `grep -Fx 'mc-runtime-rollout ${rolloutDigest}' /var/lib/mc-aws/runtime-hashes.sha256`,
  ]);
  if (!output.includes('"ready":true')) throw new Error("Replacement readiness output was not successful");
}

function executeReplacement(options: Options, state: UpgradeState): void {
  if (state.status !== "prepared") throw new Error("Replacement state is not prepared");
  assertExactReplacementConfirmations(state.identity, state.snapshotId, state.changeSetId, {
    stackId: options.confirmStackId,
    instanceId: options.confirmInstanceId,
    snapshotId: options.confirmSnapshotId,
    changeSetId: options.confirmChangeSetId,
    phrase: options.confirmReplacement,
  });
  assertApplicationBackupProof(state.backupName, state.backupProof);
  const snapshot = aws(options.region, ["ec2", "describe-snapshots", "--snapshot-ids", state.snapshotId])
    .Snapshots?.[0];
  assertCompletedRootSnapshot(state.identity, snapshot);
  const reviewed = aws(options.region, [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    state.identity.stackId,
    "--change-set-name",
    state.changeSetId,
    "--include-property-values",
  ]);
  assertReviewedInstanceReplacementPlan(state.identity, reviewed, INSTANCE_LOGICAL_ID);
  const pendingResponse = aws(options.region, [
    "cloudformation",
    "get-template",
    "--stack-name",
    state.identity.stackId,
    "--change-set-name",
    state.changeSetId,
    "--template-stage",
    "Original",
  ]);
  const pendingTemplate = (
    typeof pendingResponse.TemplateBody === "string"
      ? JSON.parse(pendingResponse.TemplateBody)
      : pendingResponse.TemplateBody
  ) as CloudFormationTemplate;
  assertStandardDeploymentInstanceSafe(liveTemplate(options, stack(options)), pendingTemplate, undefined, {
    identity: state.identity,
    snapshotId: state.snapshotId,
    snapshot,
    changeSet: reviewed,
    changeSetId: state.changeSetId,
    confirmations: {
      stackId: options.confirmStackId,
      instanceId: options.confirmInstanceId,
      snapshotId: options.confirmSnapshotId,
      changeSetId: options.confirmChangeSetId,
      phrase: options.confirmReplacement,
    },
  });
  const quiescence = acquireQuiescence(options);
  state.quiescenceLockValue = quiescence.value;
  state.status = "executing";
  writeState(state);
  try {
    state.backupProof = readRemoteBackupProof(options.region, state.identity.instanceId, state.backupName);
    writeState(state);
    ssmCommand(options.region, state.identity.instanceId, ["sudo systemctl stop minecraft.service"]);
    aws(options.region, [
      "ssm",
      "put-parameter",
      "--name",
      "/minecraft/resume-pending",
      "--type",
      "String",
      "--overwrite",
      "--value",
      state.backupName,
    ]);
    aws(options.region, ["ec2", "stop-instances", "--instance-ids", state.identity.instanceId]);
    waitInstance(options.region, state.identity.instanceId, "stopped");
    aws(options.region, [
      "cloudformation",
      "execute-change-set",
      "--stack-name",
      state.identity.stackId,
      "--change-set-name",
      state.changeSetId,
    ]);
    run("aws", [
      "--region",
      options.region,
      "cloudformation",
      "wait",
      "stack-update-complete",
      "--stack-name",
      state.identity.stackId,
    ]);
    const after = stack(options);
    const outputs = validateRequiredStackOutputs(stackOutputs(after));
    state.newInstanceId = outputs.InstanceId;
    writeState(state);
    if (outputs.InstanceId === state.identity.instanceId)
      throw new Error("CloudFormation did not replace the instance");
    const replacement = aws(options.region, ["ec2", "describe-instances", "--instance-ids", outputs.InstanceId])
      .Reservations?.[0]?.Instances?.[0];
    if (replacement?.ImageId !== state.identity.targetAmiId) {
      throw new Error("Replacement instance does not use the reviewed target AMI");
    }
    postRestore(options, state, outputs.InstanceId);
    persistOutputs(after);
    assertSafeToReleaseUpgradeQuiescence({
      stackStatus: after.StackStatus,
      instanceState: "running",
      restoreSucceeded: true,
      readinessSucceeded: true,
      hashesMatch: true,
      outputsPersisted: true,
    });
    aws(options.region, ["ssm", "delete-parameter", "--name", "/minecraft/resume-pending"]);
    quiescence.release();
    state.status = "complete";
    writeState(state);
    console.log(`Replacement complete and verified: ${outputs.InstanceId}`);
    console.log("AWS outputs are persisted. Deploy the Worker only after reviewing dual-v1 rollout order.");
  } catch (error) {
    state.status = "recovery-required";
    writeState(state);
    if (state.newInstanceId) aws(options.region, ["ec2", "stop-instances", "--instance-ids", state.newInstanceId]);
    console.error(
      "Recovery stop: resume marker and lifecycle quiescence were retained. Do not deploy the Worker or delete the snapshot."
    );
    if (state.newInstanceId) {
      console.error(
        `After correcting the cause, run: pnpm host:upgrade -- recover --confirm-stack-id '${state.identity.stackId}' --confirm-instance-id '${state.newInstanceId}' --confirm-recovery 'RESTORE ${state.newInstanceId} FROM ${state.backupName}'`
      );
    } else {
      console.error(
        "No replacement instance was proven. Inspect CloudFormation rollback and the stopped old instance; do not delete the lock/marker manually or retry execution."
      );
    }
    throw error;
  }
}

function recover(options: Options, state: UpgradeState): void {
  if (state.status !== "recovery-required" || !state.newInstanceId)
    throw new Error("No replacement recovery is pending");
  const phrase = `RESTORE ${state.newInstanceId} FROM ${state.backupName}`;
  if (
    options.confirmStackId !== state.identity.stackId ||
    options.confirmInstanceId !== state.newInstanceId ||
    options.confirmRecovery !== phrase
  ) {
    throw new Error(`Recovery refused. Pass exact stack/new-instance confirmations and --confirm-recovery '${phrase}'`);
  }
  aws(options.region, ["ec2", "start-instances", "--instance-ids", state.newInstanceId]);
  postRestore(options, state, state.newInstanceId);
  const after = stack(options);
  persistOutputs(after);
  assertSafeToReleaseUpgradeQuiescence({
    stackStatus: after.StackStatus,
    instanceState: "running",
    restoreSucceeded: true,
    readinessSucceeded: true,
    hashesMatch: true,
    outputsPersisted: true,
  });
  aws(options.region, ["ssm", "delete-parameter", "--name", "/minecraft/resume-pending"]);
  // Recovery deliberately removes only the exact host-upgrade owner lock.
  const lock = aws(options.region, ["ssm", "get-parameter", "--name", "/minecraft/server-action"]).Parameter?.Value;
  if (!state.quiescenceLockValue || lock !== state.quiescenceLockValue)
    throw new Error("Recovery lock identity changed");
  aws(options.region, ["ssm", "delete-parameter", "--name", "/minecraft/server-action"]);
  state.status = "complete";
  writeState(state);
}

async function main(): Promise<void> {
  loadDotenv({ path: path.resolve(".env.production"), override: false });
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "execute-replacement") return executeReplacement(options, readState());
  if (options.command === "recover") return recover(options, readState());
  const found = stack(options);
  const identity = hostIdentity(options, found);
  if (options.command === "plan") return plan(options, found, identity);
  if (options.command === "rollout-runtime") return rolloutRuntime(options, identity);
  return prepareReplacement(options, found, identity);
}

main().catch((error) => {
  console.error(`Host upgrade refused: ${(error as Error).message}`);
  if (error instanceof CommandFailure) console.error(error.output);
  process.exit(1);
});
