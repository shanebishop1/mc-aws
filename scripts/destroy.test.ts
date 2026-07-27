import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = path.resolve(process.cwd());
const temporaryDirectories: string[] = [];
const accountId = "123456789012";
const cloudflareAccountId = "a".repeat(32);
const zoneId = "d".repeat(32);
const routeId = "e".repeat(32);
const dnsId = "c".repeat(32);
const kvId = "b".repeat(32);
const instanceId = `i-${"1".repeat(17)}`;
const volumeId = `vol-${"2".repeat(17)}`;
const snapshotId = `snap-${"3".repeat(17)}`;
const secondSnapshotId = `snap-${"4".repeat(17)}`;
const workerDeploymentId = "11111111-2222-4333-8444-555555555555";
const replacementDeploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const stackId = `arn:aws:cloudformation:us-east-1:${accountId}:stack/MinecraftStack/stack-id`;
const replacementStackId = `arn:aws:cloudformation:us-east-1:${accountId}:stack/MinecraftStack/replacement-id`;

interface MockState {
  stack: boolean;
  stackId: string;
  stackDescribeCount: number;
  stackFinalFailure: boolean;
  replaceStackAfterInventory: boolean;
  user: boolean;
  userTags: Record<string, string>;
  iamTagReadCount: number;
  changeIamTagsAfterInventory: boolean;
  accessKeys: string[];
  worker: boolean;
  workerDeployments: string[];
  workerFinalFailure: boolean;
  secrets: string[];
  kv: Array<{ id: string; title: string }>;
  routes: Array<{ id: string; pattern: string; script: string }>;
  dns: Array<{ id: string; zoneId: string; type: string; name: string; content: string; proxied: boolean }>;
  dnsMissingCode: number;
  instanceState: string;
  ssmCommandFails: boolean;
  stopInstanceFails: boolean;
  stopWaitFails: boolean;
  rootVolume: boolean;
  volumes: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  snapshotCreateCount: number;
  snapshotCreateFails: boolean;
  snapshotWaitFails: boolean;
  backupCache: { backups: unknown[]; cachedAt: number };
  dlm: Array<{ PolicyId: string; Tags: Record<string, string> }>;
  failStackDeleteWaitOnce: boolean;
  stackDeleteWaitFailureConsumed?: boolean;
  instanceWriteGeneration: number;
  mutations: string[];
}

const rootVolume = () => ({
  VolumeId: volumeId,
  State: "in-use",
  Attachments: [{ InstanceId: instanceId, State: "attached" }],
  Tags: [
    { Key: "McAwsProject", Value: "mc-aws" },
    { Key: "McAwsStack", Value: "MinecraftStack" },
    { Key: "McAwsManagedRoot", Value: "true" },
  ],
});

const baseState = (): MockState => ({
  stack: true,
  stackId,
  stackDescribeCount: 0,
  stackFinalFailure: false,
  replaceStackAfterInventory: false,
  user: true,
  userTags: {
    McAwsProject: "mc-aws",
    McAwsPurpose: "CloudflareWorkerRuntime",
    McAwsStack: "MinecraftStack",
  },
  iamTagReadCount: 0,
  changeIamTagsAfterInventory: false,
  accessKeys: ["AKIAOWNEDRUNTIMEKEY"],
  worker: true,
  workerDeployments: [workerDeploymentId],
  workerFinalFailure: false,
  secrets: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  kv: [{ id: kvId, title: "mc-aws-runtime-state" }],
  routes: [],
  dns: [],
  dnsMissingCode: 81044,
  instanceState: "stopped",
  ssmCommandFails: false,
  stopInstanceFails: false,
  stopWaitFails: false,
  rootVolume: true,
  volumes: [rootVolume()],
  snapshots: [],
  snapshotCreateCount: 0,
  snapshotCreateFails: false,
  snapshotWaitFails: false,
  backupCache: { backups: [{ name: "backup-before-hibernate" }], cachedAt: 1_769_000_000_000 },
  dlm: [],
  failStackDeleteWaitOnce: false,
  instanceWriteGeneration: 0,
  mutations: [],
});

