#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = resolve(process.env.MC_AWS_DEPLOYMENT_MANIFEST || ".mc-aws-deployment.json");
const manifestLockPath = `${manifestPath}.lock`;
const LOCK_FD_ENV = "MC_AWS_DEPLOYMENT_MANIFEST_LOCK_FD";
const LEGACY_LOCK_MARKER_ENV = "MC_AWS_DEPLOYMENT_MANIFEST_LOCK_HELD";
const LOCK_PARENT_PID_ENV = "MC_AWS_DEPLOYMENT_MANIFEST_LOCK_PARENT_PID";
const LOCK_PARENT_START_ENV = "MC_AWS_DEPLOYMENT_MANIFEST_LOCK_PARENT_START";
const LOCK_OWNER_PID_ENV = "MC_AWS_DEPLOYMENT_MANIFEST_LOCK_OWNER_PID";
const LOCK_OWNER_START_ENV = "MC_AWS_DEPLOYMENT_MANIFEST_LOCK_OWNER_START";
const ownershipValues = new Set(["created", "preexisting", "unproven"]);
const completedResourceValues = new Set([
  "cloudflare-routes",
  "cloudflare-worker",
  "cloudflare-kv",
  "cloudflare-dns",
  "aws-dlm",
  "runtime-iam-keys",
  "final-data-preservation",
  "cloudformation-stack",
  // Legacy manifests may contain this pre-exact-StackId stage name.
  "cdk-stack",
  "runtime-iam-user",
]);
const destroyLifecyclePhases = [
  "intent",
  "barrier-active",
  "runtime-quiesced",
  "preserving",
  "preserved",
  "ingress-disabled",
  "credentials-revoked",
  "stack-deleting",
  "complete",
  "aborted",
];
const destroyLifecyclePhaseValues = new Set(destroyLifecyclePhases);

function fail(message) {
  console.error(`Deployment manifest error: ${message}`);
  process.exit(1);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
}

