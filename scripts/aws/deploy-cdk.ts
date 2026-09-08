#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CloudFormationClient,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import * as dotenv from "dotenv";
import { materializeBackupAuthKeyring } from "../setup/manage-backup-auth-keyring";
import { materializeDnsSecrets } from "../setup/materialize-dns-secrets";
import { assertSynthesizedAssemblyIdentity } from "./existing-deployment-migration";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CDK_TARGET_VARIABLES = ["CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"] as const;
const STACK_ID_PATTERN =
  /^arn:aws(?:-[a-z]+)?:cloudformation:([a-z0-9-]+):(\d{12}):stack\/([A-Za-z][A-Za-z0-9-]{0,127})\/[A-Za-z0-9-]+$/;
const CLAIM_TOKEN_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface DeployTarget {
  account: string;
  region: string;
  stackName: string;
}

interface ManifestDeploymentClaim extends DeployTarget {
  claimToken: string;
  stackId: string;
}

export type ProviderGuardPhase = "before-synth" | "before-deploy";

export interface LiveProviderEvidence {
  account: string;
  region: string;
  stackName: string;
  stackId?: string;
  claimToken?: string;
  exists: boolean;
}

interface DeployDependencies {
  run: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => number;
  materialize: (environment: NodeJS.ProcessEnv) => Promise<string[]>;
  readManifestClaim?: (environment: NodeJS.ProcessEnv) => ManifestDeploymentClaim;
  recordOwnership?: (claim: ManifestDeploymentClaim, environment: NodeJS.ProcessEnv) => void;
  synthesize?: (
    claim: ManifestDeploymentClaim,
    environment: NodeJS.ProcessEnv,
    run: DeployDependencies["run"]
  ) => string;
  /**
   * Must create and execute a provider-bound immutable change set from the
   * already verified assembly. The production dependency intentionally does
   * not provide a name-bound fallback.
   */
  deployProviderBoundChangeSet?: (
    claim: ManifestDeploymentClaim,
    assemblyDirectory: string,
    environment: NodeJS.ProcessEnv
  ) => number | Promise<number>;
  providerGuard?: (claim: ManifestDeploymentClaim, environment: NodeJS.ProcessEnv, phase: ProviderGuardPhase) => void;
  withDeployTransaction?: <T>(callback: () => Promise<T>) => Promise<T>;
}

interface ChangeSetEvidence {
  changeSetId?: string;
  changeSetName?: string;
  stackId?: string;
  stackName?: string;
  status?: string;
  statusReason?: string;
  executionStatus?: string;
}

interface PreparedChangeSetVerification {
  changeSetType: "CREATE" | "UPDATE";
  stackId: string;
  claimToken: string;
}

interface ProviderBoundChangeSetProvider {
  describeChangeSet: (stackIdentifier: string, changeSetName: string, region: string) => Promise<ChangeSetEvidence>;
  getChangeSetTemplate: (stackIdentifier: string, changeSetId: string, region: string) => Promise<string>;
  verifyPreparedChangeSet: (
    stackIdentifier: string,
    changeSetId: string,
    expectedChangeSetType: "CREATE" | "UPDATE",
    expectedStackId: string,
    claimToken: string,
    region: string,
    changeSetStackId: string,
    expectedAccount: string
  ) => Promise<PreparedChangeSetVerification>;
  executeChangeSet: (changeSetId: string, region: string) => Promise<void>;
  waitForChangeSetExecution: (changeSetId: string, region: string) => Promise<void>;
  waitForStack: (stackIdentifier: string, region: string, changeSetType: "CREATE" | "UPDATE") => Promise<void>;
  verifyExecutedStack: (
    stackIdentifier: string,
    expectedStackId: string,
    claimToken: string,
    region: string,
    expectedAccount: string,
    changeSetType: "CREATE" | "UPDATE"
  ) => Promise<void>;
}

const runCommand: DeployDependencies["run"] = (command, args, options) => {
  if (options.env.TMPDIR) mkdirSync(options.env.TMPDIR, { recursive: true, mode: 0o700 });
  return spawnSync(command, args, { ...options, stdio: "inherit" }).status ?? 1;
};

function assertPreparedStackEvidence(
  stack: {
    StackId?: string;
    StackName?: string;
    StackStatus?: string;
    Tags?: Array<{ Key?: string; Value?: string }>;
  },
  stackIdentifier: string,
  expectedChangeSetType: "CREATE" | "UPDATE",
  expectedStackId: string,
  claimToken: string,
  changeSetStackId: string,
  region: string,
  expectedAccount: string
): { stackId: string; changeSetType: "CREATE" | "UPDATE" } {
  const stackId = stack.StackId ?? "";
  const stackName = stack.StackName ?? "";
  const expectedStackName = expectedStackId === "" ? stackIdentifier : STACK_ID_PATTERN.exec(expectedStackId)?.[3];
  const stackMatch = STACK_ID_PATTERN.exec(stackId);
  const tags = (stack.Tags ?? []).filter((tag) => tag.Key === "McAwsClaimToken");
  if (
    !stackMatch ||
    stackMatch[1] !== region ||
    stackMatch[2] !== expectedAccount ||
    stackName !== expectedStackName ||
    tags.length !== 1 ||
    tags[0].Value !== claimToken
  ) {
    throw new Error("Prepared provider stack identity or claim token is not exact.");
  }
  if (stackId !== changeSetStackId || (expectedStackId !== "" && stackId !== expectedStackId)) {
    throw new Error("Prepared provider StackId does not exactly match the manifest claim.");
  }
  const observedChangeSetType = stack.StackStatus === "REVIEW_IN_PROGRESS" ? "CREATE" : "UPDATE";
  if (observedChangeSetType !== expectedChangeSetType) {
    throw new Error("Prepared provider behavior does not prove the expected change-set type.");
  }
  return { stackId, changeSetType: observedChangeSetType };
}