const baseManifest = () => ({
  schemaVersion: 1,
  project: "mc-aws",
  aws: {
    accountId,
    region: "us-east-1",
    stack: { name: "MinecraftStack", id: stackId, createdByProject: true, observedBeforeSetup: "absent" },
    instanceId,
    runtimeIam: {
      userName: "mc-aws-runtime-user",
      createdByProject: true,
      stackOwned: true,
      expectedTags: {
        McAwsProject: "mc-aws",
        McAwsPurpose: "CloudflareWorkerRuntime",
        McAwsStack: "MinecraftStack",
      },
    },
    dlmPolicies: [],
  },
  cloudflare: {
    accountId: cloudflareAccountId,
    worker: {
      name: "mc-aws-panel",
      createdByProject: true,
      observedBeforeDeploy: "absent",
      deploymentId: workerDeploymentId,
    },
    panelHosting: { mode: "workers_dev", workersDevEnabled: true },
    routes: [] as Array<Record<string, unknown>>,
    kvNamespaces: [
      {
        binding: "RUNTIME_STATE_SNAPSHOT_KV",
        id: kvId,
        title: "mc-aws-runtime-state",
        createdByProject: true,
        ownership: "created",
      },
    ],
    panelDnsRecords: [] as Array<Record<string, unknown>>,
  },
  teardown: { completedResources: [] as string[] } as Record<string, unknown>,
});