function assertKeys(value, allowed, path) {
  assertObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not a recognized manifest field`);
  }
}

function assertString(value, pattern, path, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || !pattern.test(value)) fail(`${path} is malformed`);
}

function assertBoolean(value, path, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "boolean") fail(`${path} must be boolean`);
}

const deploymentReceiptDomain = "mc-aws/cloudflare-deployment-receipt/v1";
const receiptField = (value) => `${Buffer.byteLength(value, "utf8")}:${value}`;
function canonicalDeploymentReceipt({
  deploymentId,
  versionId,
  scriptEtag,
  artifactMerkleSha256,
  receiptVerifierSetSha256,
  uploadConfigSha256,
}) {
  return createHash("sha256")
    .update(
      [
        deploymentReceiptDomain,
        deploymentId,
        versionId,
        scriptEtag,
        artifactMerkleSha256,
        receiptVerifierSetSha256,
        uploadConfigSha256,
      ]
        .map(receiptField)
        .join("|")
    )
    .digest("hex");
}

function assertUniqueIdentities(values, identity, path) {
  const identities = new Set();
  for (const [index, value] of values.entries()) {
    const key = identity(value);
    if (typeof key !== "string" || !key) fail(`${path}[${index}] has no canonical identity`);
    if (identities.has(key)) fail(`${path}[${index}] duplicates identity ${key}`);
    identities.add(key);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the manifest boundary deliberately validates every key identity and rotation invariant together.
function validateExecutorReceiptVerifierSet(value, path) {
  assertKeys(value, ["schemaVersion", "currentKeyId", "verifiers"], path);
  if (value.schemaVersion !== 1) fail(`${path}.schemaVersion is unsupported`);
  assertString(value.currentKeyId, /^executor-receipt-[a-f0-9]{64}$/, `${path}.currentKeyId`);
  if (!Array.isArray(value.verifiers) || value.verifiers.length < 1 || value.verifiers.length > 3) {
    fail(`${path}.verifiers must contain between one and three keys`);
  }
  const keyIds = new Set();
  for (const [index, verifier] of value.verifiers.entries()) {
    const verifierPath = `${path}.verifiers[${index}]`;
    assertKeys(verifier, ["schemaVersion", "keyId", "publicKeySpki", "keyEpoch", "rotationCutoffAt"], verifierPath);
    if (verifier.schemaVersion !== 1) fail(`${verifierPath}.schemaVersion is unsupported`);
    assertString(verifier.keyId, /^executor-receipt-[a-f0-9]{64}$/, `${verifierPath}.keyId`);
    assertString(verifier.publicKeySpki, /^[A-Za-z0-9+/]{59}=$/, `${verifierPath}.publicKeySpki`);
    if (verifier.keyEpoch !== undefined && (!Number.isSafeInteger(verifier.keyEpoch) || verifier.keyEpoch < 1)) {
      fail(`${verifierPath}.keyEpoch is invalid`);
    }
    if (verifier.rotationCutoffAt !== undefined) {
      assertString(
        verifier.rotationCutoffAt,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
        `${verifierPath}.rotationCutoffAt`
      );
    }
    const spki = Buffer.from(verifier.publicKeySpki, "base64");
    if (spki.length !== 44 || spki.toString("base64") !== verifier.publicKeySpki) {
      fail(`${verifierPath}.publicKeySpki is not canonical Ed25519 SPKI material`);
    }
    const derivedKeyId = `executor-receipt-${createHash("sha256").update(spki).digest("hex")}`;
    if (verifier.keyId !== derivedKeyId || keyIds.has(verifier.keyId)) {
      fail(`${verifierPath} key identity is invalid or duplicated`);
    }
    keyIds.add(verifier.keyId);
  }
  if (!keyIds.has(value.currentKeyId) || value.verifiers[0].keyId !== value.currentKeyId) {
    fail(`${path}.currentKeyId must identify the first verifier`);
  }
  const current = value.verifiers[0];
  const epochs = new Set();
  for (const verifier of value.verifiers) {
    const epoch = verifier.keyEpoch ?? 1;
    if (epochs.has(epoch)) fail(`${path}.verifiers key epochs must be unique`);
    epochs.add(epoch);
  }
  for (const verifier of value.verifiers.slice(1)) {
    if (verifier.keyEpoch !== undefined && current.keyEpoch !== undefined && verifier.keyEpoch >= current.keyEpoch) {
      fail(`${path}.retained key epoch must precede the current key epoch`);
    }
    if (!verifier.rotationCutoffAt) fail(`${path}.retained verifiers require an explicit rotation cutoff`);
  }
  if (current.rotationCutoffAt !== undefined) fail(`${path}.current verifier cannot have a rotation cutoff`);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one centralized strict schema validator intentionally checks every nested ownership field.
function validateManifest(manifest) {
  assertKeys(
    manifest,
    ["schemaVersion", "revision", "project", "aws", "cloudflare", "executorReceipt", "teardown", "updatedAt"],
    "manifest"
  );
  if (manifest.schemaVersion !== 1 || manifest.project !== "mc-aws") fail("unsupported manifest identity");
  if (manifest.revision !== undefined && (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1)) {
    fail("manifest.revision must be a positive safe integer");
  }
  assertString(manifest.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, "manifest.updatedAt", {
    optional: true,
  });

  assertKeys(
    manifest.aws,
    ["accountId", "region", "stack", "instanceId", "runtimeIam", "dlmPolicies", "ssmParameters"],
    "manifest.aws"
  );
  assertString(manifest.aws.accountId, /^\d{12}$/, "manifest.aws.accountId", { optional: true });
  assertString(manifest.aws.region, /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/, "manifest.aws.region", { optional: true });
  if (manifest.aws.stack !== undefined) {
    assertKeys(
      manifest.aws.stack,
      ["name", "id", "createdByProject", "observedBeforeSetup", "claimToken"],
      "manifest.aws.stack"
    );
    assertString(manifest.aws.stack.name, /^[A-Za-z][A-Za-z0-9-]{0,127}$/, "manifest.aws.stack.name");
    assertString(
      manifest.aws.stack.id,
      /^(?:|unknown|arn:aws(?:-[a-z]+)?:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[A-Za-z0-9-]+)$/,
      "manifest.aws.stack.id"
    );
    assertBoolean(manifest.aws.stack.createdByProject, "manifest.aws.stack.createdByProject");
    assertString(manifest.aws.stack.claimToken, /^[a-f0-9-]{36}$/, "manifest.aws.stack.claimToken", { optional: true });
    if (!["absent", "existing", "unknown"].includes(manifest.aws.stack.observedBeforeSetup)) {
      fail("manifest.aws.stack.observedBeforeSetup is invalid");
    }
  }
  assertString(manifest.aws.instanceId, /^i-[a-f0-9]{8,17}$/, "manifest.aws.instanceId", { optional: true });
  if (manifest.aws.runtimeIam !== undefined) {
    assertKeys(
      manifest.aws.runtimeIam,
      ["userName", "createdByProject", "stackOwned", "expectedTags"],
      "manifest.aws.runtimeIam"
    );
    assertString(manifest.aws.runtimeIam.userName, /^[A-Za-z0-9+=,.@_-]{1,64}$/, "manifest.aws.runtimeIam.userName");
    assertBoolean(manifest.aws.runtimeIam.createdByProject, "manifest.aws.runtimeIam.createdByProject");
    if (manifest.aws.runtimeIam.stackOwned !== true) fail("manifest.aws.runtimeIam.stackOwned must be true");
    assertKeys(
      manifest.aws.runtimeIam.expectedTags,
      ["McAwsProject", "McAwsPurpose", "McAwsStack"],
      "manifest.aws.runtimeIam.expectedTags"
    );
    if (
      manifest.aws.runtimeIam.expectedTags.McAwsProject !== "mc-aws" ||
      manifest.aws.runtimeIam.expectedTags.McAwsPurpose !== "CloudflareWorkerRuntime" ||
      manifest.aws.runtimeIam.expectedTags.McAwsStack !== manifest.aws.stack?.name
    ) {
      fail("manifest.aws.runtimeIam.expectedTags are invalid");
    }
  }
  if (!Array.isArray(manifest.aws.dlmPolicies)) fail("manifest.aws.dlmPolicies must be an array");
  assertUniqueIdentities(manifest.aws.dlmPolicies, (policy) => policy?.id, "manifest.aws.dlmPolicies");
  for (const [index, policy] of manifest.aws.dlmPolicies.entries()) {
    const path = `manifest.aws.dlmPolicies[${index}]`;
    assertKeys(policy, ["id", "createdByProject", "ownership", "expectedTags"], path);
    assertString(policy.id, /^policy-[a-f0-9]{8,64}$/, `${path}.id`);
    assertBoolean(policy.createdByProject, `${path}.createdByProject`);
    if (!ownershipValues.has(policy.ownership) || (policy.createdByProject && policy.ownership !== "created")) {
      fail(`${path}.ownership is invalid`);
    }
    assertKeys(policy.expectedTags, ["McAwsProject", "McAwsStack"], `${path}.expectedTags`);
    if (policy.expectedTags.McAwsProject !== "mc-aws" || policy.expectedTags.McAwsStack !== manifest.aws.stack?.name) {
      fail(`${path}.expectedTags are invalid`);
    }
  }
  if (!Array.isArray(manifest.aws.ssmParameters)) fail("manifest.aws.ssmParameters must be an array");
  const ssmNames = new Set();
  for (const [index, parameter] of manifest.aws.ssmParameters.entries()) {
    const path = `manifest.aws.ssmParameters[${index}]`;
    assertKeys(
      parameter,
      [
        "name",
        "type",
        "createdByProject",
        "ownership",
        "observedBeforeSetup",
        "source",
        "stackLogicalId",
        "claimToken",
        "resourceVersion",
      ],
      path
    );
    assertString(parameter.name, /^\/minecraft\/[A-Za-z0-9._/-]+(?:\/\*)?$/, `${path}.name`);
    if (ssmNames.has(parameter.name)) fail(`${path}.name is duplicated`);
    ssmNames.add(parameter.name);
    if (!["String", "StringList", "SecureString", "unknown"].includes(parameter.type)) fail(`${path}.type is invalid`);
    assertBoolean(parameter.createdByProject, `${path}.createdByProject`);
    if (
      !ownershipValues.has(parameter.ownership) ||
      parameter.createdByProject !== (parameter.ownership === "created")
    ) {
      fail(`${path}.ownership is invalid`);
    }
    if (!["absent", "existing", "unknown"].includes(parameter.observedBeforeSetup)) {
      fail(`${path}.observedBeforeSetup is invalid`);
    }
    if (!["setup-preflight", "exact-stack-resource", "historical-audit", "manual-consent"].includes(parameter.source)) {
      fail(`${path}.source is invalid`);
    }
    assertString(parameter.stackLogicalId, /^(?:[A-Za-z][A-Za-z0-9]{0,254})$/, `${path}.stackLogicalId`, {
      optional: true,
    });
    assertString(parameter.claimToken, /^[a-f0-9-]{36}$/, `${path}.claimToken`, { optional: true });
    if (
      parameter.resourceVersion !== undefined &&
      (!Number.isSafeInteger(parameter.resourceVersion) || parameter.resourceVersion < 1)
    ) {
      fail(`${path}.resourceVersion is invalid`);
    }
    if (parameter.source === "exact-stack-resource" && !parameter.stackLogicalId) {
      fail(`${path}.stackLogicalId is required for exact stack-resource evidence`);
    }
  }

  assertKeys(
    manifest.cloudflare,
    ["accountId", "worker", "panelHosting", "routes", "kvNamespaces", "panelDnsRecords"],
    "manifest.cloudflare"
  );
  assertString(manifest.cloudflare.accountId, /^[a-f0-9]{32}$/i, "manifest.cloudflare.accountId", { optional: true });
  if (manifest.cloudflare.worker !== undefined) {
    assertKeys(
      manifest.cloudflare.worker,
      [
        "name",
        "createdByProject",
        "observedBeforeDeploy",
        "deploymentId",
        "versionId",
        "scriptEtag",
        "artifactMerkleSha256",
        "receiptVerifierSetSha256",
        "deploymentReceiptSha256",
        "uploadConfigSha256",
      ],
      "manifest.cloudflare.worker"
    );
    assertString(manifest.cloudflare.worker.name, /^[a-z0-9][a-z0-9-]{0,62}$/, "manifest.cloudflare.worker.name");
    assertBoolean(manifest.cloudflare.worker.createdByProject, "manifest.cloudflare.worker.createdByProject");
    if (!["absent", "existing"].includes(manifest.cloudflare.worker.observedBeforeDeploy)) {
      fail("manifest.cloudflare.worker.observedBeforeDeploy is invalid");
    }
    assertString(
      manifest.cloudflare.worker.deploymentId,
      /^[a-f0-9]{8}(?:[a-f0-9-]{0,56}[a-f0-9])?$/i,
      "manifest.cloudflare.worker.deploymentId",
      { optional: true }
    );
    assertString(
      manifest.cloudflare.worker.versionId,
      /^[a-f0-9]{8}(?:[a-f0-9-]{0,56}[a-f0-9])?$/i,
      "manifest.cloudflare.worker.versionId",
      { optional: true }
    );
    assertString(manifest.cloudflare.worker.scriptEtag, /^[^\t\r\n]{1,256}$/, "manifest.cloudflare.worker.scriptEtag", {
      optional: true,
    });
    assertString(
      manifest.cloudflare.worker.artifactMerkleSha256,
      /^[a-f0-9]{64}$/,
      "manifest.cloudflare.worker.artifactMerkleSha256",
      { optional: true }
    );
    assertString(
      manifest.cloudflare.worker.receiptVerifierSetSha256,
      /^[a-f0-9]{64}$/,
      "manifest.cloudflare.worker.receiptVerifierSetSha256",
      { optional: true }
    );
    assertString(
      manifest.cloudflare.worker.deploymentReceiptSha256,
      /^[a-f0-9]{64}$/,
      "manifest.cloudflare.worker.deploymentReceiptSha256",
      { optional: true }
    );
    assertString(
      manifest.cloudflare.worker.uploadConfigSha256,
      /^[a-f0-9]{64}$/,
      "manifest.cloudflare.worker.uploadConfigSha256",
      { optional: true }
    );
    const attestationFields = [
      manifest.cloudflare.worker.deploymentId,
      manifest.cloudflare.worker.versionId,
      manifest.cloudflare.worker.scriptEtag,
      manifest.cloudflare.worker.artifactMerkleSha256,
      manifest.cloudflare.worker.receiptVerifierSetSha256,
      manifest.cloudflare.worker.deploymentReceiptSha256,
      manifest.cloudflare.worker.uploadConfigSha256,
    ];
    const providerAttestationFields = attestationFields.slice(1);
    if (
      providerAttestationFields.some((value) => value !== undefined) &&
      attestationFields.some((value) => value === undefined)
    ) {
      fail("manifest.cloudflare.worker attestation fields must be recorded as one complete provider observation");
    }
    if (providerAttestationFields.every((value) => value !== undefined)) {
      const expectedReceipt = canonicalDeploymentReceipt(manifest.cloudflare.worker);
      if (manifest.cloudflare.worker.deploymentReceiptSha256 !== expectedReceipt) {
        fail("manifest.cloudflare.worker.deploymentReceiptSha256 does not match the immutable deployment tuple");
      }
    }
    if (!manifest.cloudflare.worker.createdByProject) {
      fail("pre-existing/unproven Workers must not be present in an accepted deployment manifest");
    }
  }
  if (manifest.cloudflare.panelHosting !== undefined) {
    assertKeys(manifest.cloudflare.panelHosting, ["mode", "workersDevEnabled"], "manifest.cloudflare.panelHosting");
    if (!["workers_dev", "custom"].includes(manifest.cloudflare.panelHosting.mode)) {
      fail("manifest.cloudflare.panelHosting.mode is invalid");
    }
    assertBoolean(
      manifest.cloudflare.panelHosting.workersDevEnabled,
      "manifest.cloudflare.panelHosting.workersDevEnabled"
    );
  }
  if (!Array.isArray(manifest.cloudflare.routes)) fail("manifest.cloudflare.routes must be an array");
  assertUniqueIdentities(
    manifest.cloudflare.routes,
    (route) => `${route?.zoneId}\0${route?.pattern}`,
    "manifest.cloudflare.routes"
  );
  assertUniqueIdentities(
    manifest.cloudflare.routes.filter((route) => route?.id),
    (route) => route.id,
    "manifest.cloudflare.routes.ids"
  );
  for (const [index, route] of manifest.cloudflare.routes.entries()) {
    const path = `manifest.cloudflare.routes[${index}]`;
    assertKeys(
      route,
      [
        "zoneId",
        "id",
        "pattern",
        "script",
        "operationId",
        "createdByProject",
        "ownershipProven",
        "ownership",
        "originalScript",
      ],
      path
    );
    assertString(route.zoneId, /^[a-f0-9]{32}$/i, `${path}.zoneId`);
    assertString(route.id, /^(?:|[a-f0-9]{32})$/i, `${path}.id`);
    assertString(route.pattern, /^[A-Za-z0-9.-]+\/\*$/, `${path}.pattern`);
    assertString(route.script, /^[a-z0-9][a-z0-9-]{0,62}$/, `${path}.script`);
    assertString(route.operationId, /^[a-f0-9-]{36}$/, `${path}.operationId`, { optional: true });
    assertBoolean(route.createdByProject, `${path}.createdByProject`);
    assertBoolean(route.ownershipProven, `${path}.ownershipProven`);
    if (!ownershipValues.has(route.ownership) || (route.createdByProject && route.ownership !== "created")) {
      fail(`${path}.ownership is invalid`);
    }
    if (route.createdByProject && !route.ownershipProven) fail(`${path} cannot be owned without ownership proof`);
    if ((route.createdByProject || route.ownershipProven) && !route.id) {
      fail(`${path}.id is required for a proven route ownership record`);
    }
    assertString(route.originalScript, /^(?:|[a-z0-9][a-z0-9-]{0,62})$/, `${path}.originalScript`);
  }
  if (!Array.isArray(manifest.cloudflare.kvNamespaces)) fail("manifest.cloudflare.kvNamespaces must be an array");
  assertUniqueIdentities(
    manifest.cloudflare.kvNamespaces,
    (namespace) => namespace?.id,
    "manifest.cloudflare.kvNamespaces"
  );
  assertUniqueIdentities(
    manifest.cloudflare.kvNamespaces,
    (namespace) => namespace?.binding,
    "manifest.cloudflare.kvNamespaces.bindings"
  );
  for (const [index, namespace] of manifest.cloudflare.kvNamespaces.entries()) {
    const path = `manifest.cloudflare.kvNamespaces[${index}]`;
    assertKeys(namespace, ["binding", "id", "title", "createdByProject", "ownership"], path);
    assertString(namespace.binding, /^[A-Z][A-Z0-9_]{0,63}$/, `${path}.binding`);
    assertString(namespace.id, /^[a-f0-9]{32}$/i, `${path}.id`);
    assertString(namespace.title, /^[^\t\r\n]{1,128}$/, `${path}.title`);
    assertBoolean(namespace.createdByProject, `${path}.createdByProject`);
    if (
      !ownershipValues.has(namespace.ownership) ||
      (namespace.createdByProject && namespace.ownership !== "created")
    ) {
      fail(`${path}.ownership is invalid`);
    }
  }
  if (!Array.isArray(manifest.cloudflare.panelDnsRecords)) {
    fail("manifest.cloudflare.panelDnsRecords must be an array");
  }
  assertUniqueIdentities(
    manifest.cloudflare.panelDnsRecords,
    (record) => `${record?.zoneId}\0${record?.id}`,
    "manifest.cloudflare.panelDnsRecords"
  );
  for (const [index, record] of manifest.cloudflare.panelDnsRecords.entries()) {
    const path = `manifest.cloudflare.panelDnsRecords[${index}]`;
    assertKeys(
      record,
      [
        "zoneId",
        "id",
        "name",
        "type",
        "content",
        "applied",
        "comment",
        "operationId",
        "createdByProject",
        "modifiedByProject",
        "ownership",
        "original",
      ],
      path
    );
    assertString(record.zoneId, /^[a-f0-9]{32}$/i, `${path}.zoneId`);
    assertString(record.id, /^[a-f0-9]{32}$/i, `${path}.id`);
    assertString(record.name, /^(?=.{1,253}$)[A-Za-z0-9.-]+$/, `${path}.name`);
    if (!["A", "AAAA", "CNAME"].includes(record.type)) fail(`${path}.type is invalid`);
    assertString(record.content, /^[^\t\r\n]{1,253}$/, `${path}.content`);
    assertKeys(record.applied, ["ttl", "proxied"], `${path}.applied`);
    if (!Number.isSafeInteger(record.applied.ttl) || record.applied.ttl < 1 || record.applied.ttl > 86400) {
      fail(`${path}.applied.ttl is invalid`);
    }
    assertBoolean(record.applied.proxied, `${path}.applied.proxied`);
    assertString(record.comment, /^[^\t\r\n]{0,100}$/, `${path}.comment`, { optional: true });
    assertString(record.operationId, /^[a-f0-9-]{36}$/, `${path}.operationId`, { optional: true });
    assertBoolean(record.createdByProject, `${path}.createdByProject`);
    assertBoolean(record.modifiedByProject, `${path}.modifiedByProject`);
    if (!ownershipValues.has(record.ownership) || (record.createdByProject && record.ownership !== "created")) {
      fail(`${path}.ownership is invalid`);
    }
    if (record.original !== undefined) {
      assertKeys(record.original, ["proxied", "ttl"], `${path}.original`);
      assertBoolean(record.original.proxied, `${path}.original.proxied`);
      if (!Number.isSafeInteger(record.original.ttl) || record.original.ttl < 1 || record.original.ttl > 86400) {
        fail(`${path}.original.ttl is invalid`);
      }
    } else if (!record.createdByProject) {
      fail(`${path}.original is required for pre-existing DNS records`);
    }
  }

  if (manifest.executorReceipt !== undefined) {
    validateExecutorReceiptVerifierSet(manifest.executorReceipt, "manifest.executorReceipt");
  }
  const pinnedReceiptDigest = manifest.executorReceipt
    ? createHash("sha256").update(JSON.stringify(manifest.executorReceipt)).digest("hex")
    : undefined;
  const workerReceiptDigest = manifest.cloudflare.worker?.receiptVerifierSetSha256;
  if (workerReceiptDigest !== undefined && workerReceiptDigest !== pinnedReceiptDigest) {
    fail("manifest.cloudflare.worker.receiptVerifierSetSha256 does not match the current executor verifier set");
  }

  assertKeys(
    manifest.teardown,
    [
      "completedResources",
      "finalRootSnapshot",
      "pendingFinalRootSnapshot",
      "hibernatedBackupEvidence",
      "googleDriveBackupEvidence",
      "finalGoogleDriveBackup",
      "snapshotCredentialScrub",
      "destroyLifecycle",
      "recoveryCapsule",
    ],
    "manifest.teardown"
  );
  if (!Array.isArray(manifest.teardown.completedResources))
    fail("manifest.teardown.completedResources must be an array");
  assertUniqueIdentities(
    manifest.teardown.completedResources,
    (resource) => resource,
    "manifest.teardown.completedResources"
  );
  for (const resource of manifest.teardown.completedResources) {
    if (!completedResourceValues.has(resource)) fail(`unknown completed teardown resource: ${resource}`);
  }
  if (manifest.teardown.finalRootSnapshot !== undefined) {
    const snapshot = manifest.teardown.finalRootSnapshot;
    assertKeys(
      snapshot,
      ["snapshotId", "sourceVolumeId", "stackId", "state", "createdAt"],
      "manifest.teardown.finalRootSnapshot"
    );
    assertString(snapshot.snapshotId, /^snap-[a-f0-9]{8,17}$/, "manifest.teardown.finalRootSnapshot.snapshotId");
    assertString(snapshot.sourceVolumeId, /^vol-[a-f0-9]{8,17}$/, "manifest.teardown.finalRootSnapshot.sourceVolumeId");
    if (snapshot.stackId !== manifest.aws.stack?.id) fail("final snapshot stack identity does not match");
    if (snapshot.state !== "completed") fail("final snapshot state must be completed");
    assertString(snapshot.createdAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.finalRootSnapshot.createdAt");
  }
  if (manifest.teardown.pendingFinalRootSnapshot !== undefined) {
    const snapshot = manifest.teardown.pendingFinalRootSnapshot;
    assertKeys(
      snapshot,
      ["snapshotId", "sourceVolumeId", "stackId", "state", "createdAt"],
      "manifest.teardown.pendingFinalRootSnapshot"
    );
    assertString(snapshot.snapshotId, /^snap-[a-f0-9]{8,17}$/, "manifest.teardown.pendingFinalRootSnapshot.snapshotId");
    assertString(
      snapshot.sourceVolumeId,
      /^vol-[a-f0-9]{8,17}$/,
      "manifest.teardown.pendingFinalRootSnapshot.sourceVolumeId"
    );
    if (snapshot.stackId !== manifest.aws.stack?.id) fail("pending final snapshot stack identity does not match");
    if (snapshot.state !== "pending") fail("pending final snapshot state must be pending");
    assertString(snapshot.createdAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.pendingFinalRootSnapshot.createdAt");
  }
  if (manifest.teardown.hibernatedBackupEvidence !== undefined) {
    const evidence = manifest.teardown.hibernatedBackupEvidence;
    assertKeys(
      evidence,
      [
        "operationId",
        "sourceVolumeId",
        "backupName",
        "backupId",
        "backupDigest",
        "backupSize",
        "backupGeneration",
        "backupCreatedAt",
        "serverId",
        "observedAt",
      ],
      "manifest.teardown.hibernatedBackupEvidence"
    );
    assertString(
      evidence.operationId,
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
      "manifest.teardown.hibernatedBackupEvidence.operationId"
    );
    assertString(
      evidence.sourceVolumeId,
      /^vol-[a-f0-9]{8,17}$/,
      "manifest.teardown.hibernatedBackupEvidence.sourceVolumeId"
    );
    assertString(evidence.backupName, /^[^/]+\.tar\.gz$/, "manifest.teardown.hibernatedBackupEvidence.backupName");
    assertString(evidence.backupId, /^[a-f0-9]{32}$/, "manifest.teardown.hibernatedBackupEvidence.backupId");
    assertString(evidence.backupDigest, /^[a-f0-9]{64}$/, "manifest.teardown.hibernatedBackupEvidence.backupDigest");
    if (!Number.isSafeInteger(evidence.backupSize) || evidence.backupSize < 1)
      fail("hibernated backup size is invalid");
    if (!Number.isSafeInteger(evidence.backupGeneration) || evidence.backupGeneration < 1)
      fail("hibernated backup generation is invalid");
    assertString(
      evidence.backupCreatedAt,
      /^\d{4}-\d{2}-\d{2}T/,
      "manifest.teardown.hibernatedBackupEvidence.backupCreatedAt"
    );
    assertString(
      evidence.serverId,
      /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/,
      "manifest.teardown.hibernatedBackupEvidence.serverId"
    );
    assertString(evidence.observedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.hibernatedBackupEvidence.observedAt");
  }
  if (manifest.teardown.googleDriveBackupEvidence !== undefined) {
    const evidence = manifest.teardown.googleDriveBackupEvidence;
    assertKeys(
      evidence,
      ["parameterName", "backupCount", "cacheCachedAt", "observedAt"],
      "manifest.teardown.googleDriveBackupEvidence"
    );
    if (evidence.parameterName !== "/minecraft/backups-cache") fail("invalid Google Drive backup parameter");
    if (!Number.isInteger(evidence.backupCount) || evidence.backupCount < 1)
      fail("Google Drive backup evidence is empty");
    if (!Number.isSafeInteger(evidence.cacheCachedAt) || evidence.cacheCachedAt < 1)
      fail("Google Drive backup cachedAt is invalid");
    assertString(evidence.observedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.googleDriveBackupEvidence.observedAt");
  }
  if (manifest.teardown.finalGoogleDriveBackup !== undefined) {
    const evidence = manifest.teardown.finalGoogleDriveBackup;
    assertKeys(evidence, ["backupName", "operationId", "completedAt"], "manifest.teardown.finalGoogleDriveBackup");
    assertString(
      evidence.backupName,
      /^final-destroy-[a-f0-9]{12}\.tar\.gz$/,
      "manifest.teardown.finalGoogleDriveBackup.backupName"
    );
    assertString(
      evidence.operationId,
      /^destroy-[a-f0-9-]{36}$/,
      "manifest.teardown.finalGoogleDriveBackup.operationId"
    );
    assertString(evidence.completedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.finalGoogleDriveBackup.completedAt");
  }
  if (manifest.teardown.snapshotCredentialScrub !== undefined) {
    const scrub = manifest.teardown.snapshotCredentialScrub;
    assertKeys(scrub, ["sourceVolumeId", "completedAt"], "manifest.teardown.snapshotCredentialScrub");
    assertString(
      scrub.sourceVolumeId,
      /^vol-[a-f0-9]{8,17}$/,
      "manifest.teardown.snapshotCredentialScrub.sourceVolumeId"
    );
    assertString(scrub.completedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.snapshotCredentialScrub.completedAt");
  }
  if (manifest.teardown.destroyLifecycle !== undefined) {
    const lifecycle = manifest.teardown.destroyLifecycle;
    assertKeys(
      lifecycle,
      ["operationId", "lockId", "fencingToken", "phase", "createdAt", "updatedAt", "preservationStartedAt"],
      "manifest.teardown.destroyLifecycle"
    );
    assertString(lifecycle.operationId, /^destroy-[a-f0-9-]{36}$/, "manifest.teardown.destroyLifecycle.operationId");
    assertString(lifecycle.lockId, /^[a-f0-9-]{36}$/, "manifest.teardown.destroyLifecycle.lockId");
    if (
      lifecycle.fencingToken !== undefined &&
      (!Number.isSafeInteger(lifecycle.fencingToken) || lifecycle.fencingToken < 1)
    ) {
      fail("manifest.teardown.destroyLifecycle.fencingToken is invalid");
    }
    if (!destroyLifecyclePhaseValues.has(lifecycle.phase)) fail("manifest.teardown.destroyLifecycle.phase is invalid");
    assertString(lifecycle.createdAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.destroyLifecycle.createdAt");
    assertString(lifecycle.updatedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.destroyLifecycle.updatedAt");
    assertString(
      lifecycle.preservationStartedAt,
      /^\d{4}-\d{2}-\d{2}T/,
      "manifest.teardown.destroyLifecycle.preservationStartedAt",
      { optional: true }
    );
    const phaseIndex = destroyLifecyclePhases.indexOf(lifecycle.phase);
    if (lifecycle.preservationStartedAt !== undefined && phaseIndex < destroyLifecyclePhases.indexOf("preserving")) {
      fail("manifest.teardown.destroyLifecycle preservation marker precedes preservation");
    }
    if (
      phaseIndex >= destroyLifecyclePhases.indexOf("preserving") &&
      lifecycle.phase !== "aborted" &&
      !lifecycle.preservationStartedAt
    ) {
      fail("manifest.teardown.destroyLifecycle preservation marker is required");
    }
    if (lifecycle.phase === "aborted" && lifecycle.preservationStartedAt !== undefined) {
      fail("a destroy lifecycle cannot abort after preservation starts");
    }
  }
  if (manifest.teardown.recoveryCapsule !== undefined) {
    const capsule = manifest.teardown.recoveryCapsule;
    assertKeys(
      capsule,
      [
        "schemaVersion",
        "status",
        "serverIdentityParameter",
        "generationCheckpointParameter",
        "restoreFloorParameter",
        "keyringParameter",
        "verifierAlgorithm",
        "manifestFormat",
        "manifestSchemaVersion",
        "stateFormat",
        "stateSchemaVersion",
        "keyIdSource",
        "checkpointGeneration",
        "floorGeneration",
        "capsuleDigest",
        "verifierSha256",
        "keyringSha256",
        "adoptionLockParameter",
        "preservedAt",
      ],
      "manifest.teardown.recoveryCapsule"
    );
    if (capsule.schemaVersion !== 3 || (capsule.status !== "preserved" && capsule.status !== "adopted")) {
      fail("manifest.teardown.recoveryCapsule identity is invalid");
    }
    if (
      capsule.serverIdentityParameter !== "/minecraft/backup-server-identity" ||
      capsule.generationCheckpointParameter !== "/minecraft/backup-generation-checkpoint" ||
      capsule.restoreFloorParameter !== "/minecraft/restore-generation-floor" ||
      capsule.keyringParameter !== "/minecraft/backup-auth-keyring" ||
      capsule.verifierAlgorithm !== "HMAC-SHA256" ||
      capsule.manifestFormat !== "mc-aws-drive-backup" ||
      capsule.manifestSchemaVersion !== 3 ||
      capsule.stateFormat !== "mc-aws-backup-state" ||
      capsule.stateSchemaVersion !== 3 ||
      capsule.keyIdSource !== "authenticated-keyring" ||
      capsule.adoptionLockParameter !== "/minecraft/backup-recovery-adoption-lock"
    ) {
      fail("manifest.teardown.recoveryCapsule verifier metadata is invalid");
    }
    if (!Number.isSafeInteger(capsule.checkpointGeneration) || capsule.checkpointGeneration < 0) {
      fail("manifest.teardown.recoveryCapsule checkpoint generation is invalid");
    }
    if (
      !Number.isSafeInteger(capsule.floorGeneration) ||
      capsule.floorGeneration < 0 ||
      capsule.floorGeneration > capsule.checkpointGeneration
    ) {
      fail("manifest.teardown.recoveryCapsule restore floor is invalid");
    }
    assertString(capsule.preservedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.recoveryCapsule.preservedAt");
    assertString(
      capsule.adoptionLockParameter,
      /^\/minecraft\/backup-recovery-adoption-lock$/,
      "manifest.teardown.recoveryCapsule.adoptionLockParameter"
    );
    for (const field of ["capsuleDigest", "verifierSha256", "keyringSha256"]) {
      assertString(capsule[field], /^[a-f0-9]{64}$/, `manifest.teardown.recoveryCapsule.${field}`, { optional: true });
    }
    if (capsule.status === "adopted" && (!capsule.capsuleDigest || !capsule.verifierSha256 || !capsule.keyringSha256)) {
      fail("adopted recovery capsule provenance must include exact content digests");
    }
  }

  const forbidden = /(^|_)(secret|token|password|private.?key|credential)(_|$)/i;
  const forbiddenValue =
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/;
  const visit = (value, path = "manifest") => {
    if (typeof value === "string" && forbiddenValue.test(value)) fail(`${path} contains a secret-like value`);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.test(key)) fail(`${path}.${key} is a forbidden secret-like field`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(manifest);
}

function assertSecureManifestFile() {
  const descriptor = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) fail(`${manifestPath} must be one regular file`);
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      fail(`${manifestPath} must be owned by the current user`);
    }
    if ((opened.mode & 0o777) !== 0o600) fail(`${manifestPath} mode must be exactly 0600`);
  } finally {
    closeSync(descriptor);
  }
}

function readSecureManifestText() {
  const descriptor = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) fail(`${manifestPath} must be one regular file`);
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      fail(`${manifestPath} must be owned by the current user`);
    }
    if ((opened.mode & 0o777) !== 0o600) fail(`${manifestPath} mode must be exactly 0600`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function assertSecureLockFile() {
  const status = lstatSync(manifestLockPath);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    fail(`${manifestLockPath} must be one regular lock file`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    fail(`${manifestLockPath} must be owned by the current user`);
  }
  if ((status.mode & 0o777) !== 0o600) fail(`${manifestLockPath} mode must be exactly 0600`);
}

function procLockDeviceInode(status) {
  const device = BigInt(status.dev);
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn);
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xfffn);
  return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${status.ino}`;
}

