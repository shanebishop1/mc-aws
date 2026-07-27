#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(process.env.MC_AWS_DEPLOYMENT_MANIFEST || ".mc-aws-deployment.json");
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

function fail(message) {
  console.error(`Deployment manifest error: ${message}`);
  process.exit(1);
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one centralized strict schema validator intentionally checks every nested ownership field.
function validateManifest(manifest) {
  assertKeys(manifest, ["schemaVersion", "project", "aws", "cloudflare", "teardown", "updatedAt"], "manifest");
  if (manifest.schemaVersion !== 1 || manifest.project !== "mc-aws") fail("unsupported manifest identity");
  assertString(manifest.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, "manifest.updatedAt", {
    optional: true,
  });

  assertKeys(manifest.aws, ["accountId", "region", "stack", "instanceId", "runtimeIam", "dlmPolicies"], "manifest.aws");
  assertString(manifest.aws.accountId, /^\d{12}$/, "manifest.aws.accountId", { optional: true });
  assertString(manifest.aws.region, /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/, "manifest.aws.region", { optional: true });
  if (manifest.aws.stack !== undefined) {
    assertKeys(manifest.aws.stack, ["name", "id", "createdByProject", "observedBeforeSetup"], "manifest.aws.stack");
    assertString(manifest.aws.stack.name, /^[A-Za-z][A-Za-z0-9-]{0,127}$/, "manifest.aws.stack.name");
    assertString(
      manifest.aws.stack.id,
      /^(?:|unknown|arn:aws(?:-[a-z]+)?:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[A-Za-z0-9-]+)$/,
      "manifest.aws.stack.id"
    );
    assertBoolean(manifest.aws.stack.createdByProject, "manifest.aws.stack.createdByProject");
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

  assertKeys(
    manifest.cloudflare,
    ["accountId", "worker", "panelHosting", "routes", "kvNamespaces", "panelDnsRecords"],
    "manifest.cloudflare"
  );
  assertString(manifest.cloudflare.accountId, /^[a-f0-9]{32}$/i, "manifest.cloudflare.accountId", { optional: true });
  if (manifest.cloudflare.worker !== undefined) {
    assertKeys(
      manifest.cloudflare.worker,
      ["name", "createdByProject", "observedBeforeDeploy", "deploymentId"],
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
  for (const [index, route] of manifest.cloudflare.routes.entries()) {
    const path = `manifest.cloudflare.routes[${index}]`;
    assertKeys(
      route,
      ["zoneId", "id", "pattern", "script", "createdByProject", "ownershipProven", "ownership", "originalScript"],
      path
    );
    assertString(route.zoneId, /^[a-f0-9]{32}$/i, `${path}.zoneId`);
    assertString(route.id, /^(?:|[a-f0-9]{32})$/i, `${path}.id`);
    assertString(route.pattern, /^[A-Za-z0-9.-]+\/\*$/, `${path}.pattern`);
    assertString(route.script, /^[a-z0-9][a-z0-9-]{0,62}$/, `${path}.script`);
    assertBoolean(route.createdByProject, `${path}.createdByProject`);
    assertBoolean(route.ownershipProven, `${path}.ownershipProven`);
    if (!ownershipValues.has(route.ownership) || (route.createdByProject && route.ownership !== "created")) {
      fail(`${path}.ownership is invalid`);
    }
    if (route.createdByProject && !route.ownershipProven) fail(`${path} cannot be owned without ownership proof`);
    assertString(route.originalScript, /^(?:|[a-z0-9][a-z0-9-]{0,62})$/, `${path}.originalScript`);
  }
  if (!Array.isArray(manifest.cloudflare.kvNamespaces)) fail("manifest.cloudflare.kvNamespaces must be an array");
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
        "proxied",
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
    assertBoolean(record.proxied, `${path}.proxied`);
    assertBoolean(record.createdByProject, `${path}.createdByProject`);
    assertBoolean(record.modifiedByProject, `${path}.modifiedByProject`);
    if (!ownershipValues.has(record.ownership) || (record.createdByProject && record.ownership !== "created")) {
      fail(`${path}.ownership is invalid`);
    }
    if (record.original !== undefined) {
      assertKeys(record.original, ["proxied"], `${path}.original`);
      assertBoolean(record.original.proxied, `${path}.original.proxied`);
    }
  }

  assertKeys(
    manifest.teardown,
    ["completedResources", "finalRootSnapshot", "pendingFinalRootSnapshot", "hibernatedBackupEvidence"],
    "manifest.teardown"
  );
  if (!Array.isArray(manifest.teardown.completedResources))
    fail("manifest.teardown.completedResources must be an array");
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
      ["parameterName", "backupCount", "cacheCachedAt", "observedAt"],
      "manifest.teardown.hibernatedBackupEvidence"
    );
    if (evidence.parameterName !== "/minecraft/backups-cache") fail("invalid hibernated backup parameter");
    if (!Number.isInteger(evidence.backupCount) || evidence.backupCount < 1)
      fail("hibernated backup evidence is empty");
    if (!Number.isSafeInteger(evidence.cacheCachedAt) || evidence.cacheCachedAt < 1)
      fail("hibernated backup cachedAt is invalid");
    assertString(evidence.observedAt, /^\d{4}-\d{2}-\d{2}T/, "manifest.teardown.hibernatedBackupEvidence.observedAt");
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
  const linkStatus = lstatSync(manifestPath);
  if (linkStatus.isSymbolicLink()) fail(`${manifestPath} must not be a symlink`);
  if (!linkStatus.isFile()) fail(`${manifestPath} must be a regular file`);
  const status = statSync(manifestPath);
  if (status.nlink !== 1) fail(`${manifestPath} must not have additional hard links`);
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    fail(`${manifestPath} must be owned by the current user`);
  }
  if ((status.mode & 0o777) !== 0o600) fail(`${manifestPath} mode must be exactly 0600`);
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

function loadManifest() {
  if (!existsSync(manifestPath)) {
    return {
      schemaVersion: 1,
      project: "mc-aws",
      aws: { dlmPolicies: [] },
      cloudflare: { routes: [], kvNamespaces: [], panelDnsRecords: [] },
      teardown: { completedResources: [] },
    };
  }
  assertSecureManifestFile();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateManifest(manifest);
  return manifest;
}

function writeManifest(manifest) {
  validateManifest(manifest);
  manifest.updatedAt = new Date().toISOString();
  const temporaryPath = `${manifestPath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, manifestPath);
  console.log(manifestPath);
}

function upsert(items, predicate, value) {
  const index = items.findIndex(predicate);
  if (index === -1) items.push(value);
  else items[index] = { ...items[index], ...value };
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const manifest = loadManifest();

if (command === "validate") {
  console.log(manifestPath);
  process.exit(0);
}

switch (command) {
  case "aws-init": {
    const accountId = required(args, "account");
    const region = required(args, "region");
    const stackName = required(args, "stack");
    const stackState = required(args, "stack-state");
    const liveStackId = args["stack-id"] || "";
    if (!["absent", "existing"].includes(stackState)) fail("invalid --stack-state");
    if (manifest.aws.accountId && (manifest.aws.accountId !== accountId || manifest.aws.region !== region)) {
      fail("refusing to replace the AWS account/region identity in an existing manifest");
    }
    if (stackState === "existing") {
      if (
        manifest.aws.stack?.createdByProject !== true ||
        !manifest.aws.stack.id ||
        manifest.aws.stack.id === "unknown" ||
        manifest.aws.stack.id !== liveStackId ||
        manifest.aws.stack.name !== stackName
      ) {
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
        createdByProject: true,
        observedBeforeSetup: stackState,
      },
      dlmPolicies: manifest.aws.dlmPolicies || [],
    };
    if (stackState === "absent") {
      manifest.aws.instanceId = undefined;
      manifest.aws.runtimeIam = undefined;
      manifest.teardown.finalRootSnapshot = undefined;
      manifest.teardown.pendingFinalRootSnapshot = undefined;
      manifest.teardown.hibernatedBackupEvidence = undefined;
      manifest.teardown.completedResources = [];
    }
    break;
  }
  case "aws-deployed": {
    const stackId = required(args, "stack-id");
    if (!manifest.aws.stack?.name) fail("run aws-init before aws-deployed");
    if (manifest.aws.stack.id && manifest.aws.stack.id !== stackId) fail("stack identity changed during deployment");
    manifest.aws.stack.id = stackId;
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
      proxied: boolean(required(args, "proxied"), "proxied"),
      createdByProject,
      modifiedByProject: prior?.modifiedByProject === true || boolean(args.modified || "false", "modified"),
      ownership: createdByProject ? "created" : ownership,
      original:
        prior?.original ||
        (ownership === "preexisting"
          ? { proxied: boolean(required(args, "original-proxied"), "original-proxied") }
          : undefined),
    });
    break;
  }
  case "route": {
    const zoneId = required(args, "zone");
    const pattern = required(args, "pattern");
    const routeId = args.id || "";
    const ownership = required(args, "ownership");
    const prior = manifest.cloudflare.routes.find((entry) => entry.zoneId === zoneId && entry.pattern === pattern);
    if (prior?.ownershipProven && prior.id && prior.id !== routeId) {
      fail("same-pattern route identity changed; refusing to inherit prior ownership");
    }
    const createdByProject = ownership === "created" || prior?.createdByProject === true;
    const ownershipProven = prior?.ownershipProven === false ? false : ownership !== "unproven";
    upsert(manifest.cloudflare.routes, (entry) => entry.zoneId === zoneId && entry.pattern === pattern, {
      zoneId,
      id: routeId,
      pattern,
      script: required(args, "script"),
      createdByProject,
      ownershipProven,
      ownership: createdByProject ? "created" : ownership,
      originalScript:
        createdByProject || ownership !== "preexisting" ? "" : prior?.originalScript || args["original-script"] || "",
    });
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
    const backupCount = Number(required(args, "backup-count"));
    const cacheCachedAt = Number(required(args, "cached-at"));
    manifest.teardown.hibernatedBackupEvidence = {
      parameterName: "/minecraft/backups-cache",
      backupCount,
      cacheCachedAt,
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
  default:
    fail(`unknown command: ${command || "(missing)"}`);
}

writeManifest(manifest);
