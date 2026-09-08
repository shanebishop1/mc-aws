import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { parsePublicAgentProviderCatalog } from "../../lib/agent/control-plane/provider-catalog";
import { deriveBackupFencePublicKeyPem } from "../../lib/agent/runtime/backup-fence-key";
import { parseExecutorReceiptVerifierSetJson } from "../../lib/agent/runtime/executor-receipt";
import { AUTH_SECRET_REQUIREMENTS, validateProductionAuthSecret } from "../../lib/auth-secret";
import { workerSecretAllowlist, workerVariableAllowlist } from "../../lib/runtime-config-schema";
import { readWranglerConfig } from "./wrangler-config";

const publicBuildVariableAllowlist = new Set(["MC_BACKEND_MODE", "NEXT_PUBLIC_APP_URL"]);

const sensitiveKeyPattern =
  /(?:AUTH_SECRET|API_KEY|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY|CLIENT_SECRET|CREDENTIAL|ACCESS_KEY|SECRET)/i;

// These values are runtime-only even when their names do not look like
// credentials. Keep them out of build input and include them in the artifact
// scan so a compiler cannot accidentally embed them in deployable output.
const runtimeOnlyKeyNames = new Set([
  "AUTH_SECRET",
  "MC_AGENT_RUNTIME_TOKEN",
  "MC_AGENT_RUNTIME_TOKEN_SHA256",
  "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
]);

export const deployOnlyIgnoredSecretNames = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CDK_DEFAULT_ACCOUNT",
  "CDK_DEFAULT_REGION",
  "AL2023_ARM64_AMI_ID",
  "MC_BOOTSTRAP_PINS_SHA256",
  "MC_LIFECYCLE_LOCK_TABLE_NAME",
  "MC_OPERATION_STATE_TABLE_NAME",
  "SES_NOTIFICATIONS_ENABLED",
  "SES_INBOUND_COMMANDS_ENABLED",
  "VERIFIED_SENDER",
  "NOTIFICATION_EMAIL",
  "SES_INBOUND_RECIPIENT",
  "SES_RECEIPT_RULE_SET_NAME",
  "START_KEYWORD",
  "MC_ALARM_EMAIL",
  "MC_SCHEDULED_BACKUP_ENABLED",
  "MC_SCHEDULED_BACKUP_SCHEDULE",
  "MC_BACKUP_STALE_AFTER_HOURS",
  "GITHUB_USER",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "KEY_PAIR_NAME",
  "RUNTIME_STATE_SNAPSHOT_KV_ID",
  "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID",
  "MC_CONNECTION_MODE",
  "PANEL_HOSTING_MODE",
  "PANEL_DNS_MANAGEMENT",
  "PANEL_WORKERS_DEV_ENABLED",
  "CLOUDFLARE_WORKERS_SUBDOMAIN",
  "CLOUDFLARE_PANEL_ZONE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_DEPLOY_API_TOKEN",
  "CLOUDFLARE_PANEL_DNS_API_TOKEN",
]);

export const deployOnlyWorkerVarNames = new Set(["MC_LIFECYCLE_LOCK_TABLE_NAME", "MC_OPERATION_STATE_TABLE_NAME"]);

export interface WorkerSecretUploadEntry {
  key: string;
  value: string;
}

export const effectiveDotenvKey = (line: string): string | null => {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)/);
  return match?.[1] ?? null;
};

export const sanitizeDeploymentBuildEnv = (source: string): string => {
  const retainedLines = source.split(/\r?\n/).filter((line) => {
    const key = effectiveDotenvKey(line);
    return !key || publicBuildVariableAllowlist.has(key);
  });

  return ["AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=", "AWS_SESSION_TOKEN=", ...retainedLines].join("\n");
};

const suspiciousArtifactFileName =
  /(?:^|[._-])(?:\.env(?:[._-]|$)|mock[-_.]?state|mock[-_.]?(?:credentials?|secrets?)|credentials?|oauth(?:[-_.]?(?:client|token|secret|credentials?))?|secure[-_.]?strings?|private[-_.]?keys?)(?:[._-]|$)/i;