function assertFlockWrapperParent(parentPid, opened) {
  if (!Number.isSafeInteger(parentPid) || parentPid !== process.ppid) {
    fail(`manifest lock parent identity does not match process.ppid (expected ${parentPid}, actual ${process.ppid})`);
  }
  let parentExecutable;
  try {
    parentExecutable = readlinkSync(`/proc/${process.ppid}/exe`);
  } catch {
    fail("manifest lock wrapper identity is unavailable");
  }
  if (parentExecutable !== "/usr/bin/flock") fail("manifest lock parent is not the flock wrapper");
  const parentStart = processStartToken(process.ppid);
  if (!parentStart || (process.env[LOCK_PARENT_START_ENV] && process.env[LOCK_PARENT_START_ENV] !== parentStart)) {
    fail("manifest lock parent start identity does not match process.ppid");
  }
  let locks;
  try {
    locks = readFileSync("/proc/locks", "utf8");
  } catch {
    fail("manifest advisory lock ownership cannot be verified");
  }
  const parentOwnsDescriptor = locks.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return (
      fields[1] === "FLOCK" &&
      fields[2] === "ADVISORY" &&
      fields[3] === "WRITE" &&
      fields[4] === String(parentPid) &&
      fields[5] === procLockDeviceInode(opened)
    );
  });
  if (!parentOwnsDescriptor) fail("flock wrapper does not own the exact inherited manifest lock FD device/inode");
  const ownerPid = Number(process.env[LOCK_OWNER_PID_ENV]);
  const ownerStart = process.env[LOCK_OWNER_START_ENV];
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || !ownerStart) {
    fail("manifest lock owner identity is unavailable");
  }
  return { ownerPid, ownerStart, parentPid, parentStart };
}