const mockCliSource = String.raw`
import fs from "node:fs";
const [tool, ...rawArgs] = process.argv.slice(2);
const statePath = ${JSON.stringify("__STATE_PATH__")};
const accountId = ${JSON.stringify(accountId)};
const cfAccountId = ${JSON.stringify(cloudflareAccountId)};
const instanceId = ${JSON.stringify(instanceId)};
const volumeId = ${JSON.stringify(volumeId)};
const snapshotId = ${JSON.stringify(snapshotId)};
const secondSnapshotId = ${JSON.stringify(secondSnapshotId)};
let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const mutate = (entry) => { state.mutations.push(entry); save(); };
const output = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const fail = (message, code = 255) => { process.stderr.write(message); process.exit(code); };
const args = rawArgs[0] === "--region" ? rawArgs.slice(2) : rawArgs;

if (tool === "aws") {
  const [service, command] = args;
  if (service === "sts") output(accountId);
  else if (service === "cloudformation" && command === "describe-stacks") {
    state.stackDescribeCount += 1;
    if (state.replaceStackAfterInventory && state.stackDescribeCount >= 2) state.stackId = ${JSON.stringify(replacementStackId)};
    save();
    const requested = args[args.indexOf("--stack-name") + 1];
    if (!state.stack && state.stackFinalFailure) fail("AccessDenied: cloudformation DescribeStacks denied");
    if (!state.stack || (requested.startsWith("arn:") && requested !== state.stackId)) fail("ValidationError: Stack does not exist");
    output({ Stacks: [{ StackId: state.stackId }] });
  } else if (service === "cloudformation" && command === "delete-stack") {
    const requested = args[args.indexOf("--stack-name") + 1];
    if (!state.stack || requested !== state.stackId) fail("ValidationError: Stack does not exist");
    mutate("cloudformation:delete-stack:" + requested);
  } else if (service === "cloudformation" && command === "wait") {
    const requested = args[args.indexOf("--stack-name") + 1];
    if (requested !== state.stackId) fail("ValidationError: Stack does not exist");
    if (state.failStackDeleteWaitOnce && !state.stackDeleteWaitFailureConsumed) {
      state.stackDeleteWaitFailureConsumed = true;
      state.instanceState = "running";
      state.instanceWriteGeneration += 1;
      mutate("instance:restarted-with-new-writes:" + state.instanceWriteGeneration);
      mutate("cloudformation:wait-failed");
      fail("WaiterError: stack deletion failed");
    }
    state.stack = false; state.user = false; state.rootVolume = false; state.volumes = [];
    mutate("cloudformation:stack-deleted:" + requested);
  } else if (service === "iam" && command === "get-user") {
    if (!state.user) fail("NoSuchEntity");
    output({ User: { UserName: "mc-aws-runtime-user" } });
  } else if (service === "iam" && command === "list-user-tags") {
    state.iamTagReadCount += 1;
    const tags = state.changeIamTagsAfterInventory && state.iamTagReadCount >= 2 ? { McAwsProject: "replaced" } : state.userTags;
    save(); output({ Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) });
  } else if (service === "iam" && command === "list-access-keys") {
    output({ AccessKeyMetadata: state.accessKeys.map((AccessKeyId) => ({ AccessKeyId, Status: "Active" })) });
  } else if (service === "iam" && command === "update-access-key") mutate("iam:update-key:" + args[args.indexOf("--access-key-id") + 1]);
  else if (service === "iam" && command === "delete-access-key") {
    const id = args[args.indexOf("--access-key-id") + 1]; state.accessKeys = state.accessKeys.filter((value) => value !== id); mutate("iam:delete-key:" + id);
  } else if (service === "iam" && command === "list-attached-user-policies") output({ AttachedPolicies: [] });
  else if (service === "iam" && command === "list-groups-for-user") output({ Groups: [] });
  else if (service === "iam" && command === "list-user-policies") output({ PolicyNames: ["inline-runtime-policy"] });
  else if (service === "iam" && command === "delete-user-policy") mutate("iam:delete-inline-policy");
  else if (service === "iam" && command === "delete-user") { state.user = false; mutate("iam:delete-user"); }
  else if (service === "dlm" && command === "get-lifecycle-policies") output({ Policies: state.dlm.map(({ PolicyId }) => ({ PolicyId })) });
  else if (service === "dlm" && command === "get-lifecycle-policy") {
    const id = args[args.indexOf("--policy-id") + 1]; const policy = state.dlm.find((item) => item.PolicyId === id);
    if (!policy) fail("ResourceNotFoundException"); output({ Policy: policy });
  } else if (service === "dlm" && command === "delete-lifecycle-policy") {
    const id = args[args.indexOf("--policy-id") + 1]; state.dlm = state.dlm.filter((item) => item.PolicyId !== id); mutate("dlm:delete:" + id);
  } else if (service === "ec2" && command === "describe-volumes") output({ Volumes: state.volumes });
  else if (service === "ec2" && command === "describe-snapshots") {
    const requested = args.includes("--snapshot-ids") ? args[args.indexOf("--snapshot-ids") + 1] : undefined;
    output({ Snapshots: requested ? state.snapshots.filter((item) => item.SnapshotId === requested) : state.snapshots });
  } else if (service === "ec2" && command === "create-snapshot") {
    if (state.snapshotCreateFails) fail("InternalError: snapshot creation failed");
    if (state.instanceState !== "stopped") fail("IncorrectState: refusing mock snapshot while instance is not stopped");
    const createdSnapshotId = [snapshotId, secondSnapshotId][state.snapshotCreateCount];
    if (!createdSnapshotId) fail("Mock supports only two teardown snapshots");
    state.snapshotCreateCount += 1;
    const snapshot = { SnapshotId: createdSnapshotId, VolumeId: volumeId, State: "pending", WriteGeneration: state.instanceWriteGeneration, Tags: [
      { Key: "McAwsProject", Value: "mc-aws" }, { Key: "McAwsStack", Value: "MinecraftStack" },
      { Key: "McAwsStackId", Value: state.stackId }, { Key: "McAwsSourceVolumeId", Value: volumeId },
      { Key: "McAwsFinalTeardown", Value: "true" },
    ] };
    state.snapshots.push(snapshot); mutate("ec2:create-snapshot:" + createdSnapshotId); output(snapshot);
  } else if (service === "ec2" && command === "wait") {
    const waiter = args[2];
    if (waiter === "snapshot-completed") {
      if (state.snapshotWaitFails) fail("WaiterError: snapshot did not complete");
      const snapshot = state.snapshots.find((item) => item.SnapshotId === args[args.indexOf("--snapshot-ids") + 1]);
      if (snapshot) snapshot.State = "completed"; save();
    } else if (waiter === "instance-stopped") {
      if (state.stopWaitFails) fail("WaiterError: instance did not stop");
      state.instanceState = "stopped"; mutate("ec2:instance-stopped");
    } else if (waiter === "instance-running") {
      state.instanceState = "running"; mutate("ec2:instance-running");
    } else fail("unexpected ec2 waiter: " + waiter);
  } else if (service === "ec2" && command === "stop-instances") {
    if (state.stopInstanceFails) fail("InternalError: stop failed");
    state.instanceState = "stopping"; mutate("ec2:stop-instance:" + instanceId); output({ StoppingInstances: [{ InstanceId: instanceId }] });
  } else if (service === "ec2" && command === "describe-instances") {
    if (!state.stack && args.includes("--instance-ids")) fail("InvalidInstanceID.NotFound");
    if (!state.stack) output({ Reservations: [] });
    else output({ Reservations: [{ Instances: [{ InstanceId: instanceId, RootDeviceName: "/dev/xvda",
      BlockDeviceMappings: state.rootVolume ? [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: volumeId } }] : [],
       State: { Name: state.instanceState }, Tags: [
        { Key: "McAwsProject", Value: "mc-aws" }, { Key: "McAwsStack", Value: "MinecraftStack" },
        { Key: "aws:cloudformation:stack-id", Value: state.stackId },
      ] }] }] });
  } else if (service === "ssm" && command === "get-parameter") output({ Parameter: { Value: JSON.stringify(state.backupCache) } });
  else if (service === "ssm" && command === "send-command") {
    mutate("ssm:quiesce-minecraft"); output({ Command: { CommandId: "11111111-2222-4333-8444-555555555555" } });
  } else if (service === "ssm" && command === "wait") {
    if (state.ssmCommandFails) fail("WaiterError: command failed");
  } else if (service === "ssm" && command === "get-command-invocation") {
    output({ CommandId: "11111111-2222-4333-8444-555555555555", InstanceId: instanceId, Status: state.ssmCommandFails ? "Failed" : "Success" });
  }
  else fail("unexpected aws command: " + args.join(" "));
} else if (tool === "wrangler") {
  const joined = args.join(" ");
  if (joined.includes("whoami")) output("Account ID: " + cfAccountId);
  else if (joined.includes("deployments status")) {
    if (state.workerFinalFailure && !state.worker) fail("AccessDenied: code 10000");
    if (!state.worker) fail("Worker API error code 10090");
    output({ id: state.workerDeployments[0] });
  } else if (joined.includes("kv namespace list")) output(state.kv);
  else if (joined.includes("secret list")) { mutate("wrangler:secret-list"); output(state.secrets.map((name) => ({ name, type: "secret_text" }))); }
  else if (joined.includes("secret delete")) {
    const name = args.at(-1); state.secrets = state.secrets.filter((value) => value !== name); mutate("wrangler:secret-delete:" + name);
  } else if (joined.includes("kv namespace delete")) {
    const id = args[args.indexOf("--namespace-id") + 1]; state.kv = state.kv.filter((item) => item.id !== id); mutate("wrangler:kv-delete:" + id);
  } else if (args.includes("delete")) { state.worker = false; state.secrets = []; mutate("wrangler:worker-delete"); }
  else fail("unexpected wrangler command: " + joined);
} else if (tool === "curl") {
  const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
  const url = args.at(-1); const body = args.includes("--data") ? JSON.parse(args[args.indexOf("--data") + 1]) : undefined;
  const routeMatch = url.match(/\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/);
  const dnsMatch = url.match(/\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
  let status = 200; let response;
  if (routeMatch && method === "GET") response = { success: true, result: state.routes };
  else if (routeMatch && method === "DELETE") { state.routes = state.routes.filter((item) => item.id !== routeMatch[2]); mutate("cf:route-delete:" + routeMatch[2]); response = { success: true, result: { id: routeMatch[2] } }; }
  else if (routeMatch && method === "PUT") { const route = state.routes.find((item) => item.id === routeMatch[2]); Object.assign(route, body); mutate("cf:route-restore:" + routeMatch[2]); response = { success: true, result: route }; }
  else if (dnsMatch && method === "GET") { const record = state.dns.find((item) => item.id === dnsMatch[2]); if(record) response={success:true,result:record}; else {status=404;response={success:false,errors:[{code:state.dnsMissingCode}]};} }
  else if (dnsMatch && method === "DELETE") { state.dns = state.dns.filter((item) => item.id !== dnsMatch[2]); mutate("cf:dns-delete:" + dnsMatch[2]); response = { success: true, result: { id: dnsMatch[2] } }; }
  else if (dnsMatch && method === "PUT") { const record = state.dns.find((item) => item.id === dnsMatch[2]); Object.assign(record, body); mutate("cf:dns-restore:" + dnsMatch[2]); response = { success: true, result: record }; }
  else fail("unexpected curl request: " + method + " " + url);
  const responsePath = args[args.indexOf("-o") + 1]; fs.writeFileSync(responsePath, JSON.stringify(response)); output(String(status));
} else fail("unknown mock tool");
`;