const structuralSecretPatterns: readonly RegExp[] = [
  // JSON/JavaScript object properties with a non-empty literal secret-like
  // value. Requiring a literal value avoids flagging ordinary runtime code
  // that merely names an environment variable.
  /(?:^|[^A-Za-z0-9_-])["'`]?(?:auth[_-]?secret|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passphrase|credential(?:s)?|secret|token|authorization|refresh[_-]?token|access[_-]?token|id[_-]?token)["'`]?\s*[:=]\s*["'`](?!(?:same-origin|required|include|omit)["'`]|Bearer\s|\$\{)[^"'`\r\n]+["'`]/i,
  // A persisted mock SSM entry is sensitive even when its parameter name is
  // unfamiliar. Match the structure and a non-empty value, not the word
  // SecureString in source code by itself.
  /["'`]?type["'`]?[\s]*:[\s]*["'`]SecureString["'`][\s\S]{0,512}?["'`]?value["'`]?[\s]*:[\s]*["'`](?!["'`\s])[^"'`\r\n]+["'`]/i,
  // OAuth envelopes are frequently emitted with snake_case keys.
  /(?:^|[^A-Za-z0-9_-])["'`]?(?:client_secret|access_token|refresh_token|id_token)["'`]?\s*[:=]\s*["'`](?!["'`\s]|\$\{)[^"'`\r\n]+["'`]/i,
];

const isCompiledCodeArtifact = (filePath: string): boolean => /\.(?:js|mjs|cjs|map)$/i.test(filePath);

const scanFileForNeedles = (filePath: string, needles: readonly Buffer[]): string | undefined => {
  if (!isCompiledCodeArtifact(filePath) && suspiciousArtifactFileName.test(path.basename(filePath))) return filePath;
  const contents = fs.readFileSync(filePath);
  for (const needle of needles) {
    if (needle.length > 0 && contents.includes(needle)) return filePath;
  }
  // Compiled JavaScript contains ordinary protocol fields such as
  // `Authorization`, `token`, and `credentials` with dynamic/template values.
  // Structural checks are for persisted data envelopes; exact forbidden-value
  // checks above still cover literals in every deployable file type.
  if (isCompiledCodeArtifact(filePath) || !/\.(?:json|bin|snapshot|txt|env)$/i.test(filePath)) return undefined;
  const text = contents.toString("utf8");
  if (structuralSecretPatterns.some((pattern) => pattern.test(text))) return filePath;
  return undefined;
};

const collectArtifactFiles = (
  artifactPath: string,
  artifactRoot = artifactPath,
  visited = new Set<string>()
): string[] => {
  const stat = fs.lstatSync(artifactPath);
  if (stat.isSymbolicLink()) {
    const resolvedTarget = fs.realpathSync(artifactPath);
    const resolvedRoot = fs.realpathSync(artifactRoot);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Refusing to scan an artifact symlink outside its root: ${artifactPath}`);
    }
    return collectArtifactFiles(resolvedTarget, resolvedRoot, visited);
  }
  if (stat.isFile()) return [artifactPath];
  if (!stat.isDirectory()) throw new Error(`Refusing unsupported deploy artifact: ${artifactPath}`);
  const resolvedPath = fs.realpathSync(artifactPath);
  if (visited.has(resolvedPath)) return [];
  visited.add(resolvedPath);

  const files: string[] = [];
  for (const entry of fs.readdirSync(artifactPath, { withFileTypes: true })) {
    if (path.basename(artifactPath) === ".next" && entry.name === "cache") continue;
    const child = path.join(artifactPath, entry.name);
    files.push(...collectArtifactFiles(child, artifactRoot, visited));
  }
  return files;
};

export const scanDeploymentArtifacts = (
  artifactPaths: readonly string[],
  forbiddenValues: readonly string[] = []
): void => {
  const needles = [...new Set(forbiddenValues.filter((value) => value.length > 0))].map((value) => Buffer.from(value));
  if (artifactPaths.length === 0) throw new Error("At least one deploy artifact is required for scanning.");

  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath)) throw new Error(`Deploy artifact is missing: ${artifactPath}`);
    for (const filePath of collectArtifactFiles(artifactPath)) {
      if (scanFileForNeedles(filePath, needles)) {
        throw new Error(`Deploy artifact scan found forbidden secret material in ${filePath}.`);
      }
    }
  }
};

const merkleNode = (kind: "blob" | "tree", parts: readonly Buffer[]): Buffer => {
  const hash = createHash("sha256");
  hash.update(`${kind}\0`);
  for (const part of parts) {
    hash.update(String(part.byteLength));
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest();
};

const artifactMerkleNode = (artifactPath: string): Buffer => {
  const stat = fs.lstatSync(artifactPath);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Refusing unsafe Worker upload input: ${artifactPath}`);
  }
  if (stat.isFile()) return merkleNode("blob", [fs.readFileSync(artifactPath)]);
  const entries = fs
    .readdirSync(artifactPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const children = entries.map((entry) => {
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsafe";
    if (type === "unsafe")
      throw new Error(`Refusing unsafe Worker upload input: ${path.join(artifactPath, entry.name)}`);
    return Buffer.concat([
      Buffer.from(`${type}\0${entry.name}\0`, "utf8"),
      artifactMerkleNode(path.join(artifactPath, entry.name)),
    ]);
  });
  return merkleNode("tree", children);
};

/** Content-address the exact code/assets passed to Wrangler, independent of checkout location. */
export const deploymentArtifactMerkleSha256 = (artifactPaths: readonly string[]): string => {
  if (artifactPaths.length === 0) throw new Error("At least one Worker upload input is required.");
  const roots = artifactPaths.map((artifactPath) => {
    if (!fs.existsSync(artifactPath)) throw new Error(`Worker upload input is missing: ${artifactPath}`);
    const label = path.basename(path.resolve(artifactPath));
    return Buffer.concat([Buffer.from(`${label}\0`, "utf8"), artifactMerkleNode(path.resolve(artifactPath))]);
  });
  return merkleNode("tree", roots).toString("hex");
};

const copyImmutableFile = (source: string, destination: string): void => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing unsafe Worker upload input: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
};

const copyImmutableTree = (source: string, destination: string): void => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Refusing unsafe Worker upload input: ${source}`);
  }
  if (stat.isFile()) {
    copyImmutableFile(source, destination);
    return;
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs
    .readdirSync(source, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    copyImmutableTree(path.join(source, entry.name), path.join(destination, entry.name));
  }
};

const copyFinalBundleTree = (source: string, destination: string): void => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Refusing unsafe finalized Worker bundle input: ${source}`);
  }
  if (stat.isFile()) {
    copyImmutableFile(source, destination);
    return;
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs
    .readdirSync(source, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "README.md" || entry.name === "bundle-meta.json") continue;
    copyFinalBundleTree(path.join(source, entry.name), path.join(destination, entry.name));
  }
};