function processStartToken(pid) {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = source.lastIndexOf(")");
    return endOfCommand === -1
      ? undefined
      : source
          .slice(endOfCommand + 2)
          .trim()
          .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function assertInheritedAdvisoryLock() {
  if (process.env[LEGACY_LOCK_MARKER_ENV] !== undefined) {
    fail("manifest lock markers are not trusted; an inherited locked FD is required");
  }
  const value = process.env[LOCK_FD_ENV];
  if (!value || !/^\d+$/.test(value)) fail("manifest lock FD is missing");
  const descriptor = Number(value);
  let opened;
  try {
    opened = fstatSync(descriptor);
  } catch {
    fail("manifest lock FD is not open in this process");
  }
  if (!opened.isFile() || opened.nlink !== 1) fail("manifest lock FD is not one regular file");
  if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
    fail("manifest lock FD has the wrong owner");
  }
  if ((opened.mode & 0o777) !== 0o600) fail("manifest lock FD is not private");
  const pathDescriptor = openSync(manifestLockPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const pathStatus = fstatSync(pathDescriptor);
    if (pathStatus.dev !== opened.dev || pathStatus.ino !== opened.ino || pathStatus.nlink !== opened.nlink) {
      fail("manifest lock FD does not match the private lock file");
    }
  } finally {
    closeSync(pathDescriptor);
  }
  const { ownerPid, ownerStart, parentPid, parentStart } = assertFlockWrapperParent(
    Number(process.env[LOCK_PARENT_PID_ENV]),
    opened
  );
  const check = () => {
    if (
      process.ppid !== parentPid ||
      processStartToken(parentPid) !== parentStart ||
      processStartToken(ownerPid) !== ownerStart
    )
      process.exit(1);
  };
  check();
  const timer = setInterval(check, 25);
  timer.unref();
}