function makeHarness(
  overrides?: Partial<MockState>,
  manifestOverride?: (manifest: ReturnType<typeof baseManifest>) => void,
  options: { mode?: number; symlink?: boolean } = {}
) {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-destroy-"));
  temporaryDirectories.push(directory);
  const statePath = path.join(directory, "state.json");
  const manifestPath = path.join(directory, "manifest.json");
  const actualManifestPath = options.symlink ? path.join(directory, "manifest-target.json") : manifestPath;
  const envPath = path.join(directory, ".env.production");
  const cliPath = path.join(directory, "mock-cli.mjs");
  const state = { ...baseState(), ...overrides };
  const manifest = baseManifest();
  manifestOverride?.(manifest);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(actualManifestPath, JSON.stringify(manifest, null, 2), { mode: options.mode ?? 0o600 });
  chmodSync(actualManifestPath, options.mode ?? 0o600);
  if (options.symlink) symlinkSync(actualManifestPath, manifestPath);
  writeFileSync(envPath, "CLOUDFLARE_TEARDOWN_API_TOKEN=test-token\n");
  writeFileSync(cliPath, mockCliSource.replace("__STATE_PATH__", statePath));

  const tools: Record<string, string> = {};
  for (const tool of ["aws", "wrangler", "curl"]) {
    const wrapperPath = path.join(directory, tool);
    writeFileSync(wrapperPath, `#!/bin/sh\nexec node ${JSON.stringify(cliPath)} ${tool} "$@"\n`, { mode: 0o755 });
    tools[tool] = wrapperPath;
  }
  const run = (args: string[] = [], input = "") =>
    spawnSync("bash", [path.join(rootDir, "scripts/destroy.sh"), "--manifest", manifestPath, ...args], {
      cwd: rootDir,
      env: {
        ...process.env,
        AWS_CLI: tools.aws,
        WRANGLER_BIN: tools.wrangler,
        CURL_BIN: tools.curl,
        ENV_FILE: envPath,
        WRANGLER_HOME_DIR: directory,
      },
      input,
      encoding: "utf8",
    });
  return {
    run,
    manifestPath,
    readState: () => JSON.parse(readFileSync(statePath, "utf8")) as MockState,
    updateState: (update: Partial<MockState>) => {
      const current = JSON.parse(readFileSync(statePath, "utf8")) as MockState;
      writeFileSync(statePath, JSON.stringify({ ...current, ...update }, null, 2));
    },
    readManifest: () => JSON.parse(readFileSync(actualManifestPath, "utf8")) as Record<string, unknown>,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const confirmation = `destroy MinecraftStack in ${accountId}/us-east-1\n`;

describe("ownership-aware destroy", () => {
  it("defaults to live dry-run with no mutation", () => {
    const harness = makeHarness();
    const result = harness.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DRY RUN (default)");
    expect(harness.readState().mutations).toEqual([]);
  });

  it("creates, waits for, verifies, and records a final root snapshot before exact StackId deletion", () => {
    const harness = makeHarness();
    const result = harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const state = harness.readState();
    expect(state.mutations).toContain(`ec2:create-snapshot:${snapshotId}`);
    expect(state.mutations.indexOf(`ec2:create-snapshot:${snapshotId}`)).toBeLessThan(
      state.mutations.findIndex((entry) => entry === `cloudformation:delete-stack:${stackId}`)
    );
    expect(state.mutations).toContain(`cloudformation:stack-deleted:${stackId}`);
    expect(result.stdout).toContain("root volume itself is NOT retained");
    expect((harness.readManifest().teardown as Record<string, unknown>).finalRootSnapshot).toMatchObject({
      snapshotId,
      sourceVolumeId: volumeId,
      state: "completed",
    });
  }, 20_000);

  it("blocks stack deletion when final snapshot creation fails", () => {
    const harness = makeHarness({ snapshotCreateFails: true });
    const result = harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("blocking CloudFormation stack deletion");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
  }, 20_000);

  it.each(["running", "pending"])(
    "quiesces Minecraft and stops a %s instance before creating the snapshot",
    (state) => {
      const harness = makeHarness({ instanceState: state });
      const result = harness.run(["--execute"], confirmation);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const mutations = harness.readState().mutations;
      const quiesceIndex = mutations.indexOf("ssm:quiesce-minecraft");
      const stopIndex = mutations.indexOf(`ec2:stop-instance:${instanceId}`);
      const stoppedIndex = mutations.indexOf("ec2:instance-stopped");
      const snapshotIndex = mutations.indexOf(`ec2:create-snapshot:${snapshotId}`);
      expect(quiesceIndex).toBeGreaterThanOrEqual(0);
      expect(quiesceIndex).toBeLessThan(stopIndex);
      expect(stopIndex).toBeLessThan(stoppedIndex);
      expect(stoppedIndex).toBeLessThan(snapshotIndex);
      expect(harness.readState().instanceState).toBe("stopped");
    },
    25_000
  );

  it.each([
    ["SSM quiesce", { ssmCommandFails: true }, "quiesce command did not reach successful completion"],
    ["EC2 stop", { stopInstanceFails: true }, "EC2 stop request failed"],
    ["EC2 stop waiter", { stopWaitFails: true }, "did not reach stopped state"],
  ])(
    "blocks snapshot and stack deletion when %s fails",
    (_label, override, expectedError) => {
      const harness = makeHarness({ instanceState: "running", ...override });
      const result = harness.run(["--execute"], confirmation);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      const mutations = harness.readState().mutations;
      expect(mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
      expect(mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
    },
    25_000
  );

  it("resumes a failed snapshot wait without creating a duplicate snapshot", () => {
    const harness = makeHarness({ snapshotWaitFails: true });
    const first = harness.run(["--execute"], confirmation);
    expect(first.status).not.toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toHaveLength(1);
    expect((harness.readManifest().teardown as Record<string, unknown>).pendingFinalRootSnapshot).toMatchObject({
      snapshotId,
      sourceVolumeId: volumeId,
      state: "pending",
    });
    harness.updateState({ snapshotWaitFails: false });
    const retry = harness.run(["--execute"], confirmation);
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toHaveLength(1);
    const teardown = harness.readManifest().teardown as Record<string, unknown>;
    expect(teardown.pendingFinalRootSnapshot).toBeUndefined();
    expect(teardown.finalRootSnapshot).toMatchObject({ snapshotId, state: "completed" });
  }, 30_000);

  it("requires non-empty backup evidence when hibernated without a root volume", () => {
    const harness = makeHarness({
      rootVolume: false,
      volumes: [],
      backupCache: { backups: [], cachedAt: 1_769_000_000_000 },
    });
    const result = harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lacks non-empty backups and a valid cachedAt");
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);

    const invalidTimestamp = makeHarness({
      rootVolume: false,
      volumes: [],
      backupCache: { backups: [{ name: "backup" }], cachedAt: 0 },
    });
    const invalidResult = invalidTimestamp.run(["--execute"], confirmation);
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stderr).toContain("valid cachedAt");
  }, 20_000);

  it("records existing backup evidence when hibernated and performs no EBS snapshot", () => {
    const harness = makeHarness({ rootVolume: false, volumes: [] });
    const result = harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations.some((entry) => entry.startsWith("ec2:create-snapshot"))).toBe(false);
    expect((harness.readManifest().teardown as Record<string, unknown>).hibernatedBackupEvidence).toMatchObject({
      parameterName: "/minecraft/backups-cache",
      backupCount: 1,
      cacheCachedAt: 1_769_000_000_000,
    });
  }, 20_000);

  it("accepts exact HTTP 404/81044 DNS absence but rejects other 404 bodies", () => {
    const addOwnedDns = (manifest: ReturnType<typeof baseManifest>) => {
      manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
      manifest.cloudflare.panelDnsRecords = [
        {
          zoneId,
          id: dnsId,
          name: "panel.example.com",
          type: "A",
          content: "192.0.2.1",
          proxied: true,
          createdByProject: true,
          modifiedByProject: false,
          ownership: "created",
        },
      ];
    };
    expect(makeHarness({}, addOwnedDns).run().status).toBe(0);
    const rejected = makeHarness({ dnsMissingCode: 10000 }, addOwnedDns).run();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("unexpected error");
  });

  it("deletes exact owned route and DNS identities", () => {
    const harness = makeHarness(
      {
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "mc-aws-panel" }],
        dns: [{ id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", proxied: true }],
      },
      (manifest) => {
        manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
        manifest.cloudflare.routes = [
          {
            zoneId,
            id: routeId,
            pattern: "panel.example.com/*",
            script: "mc-aws-panel",
            createdByProject: true,
            ownershipProven: true,
            ownership: "created",
            originalScript: "",
          },
        ];
        manifest.cloudflare.panelDnsRecords = [
          {
            zoneId,
            id: dnsId,
            name: "panel.example.com",
            type: "A",
            content: "192.0.2.1",
            proxied: true,
            createdByProject: true,
            modifiedByProject: false,
            ownership: "created",
          },
        ];
      }
    );
    const result = harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations).toEqual(
      expect.arrayContaining([`cf:route-delete:${routeId}`, `cf:dns-delete:${dnsId}`])
    );
    const mutations = harness.readState().mutations;
    expect(mutations.indexOf(`cf:route-delete:${routeId}`)).toBeLessThan(mutations.indexOf("wrangler:worker-delete"));
    expect(mutations.some((entry) => entry.startsWith("wrangler:secret-"))).toBe(false);
  }, 20_000);

  it("blocks a replaced pre-existing route ID and preserves changed pre-existing DNS", () => {
    const addPreexistingResources = (manifest: ReturnType<typeof baseManifest>) => {
      manifest.cloudflare.panelHosting = { mode: "custom", workersDevEnabled: false };
      manifest.cloudflare.routes = [
        {
          zoneId,
          id: routeId,
          pattern: "panel.example.com/*",
          script: "mc-aws-panel",
          createdByProject: false,
          ownershipProven: true,
          ownership: "preexisting",
          originalScript: "old-worker",
        },
      ];
      manifest.cloudflare.panelDnsRecords = [
        {
          zoneId,
          id: dnsId,
          name: "panel.example.com",
          type: "A",
          content: "192.0.2.1",
          proxied: true,
          createdByProject: false,
          modifiedByProject: true,
          ownership: "preexisting",
          original: { proxied: false },
        },
      ];
    };

    const replacedRoute = makeHarness(
      {
        routes: [{ id: "f".repeat(32), pattern: "panel.example.com/*", script: "mc-aws-panel" }],
        dns: [{ id: dnsId, zoneId, type: "A", name: "panel.example.com", content: "192.0.2.1", proxied: true }],
      },
      addPreexistingResources
    );
    const blocked = replacedRoute.run();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("live ID differs");

    const changedDns = makeHarness(
      {
        routes: [{ id: routeId, pattern: "panel.example.com/*", script: "old-worker" }],
        dns: [
          {
            id: dnsId,
            zoneId,
            type: "A",
            name: "panel.example.com",
            content: "198.51.100.1",
            proxied: true,
          },
        ],
      },
      addPreexistingResources
    );
    const preserved = changedDns.run(["--execute"], confirmation);
    expect(preserved.status, `${preserved.stdout}\n${preserved.stderr}`).toBe(0);
    expect(preserved.stdout).toContain("Preserved changed pre-existing DNS record");
    expect(changedDns.readState().mutations).not.toContain(`cf:dns-restore:${dnsId}`);
  }, 25_000);

  it("rejects stale Worker deployment and same-name replacement stack identities", () => {
    const worker = makeHarness({ workerDeployments: [replacementDeploymentId] }).run();
    expect(worker.status).not.toBe(0);
    expect(worker.stderr).toContain("live Worker deployment identity");
    const stack = makeHarness({ stackId: replacementStackId }).run();
    expect(stack.status).not.toBe(0);
    expect(stack.stderr).toContain("stack ID does not match");
  });

  it("revalidates IAM tags and exact stack identity before destructive AWS mutations", () => {
    const iamHarness = makeHarness({ changeIamTagsAfterInventory: true });
    const iamResult = iamHarness.run(["--execute"], confirmation);
    expect(iamResult.status).not.toBe(0);
    expect(iamResult.stderr).toContain("immediately before access-key revocation");
    expect(iamHarness.readState().mutations.some((entry) => entry.startsWith("iam:"))).toBe(false);

    const stackHarness = makeHarness({ replaceStackAfterInventory: true });
    const stackResult = stackHarness.run(["--execute"], confirmation);
    expect(stackResult.status).not.toBe(0);
    expect(stackHarness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(
      false
    );
  }, 30_000);

  it("treats final provider AccessDenied as failure, not absence", () => {
    const harness = makeHarness({ workerFinalFailure: true });
    const result = harness.run(["--execute"], confirmation);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Worker could not be verified absent");
    const stackHarness = makeHarness({ stackFinalFailure: true });
    const stackResult = stackHarness.run(["--execute"], confirmation);
    expect(stackResult.status).not.toBe(0);
    expect(stackResult.stderr).toContain("stack absence could not be verified");
  }, 30_000);

  it("rejects malformed, wrong-mode, and symlink manifests before inventory", () => {
    const malformed = makeHarness({}, (manifest) => Object.assign(manifest, { unexpected: true }));
    expect(malformed.run().stderr).toContain("Manifest validation failed");
    const wrongMode = makeHarness({}, undefined, { mode: 0o644 });
    expect(wrongMode.run().stderr).toContain("Manifest validation failed");
    const symlink = makeHarness({}, undefined, { symlink: true });
    expect(symlink.run().stderr).toContain("Manifest validation failed");
  });

  it("creates a fresh snapshot after stack deletion failure and remains idempotent", () => {
    const harness = makeHarness({ failStackDeleteWaitOnce: true });
    const first = harness.run(["--execute"], confirmation);
    expect(first.status).not.toBe(0);
    expect(harness.readState().mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toEqual([
      `ec2:create-snapshot:${snapshotId}`,
    ]);
    expect((harness.readManifest().teardown as Record<string, unknown>).finalRootSnapshot).toMatchObject({
      snapshotId,
      state: "completed",
    });

    const retry = harness.run(["--execute"], confirmation);
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    const state = harness.readState();
    expect(state.mutations.filter((entry) => entry.startsWith("ec2:create-snapshot"))).toEqual([
      `ec2:create-snapshot:${snapshotId}`,
      `ec2:create-snapshot:${secondSnapshotId}`,
    ]);
    expect(state.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ SnapshotId: snapshotId, WriteGeneration: 0, State: "completed" }),
        expect.objectContaining({ SnapshotId: secondSnapshotId, WriteGeneration: 1, State: "completed" }),
      ])
    );
    expect((harness.readManifest().teardown as Record<string, unknown>).finalRootSnapshot).toMatchObject({
      snapshotId: secondSnapshotId,
      state: "completed",
    });
    const secondSnapshotIndex = state.mutations.indexOf(`ec2:create-snapshot:${secondSnapshotId}`);
    const deleteIndexes = state.mutations
      .map((entry, index) => (entry.startsWith("cloudformation:delete-stack") ? index : -1))
      .filter((index) => index >= 0);
    expect(deleteIndexes).toHaveLength(2);
    expect(state.mutations.indexOf("instance:restarted-with-new-writes:1")).toBeLessThan(secondSnapshotIndex);
    expect(secondSnapshotIndex).toBeLessThan(deleteIndexes[1]);

    const mutationCount = state.mutations.length;
    expect(harness.run(["--execute"], confirmation).status).toBe(0);
    expect(harness.readState().mutations).toHaveLength(mutationCount);
  }, 50_000);

  it("cleans up an exactly tagged runtime IAM orphan after the stack is already absent", () => {
    const harness = makeHarness({ stack: false, rootVolume: false, volumes: [] });
    const result = harness.run(["--execute"], confirmation);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(harness.readState().mutations).toEqual(
      expect.arrayContaining(["iam:delete-key:AKIAOWNEDRUNTIMEKEY", "iam:delete-user"])
    );
    expect(harness.readState().mutations.some((entry) => entry.startsWith("cloudformation:delete-stack"))).toBe(false);
  }, 20_000);
});