const defaultCloudFormationProvider: ProviderBoundChangeSetProvider = {
  describeChangeSet: async (stackIdentifier, changeSetName, region) => {
    const client = new CloudFormationClient({ region });
    const result = await client.send(
      new DescribeChangeSetCommand({ StackName: stackIdentifier, ChangeSetName: changeSetName })
    );
    return {
      changeSetId: result.ChangeSetId,
      changeSetName: result.ChangeSetName,
      stackId: result.StackId,
      stackName: result.StackName,
      status: result.Status,
      statusReason: result.StatusReason,
      executionStatus: result.ExecutionStatus,
    };
  },
  getChangeSetTemplate: async (stackIdentifier, changeSetId, region) => {
    const client = new CloudFormationClient({ region });
    const result = await client.send(
      new GetTemplateCommand({ StackName: stackIdentifier, ChangeSetName: changeSetId, TemplateStage: "Original" })
    );
    if (typeof result.TemplateBody !== "string")
      throw new Error("Provider change set did not return its exact template body.");
    return result.TemplateBody;
  },
  verifyPreparedChangeSet: async (
    stackIdentifier,
    changeSetId,
    expectedChangeSetType,
    expectedStackId,
    claimToken,
    region,
    changeSetStackId,
    expectedAccount
  ) => {
    const client = new CloudFormationClient({ region });
    const result = await client.send(new DescribeStacksCommand({ StackName: stackIdentifier }));
    if (!Array.isArray(result.Stacks) || result.Stacks.length !== 1) {
      throw new Error("Provider did not return exactly one prepared CloudFormation stack.");
    }
    const stack = result.Stacks[0];
    const stackEvidence = assertPreparedStackEvidence(
      stack,
      stackIdentifier,
      expectedChangeSetType,
      expectedStackId,
      claimToken,
      changeSetStackId,
      region,
      expectedAccount
    );
    if (changeSetId.length === 0) throw new Error("Prepared change set ID is missing.");
    return { ...stackEvidence, claimToken };
  },
  executeChangeSet: async (changeSetId, region) => {
    const client = new CloudFormationClient({ region });
    await client.send(new ExecuteChangeSetCommand({ ChangeSetName: changeSetId }));
  },
  waitForChangeSetExecution: async (changeSetId, region) => {
    const client = new CloudFormationClient({ region });
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      let executionStatus: string | undefined;
      try {
        executionStatus = (await client.send(new DescribeChangeSetCommand({ ChangeSetName: changeSetId })))
          .ExecutionStatus;
      } catch (error) {
        throw new Error(
          `Provider change set ${changeSetId} disappeared while waiting for EXECUTE_COMPLETE: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (executionStatus === "EXECUTE_COMPLETE") return;
      if (executionStatus === "AVAILABLE" || executionStatus === "EXECUTE_IN_PROGRESS") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw new Error(
        `Provider change set ${changeSetId} reached an invalid execution status: ${executionStatus ?? "unknown"}.`
      );
    }
    throw new Error(`Provider change set ${changeSetId} did not reach EXECUTE_COMPLETE before timeout.`);
  },
  waitForStack: async (stackIdentifier, region, changeSetType) => {
    const client = new CloudFormationClient({ region });
    const waiter = changeSetType === "CREATE" ? waitUntilStackCreateComplete : waitUntilStackUpdateComplete;
    const result = await waiter({ client, maxWaitTime: 1800 }, { StackName: stackIdentifier });
    if (result.state !== "SUCCESS") throw new Error(`Provider stack ${changeSetType} did not complete successfully.`);
  },
  verifyExecutedStack: async (stackIdentifier, expectedStackId, claimToken, region, expectedAccount, changeSetType) => {
    const client = new CloudFormationClient({ region });
    const result = await client.send(new DescribeStacksCommand({ StackName: stackIdentifier }));
    if (!Array.isArray(result.Stacks) || result.Stacks.length !== 1) {
      throw new Error("Provider did not return exactly one executed CloudFormation stack.");
    }
    const stack = result.Stacks[0];
    const stackId = stack.StackId ?? "";
    const stackName = stack.StackName ?? "";
    const stackMatch = STACK_ID_PATTERN.exec(stackId);
    const tags = (stack.Tags ?? []).filter((tag) => tag.Key === "McAwsClaimToken");
    if (
      stackId !== expectedStackId ||
      !stackMatch ||
      stackMatch[1] !== region ||
      stackMatch[2] !== expectedAccount ||
      (stackName !== stackIdentifier && stackName !== stackMatch[3]) ||
      tags.length !== 1 ||
      tags[0].Value !== claimToken ||
      stack.StackStatus !== `${changeSetType}_COMPLETE`
    ) {
      throw new Error("Executed provider stack identity, claim, or status is not exact.");
    }
  },
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertProviderChangeSetIdentity(
  claim: ManifestDeploymentClaim,
  expectedChangeSetName: string,
  evidence: ChangeSetEvidence
): void {
  const changeSetIdPattern = new RegExp(
    `^arn:aws(?:-[a-z]+)?:cloudformation:${claim.region}:${claim.account}:changeSet/([^/]+)/([A-Za-z0-9-]+)$`
  );
  const changeSetIdMatch =
    typeof evidence.changeSetId === "string" ? changeSetIdPattern.exec(evidence.changeSetId) : null;
  if (
    !changeSetIdMatch ||
    changeSetIdMatch[1] !== expectedChangeSetName ||
    evidence.changeSetName !== expectedChangeSetName ||
    evidence.stackName !== claim.stackName ||
    evidence.status !== "CREATE_COMPLETE" ||
    evidence.executionStatus !== "AVAILABLE"
  ) {
    throw new Error(`Provider change set identity/status is not exact: ${evidence.statusReason ?? "unknown reason"}`);
  }
  if (typeof evidence.stackId !== "string" || !STACK_ID_PATTERN.test(evidence.stackId)) {
    throw new Error("Provider change set did not return an exact CloudFormation StackId.");
  }
  if (claim.stackId !== "" && evidence.stackId !== claim.stackId) {
    throw new Error("Provider change set StackId does not exactly match the manifest claim.");
  }
  if (claim.stackId === "") {
    const stackMatch = STACK_ID_PATTERN.exec(evidence.stackId);
    if (
      !stackMatch ||
      stackMatch[1] !== claim.region ||
      stackMatch[2] !== claim.account ||
      stackMatch[3] !== claim.stackName
    ) {
      throw new Error("Provider CREATE change set StackId does not match the exact deployment target.");
    }
  }
}

function assertPreparedChangeSetVerification(
  claim: ManifestDeploymentClaim,
  evidence: ChangeSetEvidence,
  verification: PreparedChangeSetVerification
): "CREATE" | "UPDATE" {
  const expectedType = claim.stackId === "" ? "CREATE" : "UPDATE";
  if (verification.changeSetType !== expectedType) {
    throw new Error(`Provider change set type ${verification.changeSetType} does not match ${expectedType}.`);
  }
  if (verification.stackId !== evidence.stackId) {
    throw new Error("Prepared provider StackId does not match the described change set StackId.");
  }
  if (verification.claimToken !== claim.claimToken) {
    throw new Error("Prepared provider claim token does not exactly match the manifest claim.");
  }
  return verification.changeSetType;
}

function assertExactProviderChangeSet(
  claim: ManifestDeploymentClaim,
  expectedChangeSetName: string,
  expectedTemplate: Record<string, unknown>,
  evidence: ChangeSetEvidence,
  verification: PreparedChangeSetVerification,
  providerTemplate: string
): "CREATE" | "UPDATE" {
  assertProviderChangeSetIdentity(claim, expectedChangeSetName, evidence);
  const changeSetType = assertPreparedChangeSetVerification(claim, evidence, verification);
  let parsedTemplate: unknown;
  try {
    parsedTemplate = JSON.parse(providerTemplate);
  } catch {
    throw new Error("Provider change set template is not canonical JSON.");
  }
  if (canonicalJson(parsedTemplate) !== canonicalJson(expectedTemplate)) {
    throw new Error("Provider change set template does not exactly match the validated CDK assembly.");
  }
  assertAssemblyClaim(parsedTemplate as Record<string, unknown>, claim.claimToken);
  return changeSetType;
}

export async function deployProviderBoundChangeSet(
  claim: ManifestDeploymentClaim,
  assemblyDirectory: string,
  environment: NodeJS.ProcessEnv,
  run: DeployDependencies["run"] = runCommand,
  provider: ProviderBoundChangeSetProvider = defaultCloudFormationProvider
): Promise<number> {
  validateManifestClaim(claim);
  const expectedTemplate = readAssemblyJson(assemblyDirectory, `${claim.stackName}.template.json`);
  const assemblyHash = assemblyDigest(assemblyDirectory);
  const changeSetName = `mc-aws-${claim.claimToken}-${assemblyHash.slice(0, 16)}`;
  const status = run(
    "pnpm",
    [
      "exec",
      "cdk",
      "deploy",
      claim.stackName,
      "--app",
      assemblyDirectory,
      "--method",
      "prepare-change-set",
      "--change-set-name",
      changeSetName,
      "--require-approval",
      "never",
    ],
    {
      cwd: path.join(ROOT, "infra"),
      env: {
        ...environment,
        CDK_DEFAULT_ACCOUNT: claim.account,
        CDK_DEFAULT_REGION: claim.region,
        AWS_DEFAULT_REGION: claim.region,
        MC_AWS_SETUP_CLAIM_TOKEN: claim.claimToken,
      },
    }
  );
  if (status !== 0) throw new Error("Provider-bound CDK change-set preparation failed.");
  const stackIdentifier = claim.stackId === "" ? claim.stackName : claim.stackId;
  const expectedChangeSetType = claim.stackId === "" ? "CREATE" : "UPDATE";
  const evidence = await provider.describeChangeSet(stackIdentifier, changeSetName, claim.region);
  assertProviderChangeSetIdentity(claim, changeSetName, evidence);
  if (!evidence.changeSetId) throw new Error("Provider change set ID is missing.");
  const describedStackId = evidence.stackId;
  if (!describedStackId) throw new Error("Provider change set StackId is missing.");
  const verification = await provider.verifyPreparedChangeSet(
    stackIdentifier,
    evidence.changeSetId,
    expectedChangeSetType,
    claim.stackId,
    claim.claimToken,
    claim.region,
    describedStackId,
    claim.account
  );
  const providerTemplate = await provider.getChangeSetTemplate(stackIdentifier, evidence.changeSetId, claim.region);
  const changeSetType = assertExactProviderChangeSet(
    claim,
    changeSetName,
    expectedTemplate,
    evidence,
    verification,
    providerTemplate
  );
  await provider.executeChangeSet(evidence.changeSetId, claim.region);
  await provider.waitForChangeSetExecution(evidence.changeSetId, claim.region);
  await provider.waitForStack(describedStackId, claim.region, changeSetType);
  await provider.verifyExecutedStack(
    describedStackId,
    describedStackId,
    claim.claimToken,
    claim.region,
    claim.account,
    changeSetType
  );
  return 0;
}

export const defaultDependencies: DeployDependencies = {
  run: runCommand,
  materialize: async (environment) => [
    ...(await materializeDnsSecrets(environment)),
    ...(await materializeBackupAuthKeyring(environment)),
  ],
  readManifestClaim: readManifestClaim,
  recordOwnership: recordOwnershipAfterProviderEvidence,
  providerGuard: defaultProviderGuard,
  deployProviderBoundChangeSet: (claim, assemblyDirectory, environment) =>
    deployProviderBoundChangeSet(claim, assemblyDirectory, environment),
  withDeployTransaction: withAdvisoryDeployTransaction,
};

export function loadCdkDeployEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  root: string = ROOT
): string | undefined {
  return loadEnvironmentPreservingCdkTarget(environment, () => {
    if (environment.CI === "true") return undefined;
    const selectedEnvironmentFile = [".env.production", ".env.local"]
      .map((name) => path.join(root, name))
      .find(existsSync);
    dotenv.config({
      ...(selectedEnvironmentFile ? { path: selectedEnvironmentFile } : {}),
      override: true,
      quiet: true,
      processEnv: environment as Record<string, string>,
    });
    return selectedEnvironmentFile;
  });
}

export function loadEnvironmentPreservingCdkTarget<T>(environment: NodeJS.ProcessEnv, loadEnvironment: () => T): T {
  const explicitTarget = new Map<string, string>();
  for (const name of CDK_TARGET_VARIABLES) {
    const value = environment[name];
    if (value) explicitTarget.set(name, value);
  }

  const result = loadEnvironment();

  for (const [name, value] of explicitTarget) environment[name] = value;
  return result;
}

export function resolveDeployTarget(environment: NodeJS.ProcessEnv): DeployTarget {
  const account = environment.CDK_DEFAULT_ACCOUNT?.trim();
  const region = environment.CDK_DEFAULT_REGION?.trim();
  const stackName = environment.STACK_NAME?.trim() || "MinecraftStack";
  if (!account || !/^\d{12}$/.test(account)) {
    throw new Error("CDK_DEFAULT_ACCOUNT must identify the exact 12-digit deployment account.");
  }
  if (!region || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) {
    throw new Error("CDK_DEFAULT_REGION must identify the exact deployment region.");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) {
    throw new Error("STACK_NAME is invalid.");
  }
  return { account, region, stackName };
}

export function validateManifestClaim(claim: ManifestDeploymentClaim): void {
  if (!/^\d{12}$/.test(claim.account) || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(claim.region)) {
    throw new Error("Deployment manifest claim has an invalid account or region.");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(claim.stackName) || !CLAIM_TOKEN_PATTERN.test(claim.claimToken)) {
    throw new Error("Deployment manifest claim has an invalid stack name or claim token.");
  }
  if (claim.stackId !== "") {
    const match = STACK_ID_PATTERN.exec(claim.stackId);
    if (!match || match[1] !== claim.region || match[2] !== claim.account || match[3] !== claim.stackName) {
      throw new Error("Deployment manifest claim has an invalid exact StackId.");
    }
  }
}

export function assertLiveProviderEvidence(claim: ManifestDeploymentClaim, evidence: LiveProviderEvidence): void {
  validateManifestClaim(claim);
  if (
    evidence.account !== claim.account ||
    evidence.region !== claim.region ||
    evidence.stackName !== claim.stackName
  ) {
    throw new Error("Live AWS account, region, and stack name do not exactly match the manifest claim.");
  }
  if (!evidence.exists) {
    if (claim.stackId !== "") throw new Error("The manifest claims an existing stack, but the live stack is absent.");
    return;
  }
  if (claim.stackId === "") throw new Error("The deployment target changed from an absent stack before deployment.");
  if (evidence.stackId !== claim.stackId)
    throw new Error("AWS provider StackId does not exactly match the manifest claim.");
  if (evidence.claimToken !== claim.claimToken) {
    throw new Error("AWS provider McAwsClaimToken does not exactly match the manifest claim.");
  }
}

export function validateCdkDeployArguments(arguments_: string[]): void {
  let requireApprovalCount = 0;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--require-approval") {
      if (arguments_[++index] !== "never")
        throw new Error("Only --require-approval never is permitted for cdk:deploy.");
      requireApprovalCount += 1;
      continue;
    }
    if (["--app", "-a", "--output", "-o", "--plugin", "-p", "--context", "-c"].includes(argument)) {
      throw new Error(`${argument} is not permitted; cdk:deploy owns the canonical CDK assembly.`);
    }
    throw new Error(`Unsupported cdk:deploy argument ${argument}; only --require-approval never is permitted.`);
  }
  if (requireApprovalCount > 1) throw new Error("--require-approval may be specified only once.");
}

function readManifestClaim(environment: NodeJS.ProcessEnv): ManifestDeploymentClaim {
  try {
    const output = execFileSync(
      "node",
      [path.join(ROOT, "scripts/shared/deployment-manifest.mjs"), "deployment-target"],
      {
        cwd: ROOT,
        env: { ...environment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
    const claim = JSON.parse(output) as Partial<ManifestDeploymentClaim>;
    if (
      typeof claim.account !== "string" ||
      typeof claim.region !== "string" ||
      typeof claim.stackName !== "string" ||
      typeof claim.claimToken !== "string" ||
      typeof claim.stackId !== "string" ||
      !/^\d{12}$/.test(claim.account) ||
      !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(claim.region) ||
      !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(claim.stackName) ||
      !CLAIM_TOKEN_PATTERN.test(claim.claimToken)
    ) {
      throw new Error("malformed deployment claim");
    }
    const validated = claim as ManifestDeploymentClaim;
    validateManifestClaim(validated);
    return validated;
  } catch {
    throw new Error("Deployment manifest does not contain one exact secure AWS deployment claim.");
  }
}

function readAssemblyJson(assemblyDirectory: string, file: string): Record<string, unknown> {
  if (file !== path.basename(file) || file.includes("..")) {
    throw new Error(`Canonical CDK assembly file name ${file} is invalid.`);
  }
  const filePath = path.join(assemblyDirectory, file);
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error(`Canonical CDK assembly file ${file} is not one regular file.`);
    }
    return JSON.parse(readFileSync(descriptor, "utf8")) as Record<string, unknown>;
  } finally {
    closeSync(descriptor);
  }
}

function readAssemblyFile(assemblyDirectory: string, file: string): Buffer {
  if (path.isAbsolute(file) || file.split(path.sep).includes("..")) {
    throw new Error(`Canonical CDK assembly file name ${file} is invalid.`);
  }
  const filePath = path.join(assemblyDirectory, file);
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1) throw new Error(`Canonical CDK assembly file ${file} is not regular.`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assemblyDigest(assemblyDirectory: string): string {
  const root = path.resolve(assemblyDirectory);
  const digest = createHash("sha256");
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeDirectory, name);
      const status = lstatSync(absolute);
      if (status.isSymbolicLink() || status.isDirectory()) {
        if (status.isSymbolicLink()) throw new Error(`Canonical CDK assembly contains a symlink: ${relative}`);
        visit(absolute, relative);
        continue;
      }
      if (!status.isFile() || status.nlink !== 1)
        throw new Error(`Canonical CDK assembly entry is not regular: ${relative}`);
      const bytes = readAssemblyFile(assemblyDirectory, path.relative(root, absolute));
      digest.update(relative);
      digest.update("\0");
      digest.update(String(bytes.byteLength));
      digest.update("\0");
      digest.update(bytes);
      digest.update("\0");
    }
  };
  const rootStatus = lstatSync(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
    throw new Error("Canonical CDK assembly directory is unsafe.");
  visit(root, "");
  return digest.digest("hex");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: assembly identity and dependency validation is intentionally centralized and fail-closed.
function inspectCanonicalAssembly(claim: ManifestDeploymentClaim, assemblyDirectory: string): string {
  const assemblyManifest = readAssemblyJson(assemblyDirectory, "manifest.json");
  const assetManifest = readAssemblyJson(assemblyDirectory, `${claim.stackName}.assets.json`);
  const rawArtifacts = assemblyManifest.artifacts;
  if (!rawArtifacts || typeof rawArtifacts !== "object" || Array.isArray(rawArtifacts)) {
    throw new Error("Canonical CDK assembly artifacts are malformed.");
  }
  const artifacts = rawArtifacts as Record<string, unknown>;
  const expectedArtifacts = [`${claim.stackName}.assets`, claim.stackName].sort();
  if (Object.keys(artifacts).sort().join("\0") !== expectedArtifacts.join("\0")) {
    throw new Error("Cloud assembly contains unexpected or decoy artifacts.");
  }
  const stackArtifact = artifacts[claim.stackName];
  const assetArtifact = artifacts[`${claim.stackName}.assets`];
  const stackProperties =
    stackArtifact && typeof stackArtifact === "object" && !Array.isArray(stackArtifact)
      ? (stackArtifact as Record<string, unknown>).properties
      : undefined;
  const assetProperties =
    assetArtifact && typeof assetArtifact === "object" && !Array.isArray(assetArtifact)
      ? (assetArtifact as Record<string, unknown>).properties
      : undefined;
  if (
    !stackProperties ||
    typeof stackProperties !== "object" ||
    Array.isArray(stackProperties) ||
    (stackProperties as Record<string, unknown>).templateFile !== `${claim.stackName}.template.json` ||
    JSON.stringify(
      stackArtifact && typeof stackArtifact === "object" && !Array.isArray(stackArtifact)
        ? ((stackArtifact as Record<string, unknown>).dependencies ?? [])
        : []
    ) !== JSON.stringify([`${claim.stackName}.assets`]) ||
    !assetProperties ||
    typeof assetProperties !== "object" ||
    Array.isArray(assetProperties) ||
    (assetProperties as Record<string, unknown>).file !== `${claim.stackName}.assets.json` ||
    JSON.stringify(
      assetArtifact && typeof assetArtifact === "object" && !Array.isArray(assetArtifact)
        ? ((assetArtifact as Record<string, unknown>).dependencies ?? [])
        : []
    ) !== "[]"
  ) {
    throw new Error("Canonical CDK assembly templateFile or dependencies are not exact.");
  }
  assertSynthesizedAssemblyIdentity(
    { accountId: claim.account, region: claim.region, stackId: claim.stackId, stackName: claim.stackName },
    { manifest: assemblyManifest, assetManifest }
  );
  const templateFile =
    stackProperties && typeof stackProperties === "object" && !Array.isArray(stackProperties)
      ? (stackProperties as Record<string, unknown>).templateFile
      : undefined;
  if (templateFile !== `${claim.stackName}.template.json`) {
    throw new Error("Canonical CDK assembly templateFile is not the exact stack template.");
  }
  const template = readAssemblyJson(assemblyDirectory, templateFile);
  assertAssemblyClaim(template, claim.claimToken);
  return assemblyDigest(assemblyDirectory);
}

function assertAssemblyUnchanged(assemblyDirectory: string, expectedDigest: string): void {
  if (assemblyDigest(assemblyDirectory) !== expectedDigest) {
    throw new Error("Canonical CDK assembly or assets changed after verification; refusing deployment.");
  }
}

function assertAssemblyClaim(template: Record<string, unknown>, claimToken: string): void {
  const resources = template.Resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error("Canonical CDK template has no exact CloudFormation resource map.");
  }
  const ownershipClaims = Object.entries(resources as Record<string, unknown>).filter(([, resource]) => {
    return (
      resource &&
      typeof resource === "object" &&
      !Array.isArray(resource) &&
      (resource as Record<string, unknown>).Type === "Custom::StackOwnershipClaim"
    );
  });
  if (ownershipClaims.length !== 1) {
    throw new Error("Canonical CDK template must contain exactly one Custom::StackOwnershipClaim resource.");
  }
  const [, ownershipClaim] = ownershipClaims[0];
  const properties =
    ownershipClaim && typeof ownershipClaim === "object" && !Array.isArray(ownershipClaim)
      ? (ownershipClaim as Record<string, unknown>).Properties
      : undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Canonical StackOwnershipClaim properties are missing.");
  }
  const propertyKeys = Object.keys(properties).sort().join("\0");
  if (propertyKeys !== "ClaimParameter\0ClaimToken\0ServiceToken\0StackOwnershipClaim") {
    throw new Error("Canonical StackOwnershipClaim properties are not exact.");
  }
  const claimProperties = properties as Record<string, unknown>;
  if (
    claimProperties.StackOwnershipClaim !== "true" ||
    claimProperties.ClaimParameter !== "/minecraft/stack-ownership-claim" ||
    claimProperties.ClaimToken !== claimToken ||
    claimProperties.ServiceToken === undefined
  ) {
    throw new Error("Canonical StackOwnershipClaim does not bind the exact ownership claim.");
  }

  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ((value as Record<string, unknown>).Key === "McAwsClaimToken")
      values.push((value as Record<string, unknown>).Value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "McAwsClaimToken" || key === "ClaimToken") values.push(child);
      visit(child);
    }
  };
  visit(template);
  if (!values.some((value) => value === claimToken) || values.some((value) => value !== claimToken)) {
    throw new Error("Canonical CDK assembly does not carry the exact manifest ownership claim token.");
  }
}

function synthesizeCanonicalAssembly(
  claim: ManifestDeploymentClaim,
  environment: NodeJS.ProcessEnv,
  run: DeployDependencies["run"]
): string {
  const parent = environment.TMPDIR || path.join(ROOT, ".local-artifacts/cdk-tmp");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const assemblyDirectory = mkdtempSync(path.join(parent, "mc-aws-canonical-"));
  chmodSync(assemblyDirectory, 0o700);
  const synthEnvironment = {
    ...environment,
    AWS_DEFAULT_REGION: claim.region,
    CDK_DEFAULT_ACCOUNT: claim.account,
    CDK_DEFAULT_REGION: claim.region,
    MC_AWS_SETUP_CLAIM_TOKEN: claim.claimToken,
  };
  const status = run("pnpm", ["exec", "cdk", "synth", claim.stackName, "--quiet", "--output", assemblyDirectory], {
    cwd: path.join(ROOT, "infra"),
    env: synthEnvironment,
  });
  if (status !== 0) {
    rmSync(assemblyDirectory, { recursive: true, force: true });
    throw new Error("Canonical CDK synthesis failed.");
  }
  inspectCanonicalAssembly(claim, assemblyDirectory);
  return assemblyDirectory;
}

function awsJson(region: string, args: string[], environment: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const output = execFileSync("aws", ["--region", region, ...args, "--output", "json"], {
      cwd: ROOT,
      env: { ...environment, AWS_PAGER: "" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error("AWS provider evidence could not be read; deployment ownership was not recorded.");
  }
}

function defaultProviderGuard(
  claim: ManifestDeploymentClaim,
  environment: NodeJS.ProcessEnv,
  _phase: ProviderGuardPhase
): void {
  const caller = awsJson(claim.region, ["sts", "get-caller-identity"], environment);
  if (caller.Account !== claim.account) throw new Error("AWS provider account does not match the manifest claim.");
  let response: Record<string, unknown>;
  try {
    response = JSON.parse(
      execFileSync(
        "aws",
        [
          "--region",
          claim.region,
          "cloudformation",
          "describe-stacks",
          "--stack-name",
          claim.stackName,
          "--output",
          "json",
        ],
        { cwd: ROOT, env: { ...environment, AWS_PAGER: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    ) as Record<string, unknown>;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (claim.stackId === "" && /does not exist|ValidationError/i.test(stderr)) return;
    throw new Error("AWS provider stack identity evidence could not be read.");
  }
  const stacks = response.Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1) {
    throw new Error("AWS provider did not return exactly one stack for the exact deployment name.");
  }
  const stack = stacks[0] as Record<string, unknown>;
  const stackId = typeof stack.StackId === "string" ? stack.StackId : "";
  const match = STACK_ID_PATTERN.exec(stackId);
  if (
    stack.StackName !== claim.stackName ||
    !match ||
    match[1] !== claim.region ||
    match[2] !== claim.account ||
    match[3] !== claim.stackName
  ) {
    throw new Error("AWS provider returned an unexpected exact StackId or stack name.");
  }
  const tags = Array.isArray(stack.Tags) ? (stack.Tags as Array<Record<string, unknown>>) : [];
  const claimTags = tags.filter((tag) => tag.Key === "McAwsClaimToken");
  assertLiveProviderEvidence(claim, {
    account: claim.account,
    region: claim.region,
    stackName: claim.stackName,
    stackId,
    claimToken: claimTags.length === 1 && typeof claimTags[0].Value === "string" ? claimTags[0].Value : undefined,
    exists: true,
  });
}

async function withAdvisoryDeployTransaction<T>(callback: () => Promise<T>): Promise<T> {
  const directory = path.join(ROOT, ".local-artifacts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, "cdk-deploy.transaction.lock");
  const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
  const status = fstatSync(descriptor);
  if (!status.isFile() || status.nlink !== 1 || (status.mode & 0o777) !== 0o600) {
    closeSync(descriptor);
    throw new Error("CDK deploy transaction lock is not one secure regular file.");
  }
  closeSync(descriptor);
  const child = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      lockPath,
      process.execPath,
      "-e",
      "const p=Number(process.env.MC_AWS_DEPLOY_TRANSACTION_PARENT);const t=setInterval(()=>{try{process.kill(p,0)}catch{process.exit(1)}},25);t.unref();process.stdout.write('ready\\n');process.stdin.resume()",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, MC_AWS_DEPLOY_TRANSACTION_PARENT: String(process.pid) },
      stdio: ["pipe", "pipe", "inherit"],
    }
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("ready\n")) reject(new Error(`CDK deploy transaction lock failed (${String(code)}).`));
    });
  });
  try {
    return await callback();
  } finally {
    child.stdin?.end();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function recordOwnershipAfterProviderEvidence(claim: ManifestDeploymentClaim, environment: NodeJS.ProcessEnv): void {
  const caller = awsJson(claim.region, ["sts", "get-caller-identity"], environment);
  if (caller.Account !== claim.account)
    throw new Error("AWS provider account evidence does not match the manifest claim.");
  const response = awsJson(
    claim.region,
    ["cloudformation", "describe-stacks", "--stack-name", claim.stackName],
    environment
  );
  const stacks = response.Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1)
    throw new Error("AWS provider did not return exactly one deployed stack.");
  const stack = stacks[0] as Record<string, unknown>;
  const stackId = typeof stack.StackId === "string" ? stack.StackId : "";
  const expectedStackId = new RegExp(
    `^arn:aws(?:-[a-z]+)?:cloudformation:${claim.region}:${claim.account}:stack/${claim.stackName}/[A-Za-z0-9-]+$`
  );
  if (!expectedStackId.test(stackId))
    throw new Error("AWS provider returned a stack identity outside the manifest claim.");
  const tags = (Array.isArray(stack.Tags) ? stack.Tags : []) as Array<Record<string, unknown>>;
  const claimTags = tags.filter((tag) => tag?.Key === "McAwsClaimToken");
  if (claimTags.length !== 1 || claimTags[0].Value !== claim.claimToken) {
    throw new Error("AWS provider did not prove the exact manifest ownership claim token.");
  }
  const outputs = (Array.isArray(stack.Outputs) ? stack.Outputs : []) as Array<Record<string, unknown>>;
  const output = (key: string): string => {
    const matches = outputs.filter((item) => item?.OutputKey === key && typeof item?.OutputValue === "string");
    if (matches.length !== 1 || !(matches[0].OutputValue as string).trim()) {
      throw new Error(`AWS provider output ${key} is ambiguous.`);
    }
    return (matches[0].OutputValue as string).trim();
  };
  const instanceId = output("InstanceId");
  const runtimeUser = output("WorkerRuntimeIamUserName");
  if (!/^i-[a-f0-9]{8,17}$/.test(instanceId) || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(runtimeUser)) {
    throw new Error("AWS provider ownership outputs are malformed.");
  }
  const manifestEnvironment = { ...environment, MC_AWS_DEPLOYMENT_MANIFEST: environment.MC_AWS_DEPLOYMENT_MANIFEST };
  try {
    execFileSync(
      "node",
      [
        path.join(ROOT, "scripts/shared/deployment-manifest.mjs"),
        "aws-deployed",
        "--stack-id",
        stackId,
        "--instance-id",
        instanceId,
        "--runtime-user",
        runtimeUser,
        "--claim-token",
        claim.claimToken,
        "--claim-observed",
        "true",
      ],
      { cwd: ROOT, env: manifestEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch {
    throw new Error("Provider evidence was not durably recorded in the deployment manifest.");
  }
}

export async function orchestrateCdkDeploy(
  cdkArguments: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: DeployDependencies = defaultDependencies
): Promise<void> {
  validateCdkDeployArguments(cdkArguments);
  const manifestClaim = dependencies.readManifestClaim?.(environment) ?? readManifestClaim(environment);
  const target = resolveDeployTarget(environment);
  if (
    target.account !== manifestClaim.account ||
    target.region !== manifestClaim.region ||
    target.stackName !== manifestClaim.stackName
  ) {
    throw new Error("CDK target does not exactly match the secure deployment manifest claim.");
  }
  const cdkTemporaryDirectory = path.join(ROOT, ".local-artifacts/cdk-tmp");
  const childEnvironment = {
    ...environment,
    AWS_DEFAULT_REGION: target.region,
    CDK_DEFAULT_ACCOUNT: target.account,
    CDK_DEFAULT_REGION: target.region,
    TMPDIR: cdkTemporaryDirectory,
    MC_AWS_SETUP_CLAIM_TOKEN: manifestClaim.claimToken,
    MC_AWS_FRESH_STACK: manifestClaim.stackId === "" ? "true" : "false",
    MC_AWS_SETUP_LOCK_FILE: path.join(cdkTemporaryDirectory, "mc-aws-setup.lock"),
  };

  const transaction = dependencies.withDeployTransaction ?? (async <T>(callback: () => Promise<T>) => callback());
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: deployment ordering is intentionally one fail-closed transaction.
  await transaction(async () => {
    let assemblyDirectory: string | undefined;
    try {
      if (dependencies.providerGuard) dependencies.providerGuard(manifestClaim, childEnvironment, "before-synth");
      assemblyDirectory = (dependencies.synthesize ?? synthesizeCanonicalAssembly)(
        manifestClaim,
        childEnvironment,
        dependencies.run
      );
      const assemblyDigest = inspectCanonicalAssembly(manifestClaim, assemblyDirectory);

      const guardStatus = dependencies.run(
        "pnpm",
        [
          "exec",
          "tsx",
          "scripts/aws/migrate-existing-deployment.ts",
          "--assert-standard-deploy-safe",
          "--account",
          target.account,
          "--region",
          target.region,
          "--stack-name",
          target.stackName,
          "--assembly-directory",
          assemblyDirectory,
        ],
        { cwd: ROOT, env: childEnvironment }
      );
      if (guardStatus !== 0)
        throw new Error(
          "Deployment safety guard refused the target; DNS credentials were not changed and backup authentication was not provisioned."
        );

      const deployProviderBoundChangeSet = dependencies.deployProviderBoundChangeSet;
      if (!deployProviderBoundChangeSet) {
        throw new Error(
          "Refusing name-bound CDK deployment: no provider-bound immutable change-set executor is configured."
        );
      }

      let names: string[];
      try {
        names = await dependencies.materialize(childEnvironment);
      } catch {
        throw new Error("SecureString materialization failed; credential values were omitted.");
      }
      for (const name of names) console.log(`Materialized SecureString ${name}; value omitted`);

      if (dependencies.providerGuard) dependencies.providerGuard(manifestClaim, childEnvironment, "before-deploy");
      assertAssemblyUnchanged(assemblyDirectory, assemblyDigest);
      const deployEnvironment: NodeJS.ProcessEnv = { ...childEnvironment, CLOUDFLARE_API_TOKEN: undefined };
      const deployStatus = await deployProviderBoundChangeSet(manifestClaim, assemblyDirectory, deployEnvironment);
      if (deployStatus !== 0) throw new Error("CDK deployment failed.");
      (dependencies.recordOwnership ?? recordOwnershipAfterProviderEvidence)(manifestClaim, deployEnvironment);
    } finally {
      if (assemblyDirectory) rmSync(assemblyDirectory, { recursive: true, force: true });
    }
  });
}

async function main(): Promise<void> {
  try {
    loadCdkDeployEnvironment();
    await orchestrateCdkDeploy(process.argv.slice(2), process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