/**
 * Directory lockfiles cannot be safely stolen after a crash: PID, mtime, and
 * nonce checks are all races. Re-exec the command under the platform's real
 * advisory lock instead. The kernel releases this lock on SIGKILL, so a
 * crashed owner never needs (or gets) a takeover path.
 */
function enterAdvisoryLock() {
  if (process.env[LOCK_FD_ENV] !== undefined || process.env[LEGACY_LOCK_MARKER_ENV] !== undefined) {
    assertInheritedAdvisoryLock();
    return;
  }
  const parent = dirname(manifestPath);
  const parentStatus = lstatSync(parent);
  if (parentStatus.isSymbolicLink() || !parentStatus.isDirectory()) fail(`${parent} must be a directory`);
  const flags = constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0);
  const descriptor = openSync(manifestLockPath, flags, 0o600);
  try {
    fsyncSync(descriptor);
    chmodSync(manifestLockPath, 0o600);
    assertSecureLockFile();
    const flock = "/usr/bin/flock";
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        `exec ${flock} --exclusive ${shellQuote(manifestLockPath)} /bin/sh -c 'export ${LOCK_PARENT_PID_ENV}="$PPID"; exec "$@"' mc-aws-manifest-child "$@"`,
        "mc-aws-manifest-lock",
        process.execPath,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          [LOCK_FD_ENV]: "3",
          [LOCK_OWNER_PID_ENV]: String(process.pid),
          [LOCK_OWNER_START_ENV]: processStartToken(process.pid) || "unknown",
        },
        stdio: ["inherit", "inherit", "inherit", descriptor],
      }
    );
    if (result.error) fail(`OS advisory manifest lock is unavailable: ${result.error.message}`);
    process.exit(result.status ?? 1);
  } catch (error) {
    fail(`OS advisory manifest lock is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) fail(`unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`missing value for --${key}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function required(args, key) {
  const value = args[key];
  if (!value) fail(`--${key} is required`);
  return value;
}

function boolean(value, key) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`--${key} must be true or false`);
}

function defaultManifest() {
  return {
    schemaVersion: 1,
    project: "mc-aws",
    aws: { dlmPolicies: [], ssmParameters: [] },
    cloudflare: { routes: [], kvNamespaces: [], panelDnsRecords: [] },
    teardown: { completedResources: [] },
  };
}

function readManifestFile() {
  let source;
  try {
    source = readSecureManifestText();
  } catch (error) {
    if (error?.code === "ENOENT") return defaultManifest();
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    fail(`cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Schema-v1 manifests created before SSM ownership tracking are migrated in
  // memory to an empty/unproven ownership set. No ownership is inferred.
  if (manifest?.schemaVersion === 1 && manifest?.aws && manifest.aws.ssmParameters === undefined) {
    manifest.aws.ssmParameters = [];
  }
  const legacyWorker = manifest?.schemaVersion === 1 ? manifest?.cloudflare?.worker : undefined;
  const legacyAttestationFields = legacyWorker
    ? [
        legacyWorker.deploymentId,
        legacyWorker.versionId,
        legacyWorker.scriptEtag,
        legacyWorker.artifactMerkleSha256,
        legacyWorker.receiptVerifierSetSha256,
        legacyWorker.deploymentReceiptSha256,
        legacyWorker.uploadConfigSha256,
      ]
    : [];
  const legacyHasNewReceiptFields =
    legacyWorker?.deploymentReceiptSha256 !== undefined || legacyWorker?.uploadConfigSha256 !== undefined;
  if (legacyHasNewReceiptFields && legacyAttestationFields.some((value) => value === undefined)) {
    fail("manifest.cloudflare.worker attestation fields must be recorded as one complete provider observation");
  }
  if (
    legacyWorker?.receiptVerifierSetSha256 !== undefined &&
    !legacyHasNewReceiptFields &&
    legacyAttestationFields.some((value) => value === undefined)
  ) {
    // The former local-input-only receipt digest is not provider attestation.
    // Clear it in memory so the next write migrates safely to an unattested state.
    legacyWorker.receiptVerifierSetSha256 = undefined;
    legacyWorker.versionId = undefined;
    legacyWorker.scriptEtag = undefined;
    legacyWorker.artifactMerkleSha256 = undefined;
    legacyWorker.deploymentReceiptSha256 = undefined;
    legacyWorker.uploadConfigSha256 = undefined;
  }
  validateManifest(manifest);
  return manifest;
}

function loadManifest() {
  return readManifestFile();
}

function manifestRevision(manifest) {
  return manifest.revision ?? 0;
}

function writeManifest(manifest) {
  validateManifest(manifest);
  if (process.env.NODE_ENV === "test" && Number(process.env.MC_AWS_MANIFEST_TEST_HOLD_LOCK_MS) > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.MC_AWS_MANIFEST_TEST_HOLD_LOCK_MS));
  }
  // This process was re-execed under flock, so this read is the latest state
  // and the mutation is serialized with every other manifest command.
  const latest = readManifestFile();
  manifest.revision = manifestRevision(latest) + 1;
  manifest.updatedAt = new Date().toISOString();
  validateManifest(manifest);
  const temporaryPath = `${manifestPath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  const temporaryDescriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(temporaryDescriptor);
  } finally {
    closeSync(temporaryDescriptor);
  }
  try {
    assertSecureManifestFile();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  renameSync(temporaryPath, manifestPath);
  const parentDescriptor = openSync(dirname(manifestPath), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
  console.log(manifestPath);
}

function upsert(items, predicate, value) {
  const index = items.findIndex(predicate);
  if (index === -1) items.push(value);
  else items[index] = { ...items[index], ...value };
}

enterAdvisoryLock();

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const manifest = loadManifest();

if (command === "validate") {
  console.log(manifestPath);
  process.exit(0);
}

if (command === "deployment-target") {
  const stack = manifest.aws.stack;
  if (!manifest.aws.accountId || !manifest.aws.region || !stack?.name || !stack.claimToken) {
    fail("manifest does not contain an exact AWS deployment claim");
  }
  console.log(
    JSON.stringify({
      account: manifest.aws.accountId,
      region: manifest.aws.region,
      stackName: stack.name,
      stackId: stack.id || "",
      claimToken: stack.claimToken,
    })
  );
  process.exit(0);
}

if (command === "route-state") {
  const zoneId = required(args, "zone");
  const pattern = required(args, "pattern");
  const liveId = required(args, "id");
  const liveScript = required(args, "script");
  const prior = manifest.cloudflare.routes.find((entry) => entry.zoneId === zoneId && entry.pattern === pattern);
  if (!prior) {
    console.log("untracked");
    process.exit(0);
  }
  const routeIsAbsent = liveId === "absent" && liveScript === "absent";
  if ((liveId === "absent") !== (liveScript === "absent")) fail("live route identity is incomplete");
  if (routeIsAbsent) {
    if (prior.id || prior.ownership !== "created" || !prior.createdByProject || !prior.ownershipProven) {
      fail("manifest/live route mismatch; refusing deployment");
    }
  } else if (prior.id !== liveId || prior.script !== liveScript) {
    fail("manifest/live route mismatch; refusing deployment");
  }
  if (!prior.ownershipProven) fail("manifest route ownership is unproven; refusing deployment");
  if (prior.createdByProject && prior.ownership === "created") console.log("created");
  else if (!prior.createdByProject && prior.ownership === "preexisting") console.log("preexisting");
  else fail("manifest route ownership is inconsistent; refusing deployment");
  process.exit(0);
}

if (command === "executor-receipt-state") {
  if (!manifest.executorReceipt) fail("executor receipt verifier authority is not recorded");
  console.log(JSON.stringify(manifest.executorReceipt));
  process.exit(0);
}

switch (command) {
  case "aws-init": {
    const accountId = required(args, "account");
    const region = required(args, "region");
    const stackName = required(args, "stack");
    const stackState = required(args, "stack-state");
    const liveStackId = args["stack-id"] || "";
    const claimToken = args["claim-token"] || randomUUID();
    const claimObserved =
      args["claim-observed"] === undefined ? false : boolean(args["claim-observed"], "claim-observed");
    if (!["absent", "existing"].includes(stackState)) fail("invalid --stack-state");
    if (manifest.aws.accountId && (manifest.aws.accountId !== accountId || manifest.aws.region !== region)) {
      fail("refusing to replace the AWS account/region identity in an existing manifest");
    }
    if (stackState === "existing") {
      const interruptedCreation =
        claimObserved &&
        manifest.aws.stack?.observedBeforeSetup === "absent" &&
        manifest.aws.stack?.createdByProject === false &&
        manifest.aws.stack?.id === "" &&
        manifest.aws.stack?.name === stackName &&
        manifest.aws.stack?.claimToken === claimToken;
      const establishedCreation =
        manifest.aws.stack?.createdByProject !== true ||
        !manifest.aws.stack.id ||
        manifest.aws.stack.id === "unknown" ||
        manifest.aws.stack.id !== liveStackId ||
        manifest.aws.stack.name !== stackName ||
        !manifest.aws.stack.claimToken;
      if (!interruptedCreation && establishedCreation) {
        fail("existing same-name stack is not proven to be the immutable manifest-owned stack; refusing deployment");
      }
    }
    manifest.aws = {
      ...manifest.aws,
      accountId,
      region,
      stack: {
        name: stackName,
        id: stackState === "existing" ? liveStackId : "",
        createdByProject: stackState === "existing",
        observedBeforeSetup: stackState,
        claimToken: manifest.aws.stack?.claimToken || claimToken,
      },
      dlmPolicies: manifest.aws.dlmPolicies || [],
      ssmParameters: manifest.aws.ssmParameters || [],
    };
    if (stackState === "absent") {
      const completed = new Set(manifest.teardown.completedResources);
      const completedCloudTeardown = [
        "cloudflare-routes",
        "cloudflare-worker",
        "cloudflare-kv",
        "cloudflare-dns",
        "cloudformation-stack",
      ].every((resource) => completed.has(resource));
      if (completedCloudTeardown) {
        // A fully verified teardown makes prior route/DNS observations historical.
        // Re-inventory them on rebuild, preserve only live pre-existing KV identities,
        // and discard IDs for project-created namespaces that teardown deleted.
        manifest.cloudflare.routes = [];
        manifest.cloudflare.panelDnsRecords = [];
        manifest.cloudflare.kvNamespaces = manifest.cloudflare.kvNamespaces.filter(
          (namespace) => !namespace.createdByProject
        );
      }
      manifest.aws.instanceId = undefined;
      manifest.aws.runtimeIam = undefined;
      manifest.executorReceipt = undefined;
      manifest.teardown.finalRootSnapshot = undefined;
      manifest.teardown.pendingFinalRootSnapshot = undefined;
      manifest.teardown.hibernatedBackupEvidence = undefined;
      manifest.teardown.googleDriveBackupEvidence = undefined;
      manifest.teardown.finalGoogleDriveBackup = undefined;
      manifest.teardown.snapshotCredentialScrub = undefined;
      manifest.teardown.destroyLifecycle = undefined;
      manifest.teardown.recoveryCapsule = undefined;
      manifest.teardown.completedResources = [];
    }
    break;
  }
  case "aws-deployed": {
    const stackId = required(args, "stack-id");
    const claimToken = required(args, "claim-token");
    if (args["claim-observed"] !== "true") fail("CloudFormation did not prove the exact atomic deployment claim");
    if (!manifest.aws.stack?.name) fail("run aws-init before aws-deployed");
    if (manifest.aws.stack.id && manifest.aws.stack.id !== stackId) fail("stack identity changed during deployment");
    if (manifest.aws.stack.claimToken !== claimToken) fail("CloudFormation claim token changed during deployment");
    manifest.aws.stack.id = stackId;
    manifest.aws.stack.createdByProject = true;
    manifest.aws.instanceId = required(args, "instance-id");
    manifest.aws.runtimeIam = {
      userName: required(args, "runtime-user"),
      createdByProject: true,
      stackOwned: true,
      expectedTags: {
        McAwsProject: "mc-aws",
        McAwsPurpose: "CloudflareWorkerRuntime",
        McAwsStack: manifest.aws.stack.name,
      },
    };
    break;
  }
  case "executor-receipt": {
    const keyId = required(args, "key-id");
    const publicKeySpki = required(args, "public-key-spki");
    const priorCurrent = manifest.executorReceipt?.verifiers?.[0];
    const keyEpoch = args["key-epoch"] ? Number(args["key-epoch"]) : (priorCurrent?.keyEpoch ?? 0) + 1;
    if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 1) fail("invalid --key-epoch");
    if (
      priorCurrent &&
      priorCurrent.keyId === keyId &&
      priorCurrent.publicKeySpki === publicKeySpki &&
      (priorCurrent.keyEpoch ?? 1) === keyEpoch
    ) {
      // Existing-host rollouts rediscover the verifier on every run. Do not
      // turn that idempotent observation into a rotation or require a cutoff.
      process.exit(0);
    }
    if (priorCurrent && !args["rotation-cutoff-at"])
      fail("rotating executor receipt keys requires --rotation-cutoff-at");
    const verifier = {
      schemaVersion: 1,
      keyId,
      publicKeySpki,
      keyEpoch,
    };
    const retained = (manifest.executorReceipt?.verifiers ?? [])
      .filter((item) => item.keyId !== keyId)
      .map((item) =>
        item.keyId === manifest.executorReceipt?.currentKeyId && args["rotation-cutoff-at"]
          ? { ...item, rotationCutoffAt: args["rotation-cutoff-at"] }
          : item
      )
      .slice(0, 2);
    manifest.executorReceipt = {
      schemaVersion: 1,
      currentKeyId: keyId,
      verifiers: [verifier, ...retained],
    };
    validateExecutorReceiptVerifierSet(manifest.executorReceipt, "manifest.executorReceipt");
    break;
  }
  case "ssm-observe": {
    const name = required(args, "name");
    const state = required(args, "state");
    const type = args.type || "unknown";
    if (!/^\/minecraft\/[A-Za-z0-9._/-]+(?:\/\*)?$/.test(name)) fail("invalid SSM ownership name");
    if (!["absent", "existing"].includes(state)) fail("invalid --state");
    if (!["String", "StringList", "SecureString", "unknown"].includes(type)) fail("invalid --type");
    const prior = manifest.aws.ssmParameters?.find((entry) => entry.name === name);
    if (prior) break;
    // Absence is only an observation. It is not proof that this process later
    // won the creation race; a separate atomic claim records ownership.
    const ownership = state === "absent" ? "unproven" : "preexisting";
    upsert(manifest.aws.ssmParameters, (entry) => entry.name === name, {
      name,
      type,
      createdByProject: false,
      ownership,
      observedBeforeSetup: state,
      source: "setup-preflight",
    });
    break;
  }
  case "ssm-claim": {
    const name = required(args, "name");
    const claimToken = required(args, "claim-token");
    const resourceVersion = Number(required(args, "resource-version"));
    const type = args.type || "unknown";
    if (!/^\/minecraft\/[A-Za-z0-9._/-]+$/.test(name) || !/^[a-f0-9-]{36}$/.test(claimToken))
      fail("invalid SSM claim identity");
    if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1) fail("invalid SSM resource version");
    const prior = manifest.aws.ssmParameters?.find((entry) => entry.name === name);
    if (!prior || (prior.observedBeforeSetup !== "absent" && prior.ownership !== "created")) {
      fail("SSM claim requires an exact absent observation or an existing project claim");
    }
    upsert(manifest.aws.ssmParameters, (entry) => entry.name === name, {
      name,
      type,
      createdByProject: true,
      ownership: "created",
      observedBeforeSetup: prior.observedBeforeSetup,
      source: prior.source === "exact-stack-resource" ? prior.source : "setup-preflight",
      ...(prior.stackLogicalId ? { stackLogicalId: prior.stackLogicalId } : {}),
      claimToken,
      resourceVersion,
    });
    break;
  }
  case "recovery-capsule": {
    const checkpointGeneration = Number(required(args, "checkpoint-generation"));
    const floorGeneration = Number(required(args, "floor-generation"));
    if (!Number.isSafeInteger(checkpointGeneration) || checkpointGeneration < 0)
      fail("invalid capsule checkpoint generation");
    if (!Number.isSafeInteger(floorGeneration) || floorGeneration < 0 || floorGeneration > checkpointGeneration) {
      fail("invalid capsule restore floor generation");
    }
    manifest.teardown.recoveryCapsule = {
      schemaVersion: 3,
      status: required(args, "status"),
      serverIdentityParameter: "/minecraft/backup-server-identity",
      generationCheckpointParameter: "/minecraft/backup-generation-checkpoint",
      restoreFloorParameter: "/minecraft/restore-generation-floor",
      keyringParameter: "/minecraft/backup-auth-keyring",
      verifierAlgorithm: "HMAC-SHA256",
      manifestFormat: "mc-aws-drive-backup",
      manifestSchemaVersion: 3,
      stateFormat: "mc-aws-backup-state",
      stateSchemaVersion: 3,
      keyIdSource: "authenticated-keyring",
      checkpointGeneration,
      floorGeneration,
      adoptionLockParameter: "/minecraft/backup-recovery-adoption-lock",
      ...(args["capsule-digest"] ? { capsuleDigest: args["capsule-digest"] } : {}),
      ...(args["verifier-sha256"] ? { verifierSha256: args["verifier-sha256"] } : {}),
      ...(args["keyring-sha256"] ? { keyringSha256: args["keyring-sha256"] } : {}),
      preservedAt: required(args, "preserved-at"),
    };
    break;
  }
  case "ssm-stack-resource": {
    const name = required(args, "name");
    const type = args.type || "unknown";
    const logicalId = required(args, "logical-id");
    const stackId = required(args, "stack-id");
    if (!/^\/minecraft\/[A-Za-z0-9._/-]+$/.test(name)) fail("invalid SSM ownership name");
    if (manifest.aws.stack?.createdByProject !== true || manifest.aws.stack.id !== stackId) {
      fail("exact SSM resource is not backed by the manifest's atomically claimed StackId");
    }
    const prior = manifest.aws.ssmParameters?.find((entry) => entry.name === name);
    upsert(manifest.aws.ssmParameters, (entry) => entry.name === name, {
      name,
      type,
      createdByProject: true,
      ownership: "created",
      observedBeforeSetup: prior?.observedBeforeSetup || "unknown",
      source: "exact-stack-resource",
      stackLogicalId: logicalId,
      ...(manifest.aws.stack.claimToken ? { claimToken: manifest.aws.stack.claimToken } : {}),
    });
    break;
  }
  case "snapshot-scrub": {
    manifest.teardown.snapshotCredentialScrub = {
      sourceVolumeId: required(args, "volume-id"),
      completedAt: required(args, "completed-at"),
    };
    break;
  }
  case "cloudflare-init": {
    const accountId = required(args, "account");
    const workerName = required(args, "worker");
    const workerState = required(args, "worker-state");
    if (!["absent", "existing"].includes(workerState)) fail("invalid --worker-state");
    if (manifest.cloudflare.accountId && manifest.cloudflare.accountId !== accountId) {
      fail("refusing to replace the Cloudflare account identity in an existing manifest");
    }
    if (workerState === "existing") {
      if (
        manifest.cloudflare.worker?.createdByProject !== true ||
        manifest.cloudflare.worker.name !== workerName ||
        !manifest.cloudflare.worker.deploymentId ||
        args["live-deployment"] !== manifest.cloudflare.worker.deploymentId
      ) {
        fail("pre-existing Worker is not proven to be this deployment; refusing to overwrite code or secrets");
      }
    }
    manifest.cloudflare.accountId = accountId;
    manifest.cloudflare.worker = {
      name: workerName,
      createdByProject: true,
      observedBeforeDeploy: workerState,
      deploymentId: workerState === "existing" ? manifest.cloudflare.worker.deploymentId : undefined,
      versionId: workerState === "existing" ? manifest.cloudflare.worker.versionId : undefined,
      scriptEtag: workerState === "existing" ? manifest.cloudflare.worker.scriptEtag : undefined,
      artifactMerkleSha256: workerState === "existing" ? manifest.cloudflare.worker.artifactMerkleSha256 : undefined,
      receiptVerifierSetSha256:
        workerState === "existing" ? manifest.cloudflare.worker.receiptVerifierSetSha256 : undefined,
      deploymentReceiptSha256:
        workerState === "existing" ? manifest.cloudflare.worker.deploymentReceiptSha256 : undefined,
      uploadConfigSha256: workerState === "existing" ? manifest.cloudflare.worker.uploadConfigSha256 : undefined,
    };
    manifest.cloudflare.panelHosting = {
      mode: required(args, "mode"),
      workersDevEnabled: boolean(required(args, "workers-dev"), "workers-dev"),
    };
    break;
  }
  case "cloudflare-deployed": {
    if (!manifest.cloudflare.worker?.createdByProject) fail("run cloudflare-init before cloudflare-deployed");
    manifest.cloudflare.worker.deploymentId = required(args, "deployment-id");
    if (args["receipt-authority-deployed"] === "true") {
      if (!manifest.executorReceipt) fail("cannot attest deployed receipt authority before it is pinned");
      const pinnedReceiptVerifierSetSha256 = createHash("sha256")
        .update(JSON.stringify(manifest.executorReceipt))
        .digest("hex");
      if (required(args, "receipt-verifier-set-sha256") !== pinnedReceiptVerifierSetSha256) {
        fail("deployed Worker receipt authority does not match the pinned manifest authority");
      }
      const artifactMerkleSha256 = required(args, "artifact-merkle-sha256");
      const uploadConfigSha256 = required(args, "upload-config-sha256");
      const versionId = required(args, "version-id");
      const scriptEtag = required(args, "script-etag");
      const deploymentReceiptSha256 = required(args, "deployment-receipt-sha256");
      const expectedReceipt = canonicalDeploymentReceipt({
        deploymentId: manifest.cloudflare.worker.deploymentId,
        versionId,
        scriptEtag,
        artifactMerkleSha256,
        receiptVerifierSetSha256: pinnedReceiptVerifierSetSha256,
        uploadConfigSha256,
      });
      if (deploymentReceiptSha256 !== expectedReceipt)
        fail("deployed Worker receipt does not match the immutable tuple");
      manifest.cloudflare.worker.receiptVerifierSetSha256 = pinnedReceiptVerifierSetSha256;
      manifest.cloudflare.worker.versionId = versionId;
      manifest.cloudflare.worker.scriptEtag = scriptEtag;
      manifest.cloudflare.worker.artifactMerkleSha256 = artifactMerkleSha256;
      manifest.cloudflare.worker.deploymentReceiptSha256 = deploymentReceiptSha256;
      manifest.cloudflare.worker.uploadConfigSha256 = uploadConfigSha256;
    } else {
      manifest.cloudflare.worker.receiptVerifierSetSha256 = undefined;
      manifest.cloudflare.worker.versionId = undefined;
      manifest.cloudflare.worker.scriptEtag = undefined;
      manifest.cloudflare.worker.artifactMerkleSha256 = undefined;
      manifest.cloudflare.worker.deploymentReceiptSha256 = undefined;
      manifest.cloudflare.worker.uploadConfigSha256 = undefined;
    }
    break;
  }
  case "kv": {
    const id = required(args, "id");
    const ownership = required(args, "ownership");
    const prior = manifest.cloudflare.kvNamespaces.find((entry) => entry.id === id);
    const createdByProject = ownership === "created" || prior?.createdByProject === true;
    upsert(manifest.cloudflare.kvNamespaces, (entry) => entry.id === id, {
      binding: required(args, "binding"),
      id,
      title: required(args, "title"),
      createdByProject,
      ownership: createdByProject ? "created" : ownership,
    });
    break;
  }
  case "dns": {
    const zoneId = required(args, "zone");
    const recordId = required(args, "id");
    const ownership = required(args, "ownership");
    const prior = manifest.cloudflare.panelDnsRecords.find((entry) => entry.zoneId === zoneId && entry.id === recordId);
    const createdByProject = ownership === "created" || prior?.createdByProject === true;
    upsert(manifest.cloudflare.panelDnsRecords, (entry) => entry.zoneId === zoneId && entry.id === recordId, {
      zoneId,
      id: recordId,
      name: required(args, "name"),
      type: required(args, "type"),
      content: required(args, "content"),
      applied: {
        ttl: Number(required(args, "ttl")),
        proxied: boolean(required(args, "proxied"), "proxied"),
      },
      ...(args.comment !== undefined ? { comment: args.comment } : prior?.comment ? { comment: prior.comment } : {}),
      ...(args["operation-id"] !== undefined
        ? { operationId: args["operation-id"] }
        : prior?.operationId
          ? { operationId: prior.operationId }
          : {}),
      createdByProject,
      modifiedByProject: prior?.modifiedByProject === true || boolean(args.modified || "false", "modified"),
      ownership: createdByProject ? "created" : ownership,
      original:
        prior?.original ||
        (ownership === "preexisting"
          ? {
              proxied: boolean(required(args, "original-proxied"), "original-proxied"),
              ttl: Number(required(args, "original-ttl")),
            }
          : undefined),
    });
    break;
  }
  case "route": {
    const zoneId = required(args, "zone");
    const pattern = required(args, "pattern");
    const routeId = args.id || "";
    const ownership = required(args, "ownership");
    const script = required(args, "script");
    const replacesId = args["replaces-id"];
    const prior = manifest.cloudflare.routes.find((entry) => entry.zoneId === zoneId && entry.pattern === pattern);
    if (replacesId !== undefined) {
      if (!prior) fail("--replaces-id requires an existing same-zone, same-pattern manifest route");
      if (prior.id !== replacesId) fail("--replaces-id does not match the manifest route ID");
      if (!routeId || routeId === replacesId) fail("replacement route ID must be new and non-empty");
      if (ownership !== "created") fail("route ID replacement must request created ownership");
      if (!prior.ownershipProven) fail("cannot replace a route with unproven ownership");
      if (prior.script !== script) fail("replacement route target does not match the proven prior target");
      const provenPreexisting = prior.ownership === "preexisting" && prior.createdByProject === false;
      const provenCreated = prior.ownership === "created" && prior.createdByProject === true;
      if (!provenPreexisting && !provenCreated) fail("prior route ownership is inconsistent");
    } else {
      if (prior?.ownershipProven && prior.id && prior.id !== routeId) {
        fail("same-pattern route identity changed; an exact --replaces-id transition is required");
      }
      if (prior?.ownership === "preexisting" && !prior.createdByProject && ownership === "created") {
        fail("preexisting route ownership can transition only with an exact --replaces-id replacement");
      }
    }
    const createdByProject = replacesId !== undefined || ownership === "created" || prior?.createdByProject === true;
    const ownershipProven =
      replacesId !== undefined || (prior?.ownershipProven === false ? false : ownership !== "unproven");
    if ((ownership === "created" || ownershipProven) && !routeId) {
      fail("route ownership requires the exact nonempty provider route ID");
    }
    upsert(manifest.cloudflare.routes, (entry) => entry.zoneId === zoneId && entry.pattern === pattern, {
      zoneId,
      id: routeId,
      pattern,
      script,
      ...(args["operation-id"] !== undefined
        ? { operationId: args["operation-id"] }
        : prior?.operationId
          ? { operationId: prior.operationId }
          : {}),
      createdByProject,
      ownershipProven,
      ownership: createdByProject ? "created" : ownership,
      originalScript:
        createdByProject || ownership !== "preexisting" ? "" : prior?.originalScript || args["original-script"] || "",
    });
    break;
  }
  case "route-recovered": {
    const zoneId = required(args, "zone");
    const pattern = required(args, "pattern");
    const script = required(args, "script");
    const baselineState = required(args, "baseline-state");
    const expectedCurrentId = required(args, "expected-current-id");
    const restoredId = required(args, "restored-id");
    const prior = manifest.cloudflare.routes.find((entry) => entry.zoneId === zoneId && entry.pattern === pattern);
    if (!prior || !prior.createdByProject || prior.ownership !== "created" || !prior.ownershipProven) {
      fail("route recovery requires a proven project-created manifest route");
    }
    const normalizedExpected = expectedCurrentId === "absent" ? "" : expectedCurrentId;
    if (prior.id !== normalizedExpected || prior.script !== script) {
      fail("route recovery current manifest identity mismatch");
    }
    if (baselineState === "absent") {
      if (restoredId !== "absent") fail("absent route baseline must restore an absent ID");
      manifest.cloudflare.routes = manifest.cloudflare.routes.filter((entry) => entry !== prior);
    } else if (baselineState === "present") {
      if (!/^[a-f0-9]{32}$/i.test(restoredId)) fail("present route baseline requires a verified restored ID");
      prior.id = restoredId;
    } else {
      fail("invalid route baseline state");
    }
    break;
  }
  case "dlm": {
    const id = required(args, "id");
    const ownership = required(args, "ownership");
    const prior = manifest.aws.dlmPolicies.find((entry) => entry.id === id);
    const createdByProject = ownership === "created" || prior?.createdByProject === true;
    upsert(manifest.aws.dlmPolicies, (entry) => entry.id === id, {
      id,
      createdByProject,
      ownership: createdByProject ? "created" : ownership,
      expectedTags: { McAwsProject: "mc-aws", McAwsStack: manifest.aws.stack?.name || required(args, "stack") },
    });
    break;
  }
  case "final-snapshot": {
    manifest.teardown.finalRootSnapshot = {
      snapshotId: required(args, "snapshot-id"),
      sourceVolumeId: required(args, "volume-id"),
      stackId: manifest.aws.stack?.id,
      state: "completed",
      createdAt: required(args, "created-at"),
    };
    manifest.teardown.pendingFinalRootSnapshot = undefined;
    manifest.teardown.hibernatedBackupEvidence = undefined;
    manifest.teardown.googleDriveBackupEvidence = undefined;
    break;
  }
  case "google-drive-backup": {
    const backupCount = Number(required(args, "backup-count"));
    const cacheCachedAt = Number(required(args, "cached-at"));
    manifest.teardown.googleDriveBackupEvidence = {
      parameterName: "/minecraft/backups-cache",
      backupCount,
      cacheCachedAt,
      observedAt: required(args, "observed-at"),
    };
    manifest.teardown.finalRootSnapshot = undefined;
    manifest.teardown.pendingFinalRootSnapshot = undefined;
    manifest.teardown.hibernatedBackupEvidence = undefined;
    break;
  }
  case "final-google-drive-backup": {
    const operationId = required(args, "operation-id");
    if (manifest.teardown.destroyLifecycle?.operationId !== operationId) {
      fail("final Google Drive backup does not belong to the destroy lifecycle");
    }
    manifest.teardown.finalGoogleDriveBackup = {
      backupName: required(args, "backup-name"),
      operationId,
      completedAt: required(args, "completed-at"),
    };
    manifest.teardown.finalRootSnapshot = undefined;
    manifest.teardown.pendingFinalRootSnapshot = undefined;
    manifest.teardown.hibernatedBackupEvidence = undefined;
    manifest.teardown.googleDriveBackupEvidence = undefined;
    break;
  }
  case "pending-final-snapshot": {
    manifest.teardown.pendingFinalRootSnapshot = {
      snapshotId: required(args, "snapshot-id"),
      sourceVolumeId: required(args, "volume-id"),
      stackId: manifest.aws.stack?.id,
      state: "pending",
      createdAt: required(args, "created-at"),
    };
    break;
  }
  case "hibernated-backup": {
    const backupGeneration = Number(required(args, "backup-generation"));
    manifest.teardown.hibernatedBackupEvidence = {
      operationId: required(args, "operation-id"),
      sourceVolumeId: required(args, "volume-id"),
      backupName: required(args, "backup-name"),
      backupId: required(args, "backup-id"),
      backupDigest: required(args, "backup-digest"),
      backupSize: Number(required(args, "backup-size")),
      backupGeneration,
      backupCreatedAt: required(args, "backup-created-at"),
      serverId: required(args, "server-id"),
      observedAt: required(args, "observed-at"),
    };
    manifest.teardown.finalRootSnapshot = undefined;
    manifest.teardown.pendingFinalRootSnapshot = undefined;
    break;
  }
  case "mark-complete": {
    const resource = required(args, "resource");
    if (!completedResourceValues.has(resource)) fail("unknown completed resource");
    if (!manifest.teardown.completedResources.includes(resource)) manifest.teardown.completedResources.push(resource);
    break;
  }
  case "destroy-lifecycle-init": {
    const operationId = required(args, "operation-id");
    const lockId = required(args, "lock-id");
    const createdAt = required(args, "created-at");
    const prior = manifest.teardown.destroyLifecycle;
    if (prior && (prior.phase !== "aborted" || prior.preservationStartedAt)) {
      if (prior.operationId !== operationId || prior.lockId !== lockId) {
        fail("refusing to replace an active or preserved destroy lifecycle identity");
      }
      break;
    }
    manifest.teardown.destroyLifecycle = {
      operationId,
      lockId,
      phase: "intent",
      createdAt,
      updatedAt: createdAt,
    };
    break;
  }
  case "destroy-lifecycle-acquired": {
    const lifecycle = manifest.teardown.destroyLifecycle;
    if (!lifecycle) fail("destroy lifecycle identity is not initialized");
    if (lifecycle.operationId !== required(args, "operation-id") || lifecycle.lockId !== required(args, "lock-id")) {
      fail("destroy lifecycle acquisition identity changed");
    }
    const fencingToken = Number(required(args, "fencing-token"));
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) fail("invalid destroy lifecycle fencing token");
    if (lifecycle.fencingToken !== undefined && lifecycle.fencingToken !== fencingToken) {
      fail("destroy lifecycle fencing token changed");
    }
    lifecycle.fencingToken = fencingToken;
    lifecycle.phase =
      lifecycle.phase === "intent" || lifecycle.phase === "aborted" ? "barrier-active" : lifecycle.phase;
    lifecycle.updatedAt = required(args, "updated-at");
    break;
  }
  case "destroy-lifecycle-phase": {
    const lifecycle = manifest.teardown.destroyLifecycle;
    if (!lifecycle || lifecycle.operationId !== required(args, "operation-id")) {
      fail("destroy lifecycle phase identity changed");
    }
    const phase = required(args, "phase");
    if (
      !destroyLifecyclePhaseValues.has(phase) ||
      phase === "intent" ||
      phase === "barrier-active" ||
      phase === "aborted"
    ) {
      fail("invalid destroy lifecycle phase transition");
    }
    const currentIndex = destroyLifecyclePhases.indexOf(lifecycle.phase);
    const nextIndex = destroyLifecyclePhases.indexOf(phase);
    if (lifecycle.phase === "aborted" || nextIndex < currentIndex) fail("destroy lifecycle phase cannot move backward");
    lifecycle.phase = phase;
    lifecycle.updatedAt = required(args, "updated-at");
    if (nextIndex >= destroyLifecyclePhases.indexOf("preserving")) {
      lifecycle.preservationStartedAt ??= required(args, "preservation-started-at");
    }
    break;
  }
  case "destroy-lifecycle-aborted": {
    const lifecycle = manifest.teardown.destroyLifecycle;
    if (!lifecycle || lifecycle.operationId !== required(args, "operation-id")) {
      fail("destroy lifecycle abort identity changed");
    }
    if (
      lifecycle.preservationStartedAt ||
      destroyLifecyclePhases.indexOf(lifecycle.phase) >= destroyLifecyclePhases.indexOf("preserving")
    ) {
      fail("destroy lifecycle cannot be aborted after preservation starts");
    }
    lifecycle.phase = "aborted";
    lifecycle.updatedAt = required(args, "updated-at");
    break;
  }
  default:
    fail(`unknown command: ${command || "(missing)"}`);
}

writeManifest(manifest);