/** Snapshot static assets before local Wrangler bundling can read mutable checkout paths. */
export const stageWorkerAssets = (sourceDirectory: string, outputDirectory: string): string => {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(output)) throw new Error(`Refusing to replace existing Worker asset stage: ${output}`);
  copyImmutableTree(source, output);
  return output;
};

/**
 * Stage the output of Wrangler's local bundle step. The source module graph is
 * intentionally never copied or guessed here: aliases, directory indexes,
 * package exports, and package dependencies must already have been resolved by
 * Wrangler. Deployment later uses --no-bundle against this exact tree.
 */
export const stageFinalWorkerUpload = (
  configPath: string,
  bundledWorkerPath: string,
  stagedAssetsDirectory: string,
  outputDirectory: string
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: finalized bundle validation intentionally fails closed across file, syntax, and import-graph boundaries.
): string => {
  const config = readWranglerConfig(configPath);
  const output = path.resolve(outputDirectory);
  if (fs.existsSync(output)) throw new Error(`Refusing to replace existing Worker upload stage: ${output}`);
  const bundleInput = path.resolve(bundledWorkerPath);
  const stagedAssets = path.resolve(stagedAssetsDirectory);
  if (!fs.existsSync(bundleInput)) throw new Error(`Final Wrangler bundle is missing: ${bundleInput}`);
  if (!fs.existsSync(stagedAssets)) throw new Error(`Final Worker assets stage is missing: ${stagedAssets}`);
  const artifact = path.join(output, "artifact");
  fs.mkdirSync(artifact, { recursive: true, mode: 0o700 });
  const bundleStat = fs.lstatSync(bundleInput);
  const bundledWorker = bundleStat.isDirectory()
    ? ["worker.js", "worker.mjs", "index.js", "index.mjs"]
        .map((candidate) => path.join(bundleInput, candidate))
        .find((candidate) => fs.existsSync(candidate))
    : bundleInput;
  if (!bundledWorker) throw new Error(`Final Wrangler bundle has no executable Worker entry: ${bundleInput}`);
  const entryName = path.basename(bundledWorker);
  if (bundleStat.isDirectory()) copyFinalBundleTree(bundleInput, artifact);
  else copyImmutableFile(bundledWorker, path.join(artifact, entryName));
  copyImmutableTree(stagedAssets, path.join(artifact, "assets"));
  const entryPath = path.join(artifact, entryName);
  const entrySource = fs.readFileSync(entryPath, "utf8");
  if (/multipart\/form-data|formdata-undici|^--[-\w]/im.test(entrySource)) {
    throw new Error("Final Wrangler output is multipart upload data, not an executable Worker module.");
  }
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
      input: entrySource,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Final Wrangler output is not a syntactically valid Worker module.");
  }
  const importPattern = /\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s*)?["']([^"'`]+)["']/g;
  for (const match of entrySource.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier.startsWith("cloudflare:") || specifier.startsWith("node:")) continue;
    if (!specifier.startsWith(".")) {
      throw new Error(`Final Wrangler Worker module has an unresolved bare import: ${specifier}`);
    }
    const resolved = path.resolve(path.dirname(entryPath), specifier);
    const candidates = [
      resolved,
      `${resolved}.js`,
      `${resolved}.mjs`,
      path.join(resolved, "index.js"),
      path.join(resolved, "index.mjs"),
    ];
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(`Final Wrangler Worker module import is missing from the staged artifact: ${specifier}`);
    }
  }
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of entrySource.matchAll(dynamicImportPattern)) {
    const specifier = match[1];
    if (specifier.startsWith("cloudflare:") || specifier.startsWith("node:")) continue;
    if (!specifier.startsWith(".")) {
      throw new Error(`Final Wrangler Worker module has an unresolved bare dynamic import: ${specifier}`);
    }
    const resolved = path.resolve(path.dirname(entryPath), specifier);
    const candidates = [
      resolved,
      `${resolved}.js`,
      `${resolved}.mjs`,
      path.join(resolved, "index.js"),
      path.join(resolved, "index.mjs"),
    ];
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(`Final Wrangler Worker dynamic import is missing from the staged artifact: ${specifier}`);
    }
  }
  const assets =
    config.assets && typeof config.assets === "object" && !Array.isArray(config.assets) ? config.assets : {};

  const stagedConfig = {
    ...config,
    main: `artifact/${entryName}`,
    assets: {
      ...assets,
      directory: "artifact/assets",
    },
  };
  fs.writeFileSync(path.join(output, "wrangler.jsonc"), `${JSON.stringify(stagedConfig, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(output, 0o700);
  return output;
};

/** The former source copier is intentionally unavailable; unbundled graph guesses are unsafe. */
export const stageWorkerUpload = (): never => {
  throw new Error("Refusing incomplete Worker source staging; Wrangler must produce a finalized prebundled upload.");
};

const selfReferentialUploadConfigFields = new Set(["MC_AWS_DEPLOYMENT_RECEIPT_SHA256", "MC_AWS_UPLOAD_CONFIG_SHA256"]);

const canonicalConfigValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalConfigValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !selfReferentialUploadConfigFields.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalConfigValue(child)])
  );
};

/** Hash the effective Wrangler config, excluding only explicitly self-referential receipt fields. */
export const deploymentUploadConfigSha256 = (configPath: string): string => {
  const canonical = JSON.stringify(canonicalConfigValue(readWranglerConfig(configPath)));
  return createHash("sha256")
    .update("mc-aws/cloudflare-effective-wrangler-config/v1\0")
    .update(canonical)
    .digest("hex");
};

/** Seal a completed stage so a later checkout mutation cannot alter upload bytes. */
export const sealWorkerUploadStage = (stageDirectory: string): void => {
  const root = path.resolve(stageDirectory);
  const files = collectArtifactFiles(root).sort((left, right) => right.length - left.length);
  for (const file of files) fs.chmodSync(file, 0o400);
  const directories: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name));
        directories.push(path.join(directory, entry.name));
      }
    }
  };
  visit(root);
  for (const directory of [...directories, root]) fs.chmodSync(directory, 0o500);
};

const parseWranglerJson = (raw: string): Record<string, unknown> => {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("Wrangler output did not contain JSON.");
  const value = JSON.parse(raw.slice(start)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wrangler JSON is malformed.");
  return value as Record<string, unknown>;
};

export interface ActiveWorkerVersionEvidence {
  deploymentId: string;
  versionId: string;
  scriptEtag: string;
}

export interface WorkerDeploymentReceiptTuple extends ActiveWorkerVersionEvidence {
  artifactMerkleSha256: string;
  receiptVerifierSetSha256: string;
  uploadConfigSha256: string;
}

const deploymentReceiptDomain = "mc-aws/cloudflare-deployment-receipt/v1";

const receiptField = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`;

/** Canonical, domain-separated receipt over only immutable provider and artifact identities. */
export const deploymentReceiptSha256 = (tuple: WorkerDeploymentReceiptTuple): string => {
  const fields = [
    tuple.deploymentId,
    tuple.versionId,
    tuple.scriptEtag,
    tuple.artifactMerkleSha256,
    tuple.receiptVerifierSetSha256,
    tuple.uploadConfigSha256,
  ];
  if (fields.some((value) => typeof value !== "string" || !value || /[\0\r\n]/.test(value))) {
    throw new Error("Worker deployment receipt tuple contains malformed identity data.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(tuple.artifactMerkleSha256) ||
    !/^[a-f0-9]{64}$/.test(tuple.receiptVerifierSetSha256) ||
    !/^[a-f0-9]{64}$/.test(tuple.uploadConfigSha256)
  ) {
    throw new Error("Worker deployment receipt digests are malformed.");
  }
  return createHash("sha256")
    .update([deploymentReceiptDomain, ...fields].map(receiptField).join("|"), "utf8")
    .digest("hex");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasExactPlainTextBinding = (bindings: unknown[], name: string, expected: string): boolean =>
  bindings.some(
    (binding) =>
      isRecord(binding) && binding.name === name && binding.type === "plain_text" && binding.text === expected
  );

const activeVersionId = (deployment: Record<string, unknown>): string => {
  const versions = Array.isArray(deployment.versions) ? deployment.versions : [];
  const active = versions.filter(
    (value): value is Record<string, unknown> => isRecord(value) && value.percentage === 100
  );
  if (active.length !== 1 || typeof active[0].version_id !== "string" || !active[0].version_id) {
    throw new Error("Deployment does not identify one exact 100% active Worker version.");
  }
  return active[0].version_id;
};

type WorkerVersionSplit = { versionId: string; percentage: number };
export type WorkerRollbackDecision = "already-baseline" | "restore-baseline";

const canonicalVersionSplit = (versions: readonly WorkerVersionSplit[]): string =>
  JSON.stringify(
    [...versions]
      .map(({ versionId, percentage }) => {
        if (typeof versionId !== "string" || !versionId || !Number.isFinite(percentage) || percentage < 0) {
          throw new Error("Worker rollback version split is malformed.");
        }
        return { versionId, percentage };
      })
      .sort((left, right) => left.versionId.localeCompare(right.versionId))
  );

/**
 * Decide whether rollback may replace the active Worker. The only mutating
 * decision requires the provider's active deployment to still be this
 * transaction's exact applied deployment B. A concurrent C is never replaced.
 */
export const workerRollbackDecision = (
  currentDeploymentsRaw: string,
  baselineVersions: readonly WorkerVersionSplit[],
  appliedDeploymentId: string | null
): WorkerRollbackDecision => {
  const current = parseWranglerJson(currentDeploymentsRaw);
  if (typeof current.id !== "string" || !current.id) throw new Error("Current Worker deployment ID is missing.");
  const currentVersions = Array.isArray(current.versions)
    ? current.versions.map((version) => {
        if (!isRecord(version)) throw new Error("Current Worker version split is malformed.");
        return { versionId: String(version.version_id ?? ""), percentage: Number(version.percentage) };
      })
    : [];
  const baseline = canonicalVersionSplit(baselineVersions);
  if (canonicalVersionSplit(currentVersions) === baseline) return "already-baseline";
  if (!appliedDeploymentId) {
    throw new Error("Worker rollback has no transaction-applied deployment B; refusing to replace active state.");
  }
  if (current.id !== appliedDeploymentId) {
    throw new Error("Active Worker deployment is concurrent state C; refusing to overwrite it with baseline A.");
  }
  return "restore-baseline";
};

const workerScriptEvidence = (
  version: Record<string, unknown>,
  expectedVersionId: string
): { scriptEtag: string; bindings: unknown[] } => {
  if (version.id !== expectedVersionId) throw new Error("Viewed Worker version is not the exact active version.");
  if (!isRecord(version.resources)) throw new Error("Active Worker version resources are missing.");
  if (!isRecord(version.resources.script)) throw new Error("Active Worker script identity is missing.");
  const scriptEtag = version.resources.script.etag;
  if (typeof scriptEtag !== "string" || !scriptEtag || /[\t\r\n]/.test(scriptEtag)) {
    throw new Error("Active Worker script ETag is malformed.");
  }
  return {
    scriptEtag,
    bindings: Array.isArray(version.resources.bindings) ? version.resources.bindings : [],
  };
};

/** Bind local digests to the provider-observed exact active version and script content identity. */
export const verifyActiveWorkerVersionEvidence = (
  deploymentsRaw: string,
  versionRaw: string,
  artifactMerkleSha256: string,
  receiptVerifierSetSha256: string,
  uploadConfigSha256: string
): ActiveWorkerVersionEvidence => {
  if (
    !/^[a-f0-9]{64}$/.test(artifactMerkleSha256) ||
    !/^[a-f0-9]{64}$/.test(receiptVerifierSetSha256) ||
    !/^[a-f0-9]{64}$/.test(uploadConfigSha256)
  ) {
    throw new Error("Expected Worker attestation digests are malformed.");
  }
  const deployment = parseWranglerJson(deploymentsRaw);
  if (typeof deployment.id !== "string" || !deployment.id) throw new Error("Active deployment ID is missing.");
  const versionId = activeVersionId(deployment);
  const version = parseWranglerJson(versionRaw);
  const { scriptEtag, bindings } = workerScriptEvidence(version, versionId);
  if (!hasExactPlainTextBinding(bindings, "MC_AWS_ARTIFACT_MERKLE_SHA256", artifactMerkleSha256)) {
    throw new Error("Active Worker artifact Merkle binding does not match the upload inputs.");
  }
  if (!hasExactPlainTextBinding(bindings, "MC_AWS_RECEIPT_VERIFIER_SET_SHA256", receiptVerifierSetSha256)) {
    throw new Error("Active Worker receipt verifier binding does not match the pinned authority.");
  }
  if (!hasExactPlainTextBinding(bindings, "MC_AWS_UPLOAD_CONFIG_SHA256", uploadConfigSha256)) {
    throw new Error("Active Worker upload config binding does not match the staged upload config.");
  }
  return { deploymentId: deployment.id, versionId, scriptEtag };
};

export interface ExactActiveWorkerReceiptEvidence extends WorkerDeploymentReceiptTuple {
  deploymentReceiptSha256: string;
}

/**
 * Verify status -> exact version -> second status as one reusable publication
 * boundary. Both provider status observations must identify the same sole
 * 100%-active deployment/version and the exact version content bindings.
 */
export const verifyExactActiveWorkerReceipt = (
  firstDeploymentsRaw: string,
  firstVersionRaw: string,
  finalDeploymentsRaw: string,
  finalVersionRaw: string,
  artifactMerkleSha256: string,
  receiptVerifierSetSha256: string,
  uploadConfigSha256: string,
  expectedReceiptSha256?: string
): ExactActiveWorkerReceiptEvidence => {
  const first = verifyActiveWorkerVersionEvidence(
    firstDeploymentsRaw,
    firstVersionRaw,
    artifactMerkleSha256,
    receiptVerifierSetSha256,
    uploadConfigSha256
  );
  const final = verifyActiveWorkerVersionEvidence(
    finalDeploymentsRaw,
    finalVersionRaw,
    artifactMerkleSha256,
    receiptVerifierSetSha256,
    uploadConfigSha256
  );
  if (
    first.deploymentId !== final.deploymentId ||
    first.versionId !== final.versionId ||
    first.scriptEtag !== final.scriptEtag
  ) {
    throw new Error("Active Worker deployment/version changed between publication observations.");
  }
  const tuple = { ...final, artifactMerkleSha256, receiptVerifierSetSha256, uploadConfigSha256 };
  const receipt = deploymentReceiptSha256(tuple);
  if (expectedReceiptSha256 !== undefined && receipt !== expectedReceiptSha256) {
    throw new Error("Active Worker deployment receipt does not match the stored tuple.");
  }
  return { ...tuple, deploymentReceiptSha256: receipt };
};

const forbiddenValuesFromDotenv = (source: string): string[] => {
  const parsed = dotenv.parse(source);
  return Object.entries(parsed)
    .filter(([key, value]) => (sensitiveKeyPattern.test(key) || runtimeOnlyKeyNames.has(key)) && value.length > 0)
    .map(([, value]) => value);
};

export const workerSecretNames = (source: string): string[] => {
  return buildWorkerSecretUploadEntries(source).map(({ key }) => key);
};

export const workerSecretValue = (source: string, key: string): string => {
  const entry = buildWorkerSecretUploadEntries(source).find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Refusing to read unapproved or unset Worker secret key: ${key}`);
  return entry.value;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: DNS aliases and complete Agent runtime secret validation intentionally share one upload allowlist boundary.
export const buildWorkerSecretUploadEntries = (source: string): WorkerSecretUploadEntry[] => {
  const parsed: Record<string, string> = dotenv.parse(source);
  const canonicalDnsToken = parsed.CLOUDFLARE_DNS_API_TOKEN?.trim();
  const deprecatedFileDnsToken = parsed.CLOUDFLARE_API_TOKEN?.trim();
  if (!canonicalDnsToken && deprecatedFileDnsToken) {
    parsed.CLOUDFLARE_DNS_API_TOKEN = deprecatedFileDnsToken;
  }

  const allowed = new Set<string>(workerSecretAllowlist);
  for (const key of workerVariableAllowlist) allowed.add(key);
  const rejected = Object.keys(parsed).filter((key) => !allowed.has(key) && !deployOnlyIgnoredSecretNames.has(key));
  if (rejected.length > 0) {
    throw new Error(`Refusing to upload unapproved Worker secret key(s): ${rejected.join(", ")}`);
  }

  const runtimeEnabled = parsed.MC_AGENT_RUNTIME_ENABLED?.trim().toLowerCase();
  if (runtimeEnabled !== "true" && runtimeEnabled !== "false") {
    throw new Error('MC_AGENT_RUNTIME_ENABLED must be explicitly set to "true" or "false" for every Worker deploy.');
  }

  if (parsed.MC_BACKEND_MODE !== undefined && parsed.MC_BACKEND_MODE !== "aws") {
    throw new Error('MC_BACKEND_MODE must be the canonical Worker value "aws".');
  }

  if (!validateProductionAuthSecret(parsed.AUTH_SECRET).valid) {
    throw new Error(`Refusing Worker deploy: ${AUTH_SECRET_REQUIREMENTS}`);
  }

  const publicProviderCatalog = parsed.MC_AGENT_PUBLIC_PROVIDER_CATALOG;
  const runtimeProviderProfiles = parsed.MC_AGENT_RUNTIME_PROVIDER_PROFILES;
  if (runtimeEnabled === "true") {
    const requiredRuntimeNames = [
      "MC_AGENT_RUNTIME_ID",
      "MC_AGENT_RUNTIME_TOKEN_SHA256",
      "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
      "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS",
      "MC_AGENT_PUBLIC_PROVIDER_CATALOG",
      "MC_AGENT_RUNTIME_PROVIDER_PROFILES",
    ];
    const missingRuntimeNames = requiredRuntimeNames.filter((name) => !parsed[name]?.trim());
    if (missingRuntimeNames.length > 0) {
      throw new Error(
        `MC_AGENT_RUNTIME_ENABLED=true requires complete Worker runtime configuration. Missing: ${missingRuntimeNames.join(", ")}.`
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed.MC_AGENT_RUNTIME_ID.trim())) {
      throw new Error("Refusing to upload invalid MC_AGENT_RUNTIME_ID.");
    }
    if (!/^[a-f0-9]{64}$/.test(parsed.MC_AGENT_RUNTIME_TOKEN_SHA256.trim())) {
      throw new Error("Refusing to upload invalid MC_AGENT_RUNTIME_TOKEN_SHA256.");
    }
    try {
      deriveBackupFencePublicKeyPem(parsed.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8);
    } catch {
      throw new Error("Refusing to upload invalid MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8.");
    }
    try {
      parseExecutorReceiptVerifierSetJson(parsed.MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS);
    } catch {
      throw new Error("Refusing to upload invalid MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS.");
    }
    try {
      parsePublicAgentProviderCatalog(publicProviderCatalog, runtimeProviderProfiles);
    } catch {
      throw new Error("Refusing to upload invalid public Agent provider metadata.");
    }
  }

  return workerSecretAllowlist.flatMap((key) => {
    if (deployOnlyWorkerVarNames.has(key)) return [];
    const value = parsed[key];
    return value ? [{ key, value }] : [];
  });
};

const getArg = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
};

type CliHandler = (args: string[], source: string) => void;

const runArtifactScan = (args: string[], source: string): void => {
  const artifactPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--path") continue;
    const artifactPath = args[index + 1];
    if (!artifactPath) throw new Error("Missing value for --path");
    artifactPaths.push(path.resolve(artifactPath));
    index += 1;
  }
  if (artifactPaths.length === 0) throw new Error("At least one --path is required");
  scanDeploymentArtifacts(artifactPaths, forbiddenValuesFromDotenv(source));
};

const runCliHandlers: Record<string, CliHandler> = {
  "sanitize-build-env": (args, source) => {
    fs.writeFileSync(getArg(args, "--output"), sanitizeDeploymentBuildEnv(source), { mode: 0o600 });
  },
  "worker-secret-names": (_args, source) => {
    for (const key of workerSecretNames(source)) process.stdout.write(`${key}\n`);
  },
  // Retain the old command name as a safe, names-only compatibility alias.
  "worker-secret-entries": (_args, source) => {
    for (const key of workerSecretNames(source)) process.stdout.write(`${key}\n`);
  },
  "worker-secret-value": (args, source) => {
    process.stdout.write(workerSecretValue(source, getArg(args, "--name")));
  },
  "executor-receipt-sha256": (_args, source) => {
    const verifierSet = parseExecutorReceiptVerifierSetJson(
      workerSecretValue(source, "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS")
    );
    process.stdout.write(createHash("sha256").update(JSON.stringify(verifierSet)).digest("hex"));
  },
  "scan-artifacts": runArtifactScan,
};

const artifactPathsFromArgs = (args: string[]): string[] => {
  const artifactPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--path") continue;
    const artifactPath = args[index + 1];
    if (!artifactPath) throw new Error("Missing value for --path");
    artifactPaths.push(path.resolve(artifactPath));
    index += 1;
  }
  if (artifactPaths.length === 0) throw new Error("At least one --path is required");
  return artifactPaths;
};

const runStandaloneCliHandlers: Record<string, (args: string[]) => void> = {
  "stage-worker-upload": () => stageWorkerUpload(),
  "stage-worker-assets": (args) => stageWorkerAssets(getArg(args, "--source"), getArg(args, "--output")),
  "stage-final-worker-upload": (args) =>
    stageFinalWorkerUpload(
      getArg(args, "--config"),
      getArg(args, "--bundle"),
      getArg(args, "--assets"),
      getArg(args, "--output")
    ),
  "seal-worker-upload": (args) => sealWorkerUploadStage(getArg(args, "--stage")),
  "artifact-merkle-sha256": (args) => process.stdout.write(deploymentArtifactMerkleSha256(artifactPathsFromArgs(args))),
  "upload-config-sha256": (args) => process.stdout.write(deploymentUploadConfigSha256(getArg(args, "--config"))),
  "worker-rollback-decision": (args) => {
    const applied = getArg(args, "--applied-deployment-id");
    const baseline = JSON.parse(getArg(args, "--baseline-versions-json")) as WorkerVersionSplit[];
    process.stdout.write(
      workerRollbackDecision(fs.readFileSync(0, "utf8"), baseline, applied === "null" ? null : applied)
    );
  },
  "worker-version-evidence": (args) => {
    const input = fs.readFileSync(0);
    const separator = input.indexOf(0);
    if (separator < 0) throw new Error("Worker version evidence input is malformed.");
    const evidence = verifyActiveWorkerVersionEvidence(
      input.subarray(0, separator).toString("utf8"),
      input.subarray(separator + 1).toString("utf8"),
      getArg(args, "--artifact-merkle-sha256"),
      getArg(args, "--receipt-verifier-set-sha256"),
      getArg(args, "--upload-config-sha256")
    );
    process.stdout.write(`${evidence.deploymentId}\t${evidence.versionId}\t${evidence.scriptEtag}`);
  },
  "worker-receipt-evidence": (args) => {
    const input = fs.readFileSync(0, "utf8").split("\0");
    if (input.length !== 4 || input.some((part) => !part))
      throw new Error("Worker receipt evidence input is malformed.");
    const evidence = verifyExactActiveWorkerReceipt(
      input[0],
      input[1],
      input[2],
      input[3],
      getArg(args, "--artifact-merkle-sha256"),
      getArg(args, "--receipt-verifier-set-sha256"),
      getArg(args, "--upload-config-sha256"),
      args.includes("--expected-receipt-sha256") ? getArg(args, "--expected-receipt-sha256") : undefined
    );
    process.stdout.write(
      `${evidence.deploymentId}\t${evidence.versionId}\t${evidence.scriptEtag}\t${evidence.deploymentReceiptSha256}`
    );
  },
  "deployment-receipt-sha256": (args) => {
    process.stdout.write(
      deploymentReceiptSha256({
        deploymentId: getArg(args, "--deployment-id"),
        versionId: getArg(args, "--version-id"),
        scriptEtag: getArg(args, "--script-etag"),
        artifactMerkleSha256: getArg(args, "--artifact-merkle-sha256"),
        receiptVerifierSetSha256: getArg(args, "--receipt-verifier-set-sha256"),
        uploadConfigSha256: getArg(args, "--upload-config-sha256"),
      })
    );
  },
};

const runCli = (): void => {
  const [command, ...args] = process.argv.slice(2);
  const standaloneHandler = runStandaloneCliHandlers[command ?? ""];
  if (standaloneHandler) {
    standaloneHandler(args);
    return;
  }
  const handler = runCliHandlers[command ?? ""];
  if (!handler) throw new Error(`Unknown deploy-env command: ${String(command)}`);
  const source = args.includes("--env-fd")
    ? fs.readFileSync(`/proc/self/fd/${getArg(args, "--env-fd")}`, "utf8")
    : fs.readFileSync(getArg(args, "--env-file"), "utf8");
  handler(args, source);
};

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
