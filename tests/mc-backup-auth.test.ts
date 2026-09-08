import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve(process.cwd(), "infra/src/ec2/mc-backup-auth.py");
const cleanup: string[] = [];
const oldMaterial = Buffer.alloc(32, 1).toString("base64");
const newMaterial = Buffer.alloc(32, 2).toString("base64");
const utcSecond = (value: Date) => value.toISOString().replace(/\.\d{3}Z$/, "Z");
const offerIssuedAt = () => utcSecond(new Date(Date.now() - 60_000));
const offerExpiresAt = () => utcSecond(new Date(Date.now() + 23 * 60 * 60 * 1000));

const canonical = (value: unknown): string =>
  `${JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)));
  })}\n`;

const keyring = (rotated = false) => ({
  schemaVersion: 1,
  currentKeyId: rotated ? "key-new" : "key-old",
  keys: rotated
    ? [
        { keyId: "key-new", secretBase64: newMaterial, status: "active" },
        { keyId: "key-old", secretBase64: oldMaterial, status: "verify-only" },
      ]
    : [{ keyId: "key-old", secretBase64: oldMaterial, status: "active" }],
});

const createHarness = (withDynamo = false) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mc-backup-auth-"));
  cleanup.push(root);
  const bin = path.join(root, "bin");
  const remote = path.join(root, "remote");
  const server = path.join(root, "server");
  const archive = path.join(root, "backup.tar.gz");
  const manifest = `${archive}.manifest.json`;
  const keyringFile = path.join(root, "keyring.json");
  const serverIdFile = path.join(root, "server-id");
  const instanceIdFile = path.join(root, "instance-id");
  const generationState = path.join(root, "generation-state.json");
  const generationCloud = path.join(root, "generation-cloud");
  const floorState = path.join(root, "floor-state.json");
  const floorCloud = path.join(root, "floor-cloud");
  const capsule = path.join(root, "recovery-capsule.json");
  const transferAuthFile = path.join(root, "transfer-authorization.json");
  const transferOfferFile = path.join(root, "transfer-offer.json");
  const dynamoStateFile = path.join(root, "dynamodb.json");
  const migrationLockFile = path.join(root, "migration.lock");
  const rcloneConfig = path.join(root, "rclone.conf");
  mkdirSync(bin);
  mkdirSync(remote);
  mkdirSync(server);
  writeFileSync(path.join(server, "paper.jar"), "reviewed-paper-jar\n");
  writeFileSync(path.join(server, "world.dat"), "world\n");
  const tar = spawnSync("tar", ["-czf", archive, "-C", root, "server"], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  writeFileSync(keyringFile, JSON.stringify(keyring()));
  writeFileSync(serverIdFile, "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id\n");
  writeFileSync(instanceIdFile, "i-1234567890abcdef0\n");
  writeFileSync(generationCloud, "UNINITIALIZED\n");
  writeFileSync(floorCloud, "UNINITIALIZED\n");
  writeFileSync(dynamoStateFile, "{}\n");
  const aws = path.join(bin, "aws");
  writeFileSync(
    aws,
    `#!/usr/bin/env bash
 set -euo pipefail
 if [[ "\${1:-}" == "dynamodb" ]]; then
   command="\${2:-}"
   shift 2
    /usr/bin/python3 -c 'import sys, textwrap; exec(textwrap.dedent(sys.stdin.read()))' "$command" "$@" <<'PY'
 import json, os, sys
 from pathlib import Path
 command, *args = sys.argv[1:]
 state_path = Path(os.environ["TEST_DDB_STATE_FILE"])
 state = json.loads(state_path.read_text())
 def value(flag):
     return args[args.index(flag) + 1]
 def key(item):
     return item["operationId"]["S"]
 def fail():
     print("ConditionalCheckFailedException", file=sys.stderr)
     raise SystemExit(1)
 if command == "get-item":
     item = state.get(json.loads(value("--key"))["operationId"]["S"])
     print(json.dumps({"Item": item} if item else {}))
 elif command == "put-item":
     item = json.loads(value("--item"))
     if key(item) in state: fail()
     state[key(item)] = item
     state_path.write_text(json.dumps(state))
 elif command == "update-item":
     item_key = json.loads(value("--key"))["operationId"]["S"]
     current = state.get(item_key, {})
     condition = value("--condition-expression")
     if "attribute_not_exists" in condition:
         if current: fail()
     values = json.loads(value("--expression-attribute-values"))
     expected = values.get(":expected", {}).get("N")
     if expected is not None and current.get("version", {}).get("N") != expected and current:
         fail()
     attrs = json.loads(value("--expression-attribute-values"))
     if not current:
         current = {"operationId": {"S": item_key}}
     current.update({"payload": attrs[":payload"], "version": attrs[":next"]})
     current["kind"] = attrs.get(":kind", {"S": "restore-floor"})
     state[item_key] = current
     state_path.write_text(json.dumps(state))
 elif command == "transact-write-items":
     actions = json.loads(value("--transact-items"))
     next_state = json.loads(json.dumps(state))
     for action in actions:
         if "Put" in action:
             put = action["Put"]
             item = put["Item"]
             if key(item) in next_state: fail()
             next_state[key(item)] = item
         else:
             update = action["Update"]
             item_key = update["Key"]["operationId"]["S"]
             current = next_state.get(item_key)
             values = update.get("ExpressionAttributeValues", {})
             if current is None: fail()
             if ":expected" in values:
                 expected = values[":expected"]["N"]
                 if item_key == "mc-aws-restore-generation-floor" and current.get("version", {}).get("N") != expected:
                     fail()
                 if item_key != "mc-aws-restore-generation-floor" and current.get("floorVersion", {}).get("N") != expected:
                     fail()
             if ":reserved" in values and (current.get("status", {}).get("S") != values[":reserved"]["S"]):
                 fail()
             current.update({
                 "status": values.get(":consumed", current.get("status")),
                 "committedFloorGeneration": values.get(":floorGeneration"),
                 "committedFloorBackupId": values.get(":floorBackupId"),
                 "consumedAt": values.get(":now"),
             })
             if item_key == "mc-aws-restore-generation-floor":
                 current.update({"payload": values[":payload"], "version": values[":next"], "kind": values[":kind"]})
             next_state[item_key] = current
     state_path.write_text(json.dumps(next_state))
 else:
     raise SystemExit(2)
PY
   exit $?
 fi
 if [[ "\${4:-}" == *"backup-auth-keyring"* ]]; then
  /bin/cat "$TEST_KEYRING_FILE"
 elif [[ "\${4:-}" == *"backup-server-identity"* ]]; then
  /bin/cat "$TEST_SERVER_ID_FILE"
 elif [[ "\${4:-}" == *"backup-transfer-authorization"* ]]; then
   /bin/cat "$MC_BACKUP_TRANSFER_AUTH_FILE"
 elif [[ "\${1:-}" == "ssm" ]]; then
   /bin/cat "$TEST_SERVER_ID_FILE"
 else
  exit 2
fi
`
  );
  chmodSync(aws, 0o755);
  const rclone = path.join(bin, "rclone");
  writeFileSync(
    rclone,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "cat" ]]
name="\${2##*/}"
[[ "\${TEST_RCLONE_FAIL_NAME:-}" != "$name" ]]
/bin/cat "$TEST_REMOTE_DIR/$name"
`
  );
  chmodSync(rclone, 0o755);
  writeFileSync(rcloneConfig, "[test]\ntype = local\n");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MC_BACKUP_AUTH_AWS_CLI: aws,
    TEST_KEYRING_FILE: keyringFile,
    TEST_SERVER_ID_FILE: serverIdFile,
    MC_BACKUP_INSTANCE_ID_FILE: instanceIdFile,
    MC_BACKUP_TRANSFER_AUTH_FILE: transferAuthFile,
    MC_BACKUP_GENERATION_CLOUD_FILE: generationCloud,
    MC_RESTORE_FLOOR_CLOUD_FILE: floorCloud,
    MC_BACKUP_MIGRATION_LOCK_FILE: migrationLockFile,
    ...(withDynamo ? { MC_OPERATION_STATE_TABLE_NAME: "operations-table", TEST_DDB_STATE_FILE: dynamoStateFile } : {}),
    TEST_REMOTE_DIR: remote,
  };
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync("python3", [helper, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const create = (operationKey?: string) =>
    run([
      "create",
      "--archive",
      archive,
      "--manifest",
      manifest,
      "--archive-name",
      "backup.tar.gz",
      "--backup-name",
      "backup",
      "--backup-id",
      "a".repeat(32),
      "--created-at",
      "2026-09-04T00:00:00Z",
      "--generation",
      "7",
      ...(operationKey ? ["--operation-key", operationKey] : []),
    ]);
  const verify = (extra: string[] = []) =>
    run(["verify", "--archive", archive, "--manifest", manifest, "--archive-name", "backup.tar.gz", ...extra]);
  return {
    archive,
    manifest,
    remote,
    rclone,
    rcloneConfig,
    keyringFile,
    serverIdFile,
    generationState,
    generationCloud,
    instanceIdFile,
    floorState,
    floorCloud,
    capsule,
    transferAuthFile,
    transferOfferFile,
    dynamoStateFile,
    migrationLockFile,
    create,
    verify,
    run,
  };
};

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("detached Drive backup authentication", () => {
  it("creates a canonical exact-bound manifest and verifies a valid restore", () => {
    const harness = createHarness();
    const created = harness.create();
    expect(created.status, created.stderr).toBe(0);
    const result = harness.verify(["--expected-backup-id", "a".repeat(32)]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${"a".repeat(32)}\t2026-09-04T00:00:00Z\tkey-old\t7\tbackup.tar.gz`);
    const raw = readFileSync(harness.manifest, "utf8");
    expect(raw).toBe(canonical(JSON.parse(raw)));
    expect(raw).toContain('"format":"mc-aws-drive-backup"');
    expect(raw).not.toContain(oldMaterial);
  });

  it("streams and authenticates an exact operation-bound remote backup", () => {
    const harness = createHarness();
    const operationKey = "c".repeat(64);
    const created = harness.create(operationKey);
    expect(created.status, created.stderr).toBe(0);
    copyFileSync(harness.archive, path.join(harness.remote, "backup.tar.gz"));
    copyFileSync(harness.manifest, path.join(harness.remote, "backup.tar.gz.manifest.json"));
    const args = [
      "remote-verify",
      "--remote",
      "test",
      "--root",
      "backups",
      "--config",
      harness.rcloneConfig,
      "--rclone",
      harness.rclone,
      "--archive-name",
      "backup.tar.gz",
      "--expected-backup-id",
      "a".repeat(32),
      "--expected-generation",
      "7",
      "--expected-operation-key",
      operationKey,
      "--output",
      "json",
    ];

    const verified = harness.run(args);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ backupId: "a".repeat(32), operationKey });
    expect(harness.run(args.with(args.indexOf(operationKey), "d".repeat(64))).status).not.toBe(0);
  });

  it("rejects malformed, oversized, and unreadable remote manifests", () => {
    const harness = createHarness();
    expect(harness.create().status).toBe(0);
    copyFileSync(harness.archive, path.join(harness.remote, "backup.tar.gz"));
    const remoteManifest = path.join(harness.remote, "backup.tar.gz.manifest.json");
    const args = [
      "remote-verify",
      "--remote",
      "test",
      "--root",
      "backups",
      "--config",
      harness.rcloneConfig,
      "--rclone",
      harness.rclone,
      "--archive-name",
      "backup.tar.gz",
    ];

    writeFileSync(remoteManifest, "not-json\n");
    expect(harness.run(args).status).not.toBe(0);
    writeFileSync(remoteManifest, Buffer.alloc(16 * 1024 + 1, "x"));
    expect(harness.run(args).status).not.toBe(0);
    copyFileSync(harness.manifest, remoteManifest);
    expect(harness.run(args, { TEST_RCLONE_FAIL_NAME: "backup.tar.gz.manifest.json" }).status).not.toBe(0);
  });

  it.each([
    ["archive/JAR tamper", (h: ReturnType<typeof createHarness>) => writeFileSync(h.archive, "tampered-paper.jar")],
    [
      "manifest tamper",
      (h: ReturnType<typeof createHarness>) => {
        const value = JSON.parse(readFileSync(h.manifest, "utf8"));
        value.backup.createdAt = "2026-09-03T12:00:00Z";
        writeFileSync(h.manifest, canonical(value));
      },
    ],
    [
      "missing signature",
      (h: ReturnType<typeof createHarness>) => {
        const value = JSON.parse(readFileSync(h.manifest, "utf8"));
        const { authentication: _authentication, ...unsigned } = value;
        writeFileSync(h.manifest, canonical(unsigned));
      },
    ],
    [
      "unknown key",
      (h: ReturnType<typeof createHarness>) => {
        const value = JSON.parse(readFileSync(h.manifest, "utf8"));
        value.authentication.keyId = "retired-key";
        writeFileSync(h.manifest, canonical(value));
      },
    ],
  ])("rejects %s before archive use", (_case, mutate) => {
    const harness = createHarness();
    const created = harness.create();
    expect(created.status, created.stderr).toBe(0);
    mutate(harness);
    expect(harness.verify().status).not.toBe(0);
  });

  it("rejects swapped names, backup-ID replay, and cross-server manifests", () => {
    const harness = createHarness();
    const created = harness.create();
    expect(created.status, created.stderr).toBe(0);
    expect(
      harness.run([
        "verify",
        "--archive",
        harness.archive,
        "--manifest",
        harness.manifest,
        "--archive-name",
        "other.tar.gz",
      ]).status
    ).not.toBe(0);
    expect(harness.verify(["--expected-backup-id", "b".repeat(32)]).status).not.toBe(0);
    writeFileSync(harness.serverIdFile, "arn:aws:cloudformation:us-west-1:111111111111:stack/Other/stable-id\n");
    expect(harness.verify().status).not.toBe(0);
  });

  it("accepts a verify-only rotation key while signing new backups only with the active key", () => {
    const oldBackup = createHarness();
    const oldCreated = oldBackup.create();
    expect(oldCreated.status, oldCreated.stderr).toBe(0);
    writeFileSync(oldBackup.keyringFile, JSON.stringify(keyring(true)));
    expect(oldBackup.verify().status).toBe(0);

    const newBackup = createHarness();
    writeFileSync(newBackup.keyringFile, JSON.stringify(keyring(true)));
    const newCreated = newBackup.create();
    expect(newCreated.status, newCreated.stderr).toBe(0);
    expect(JSON.parse(readFileSync(newBackup.manifest, "utf8")).authentication.keyId).toBe("key-new");
  });

  it("allocates authenticated monotonic generations and heals a lost durable replica across key rotation", () => {
    const harness = createHarness();
    const allocate = (backupId: string) =>
      harness.run([
        "checkpoint-allocate",
        "--state-file",
        harness.generationState,
        "--backup-id",
        backupId,
        "--updated-at",
        "2026-09-04T00:00:00Z",
      ]);

    expect(allocate("1".repeat(32)).stdout.trim()).toBe("1");
    rmSync(harness.generationState);
    writeFileSync(harness.keyringFile, JSON.stringify(keyring(true)));
    expect(allocate("2".repeat(32)).stdout.trim()).toBe("2");
    expect(existsSync(harness.generationState)).toBe(true);
    expect(JSON.parse(readFileSync(harness.generationCloud, "utf8")).authentication.keyId).toBe("key-new");
  });

  it("refuses a checkpoint mutation while another recovery writer owns the migration lock", () => {
    const harness = createHarness();
    writeFileSync(harness.migrationLockFile, "foreign-owner\n");
    const result = harness.run([
      "checkpoint-allocate",
      "--state-file",
      harness.generationState,
      "--backup-id",
      "3".repeat(32),
      "--updated-at",
      "2026-09-04T00:00:00Z",
    ]);
    expect(result.status).not.toBe(0);
    expect(existsSync(harness.generationState)).toBe(false);
  });

  it("persists and recovers the authenticated restore floor, but fails closed if both replicas are lost", () => {
    const harness = createHarness();
    const commit = harness.run([
      "floor-commit",
      "--state-file",
      harness.floorState,
      "--generation",
      "9",
      "--backup-id",
      "9".repeat(32),
      "--updated-at",
      offerIssuedAt(),
    ]);
    expect(commit.status, commit.stderr).toBe(0);

    rmSync(harness.floorState);
    const recoveredLocal = harness.run(["floor-read", "--state-file", harness.floorState]);
    expect(recoveredLocal.stdout.trim()).toBe(`9\t${"9".repeat(32)}`);
    expect(existsSync(harness.floorState)).toBe(true);

    rmSync(harness.floorCloud, { force: true });
    const recoveredCloud = harness.run(["floor-read", "--state-file", harness.floorState]);
    expect(recoveredCloud.status, recoveredCloud.stderr).toBe(0);
    expect(existsSync(harness.floorCloud)).toBe(false);

    rmSync(harness.floorState);
    rmSync(harness.floorCloud, { force: true });
    expect(harness.run(["floor-read", "--state-file", harness.floorState]).status).not.toBe(0);
  });

  it("rejects restore-floor downgrade and conflicting replay while permitting exact committed recovery", () => {
    const harness = createHarness();
    const commit = (generation: number, backupId: string) =>
      harness.run([
        "floor-commit",
        "--state-file",
        harness.floorState,
        "--generation",
        String(generation),
        "--backup-id",
        backupId,
        "--updated-at",
        "2026-09-04T00:00:00Z",
      ]);
    expect(commit(5, "5".repeat(32)).status).toBe(0);
    expect(commit(5, "5".repeat(32)).status).toBe(0);
    expect(commit(5, "6".repeat(32)).status).not.toBe(0);
    expect(commit(4, "4".repeat(32)).status).not.toBe(0);
  });

  it("imports the newest authenticated floor/checkpoint replicas into DynamoDB with provenance", () => {
    const source = createHarness();
    expect(
      source.run([
        "checkpoint-allocate",
        "--state-file",
        source.generationState,
        "--backup-id",
        "1".repeat(32),
        "--updated-at",
        "2026-09-04T00:00:00Z",
      ]).status
    ).toBe(0);
    expect(
      source.run([
        "floor-commit",
        "--state-file",
        source.floorState,
        "--generation",
        "1",
        "--backup-id",
        "1".repeat(32),
        "--updated-at",
        "2026-09-04T00:00:00Z",
      ]).status
    ).toBe(0);
    const harness = createHarness(true);
    copyFileSync(source.floorState, harness.floorState);
    copyFileSync(source.floorCloud, harness.floorCloud);
    copyFileSync(source.generationState, harness.generationState);
    copyFileSync(source.generationCloud, harness.generationCloud);

    const read = harness.run(["floor-read", "--state-file", harness.floorState], {
      MC_BACKUP_GENERATION_STATE: harness.generationState,
    });
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout.trim()).toBe(`1\t${"1".repeat(32)}`);
    const record = JSON.parse(readFileSync(harness.dynamoStateFile, "utf8"))["mc-aws-restore-generation-floor"];
    expect(JSON.parse(record.provenance.S)).toMatchObject({
      floorSources: ["local", "ssm"],
      checkpointSources: ["local", "ssm"],
      selectedFloorSource: "local",
    });
  });

  it("exports and inspects one authenticated recovery capsule with checkpoint/floor continuity", () => {
    const harness = createHarness();
    expect(
      harness.run([
        "checkpoint-allocate",
        "--state-file",
        harness.generationState,
        "--backup-id",
        "7".repeat(32),
        "--updated-at",
        "2026-09-04T00:00:00Z",
      ]).status
    ).toBe(0);
    expect(
      harness.run([
        "floor-commit",
        "--state-file",
        harness.floorState,
        "--generation",
        "1",
        "--backup-id",
        "1".repeat(32),
        "--updated-at",
        "2026-09-04T00:00:00Z",
      ]).status
    ).toBe(0);
    const exported = harness.run([
      "capsule-export",
      "--output",
      harness.capsule,
      "--checkpoint-state",
      harness.generationState,
      "--floor-state",
      harness.floorState,
    ]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(readFileSync(harness.capsule, "utf8")).not.toContain("Backup authentication failed");
    const capsule = JSON.parse(readFileSync(harness.capsule, "utf8"));
    expect(capsule.schemaVersion).toBe(3);
    expect(JSON.parse(capsule.checkpoint).schemaVersion).toBe(3);
    expect(JSON.parse(capsule.restoreFloor).schemaVersion).toBe(3);
    expect(capsule.verifier).toMatchObject({ manifestSchemaVersion: 3, stateSchemaVersion: 3 });
    const inspected = harness.run(["capsule-inspect", "--capsule", harness.capsule]);
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(inspected.stdout.trim()).toMatch(
      /^arn:aws:cloudformation:us-west-1:111111111111:stack\/MinecraftStack\/stable-id\t1\t1\tkey-old\t[a-f0-9]{64}$/
    );
  });

  it("binds a one-time replacement transfer to old->new, the exact backup, fence, and floor", () => {
    const harness = createHarness();
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const offerResult = harness.run([
      "transfer-create",
      "--operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--backup-id",
      "a".repeat(32),
      "--generation",
      "7",
      "--floor-generation",
      "0",
      "--floor-backup-id",
      "",
      "--lock-id",
      "lock-replacement",
      "--fencing-token",
      "4",
      "--lease-generation",
      "2",
      "--issued-at",
      offerIssuedAt(),
      "--expires-at",
      offerExpiresAt(),
    ]);
    expect(offerResult.status, offerResult.stderr).toBe(0);
    const offer = JSON.parse(offerResult.stdout);
    const target = { accountId: "111111111111", instanceId: "i-abcdef1234567890" };
    const payload = {
      format: "mc-aws-backup-transfer",
      lifecycle: { fencingToken: 5, leaseGeneration: 1, lockId: "lock-takeover" },
      operationId,
      offer,
      schemaVersion: 1,
      target,
    };
    const delegatedKey = Buffer.from(offer.delegation.keyBase64, "base64");
    writeFileSync(
      harness.transferAuthFile,
      canonical({
        ...payload,
        authentication: {
          algorithm: "HMAC-SHA256",
          keyId: "transfer-delegated",
          tag: createHmac("sha256", delegatedKey).update(canonical(payload).trim()).digest("hex"),
        },
      })
    );
    writeFileSync(harness.instanceIdFile, `${target.instanceId}\n`);
    const consumed = harness.run([
      "transfer-consume",
      "--expected-operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--expected-backup-id",
      "a".repeat(32),
      "--expected-generation",
      "7",
      "--expected-source-instance-id",
      "i-1234567890abcdef0",
      "--expected-lock-id",
      "lock-takeover",
      "--expected-fencing-token",
      "5",
      "--expected-lease-generation",
      "1",
      "--floor-state",
      harness.floorState,
    ]);
    expect(consumed.status, consumed.stderr).toBe(0);
    expect(consumed.stdout).toContain("i-abcdef1234567890");
    expect(() => readFileSync(harness.transferAuthFile)).toThrow();
    expect(
      harness.run([
        "transfer-consume",
        "--expected-operation-id",
        operationId,
        "--archive-name",
        "backup.tar.gz",
        "--expected-backup-id",
        "a".repeat(32),
        "--expected-generation",
        "7",
        "--expected-source-instance-id",
        "i-1234567890abcdef0",
        "--expected-lock-id",
        "lock-takeover",
        "--expected-fencing-token",
        "5",
        "--expected-lease-generation",
        "1",
        "--floor-state",
        harness.floorState,
      ]).status
    ).not.toBe(0);
  });

  it("keeps a reserved transfer retryable for the same operation, then consumes it atomically with the floor", () => {
    const harness = createHarness(true);
    const operationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const offerResult = harness.run([
      "transfer-create",
      "--operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--backup-id",
      "a".repeat(32),
      "--generation",
      "7",
      "--floor-generation",
      "0",
      "--floor-backup-id",
      "",
      "--lock-id",
      "lock-replacement",
      "--fencing-token",
      "4",
      "--lease-generation",
      "2",
      "--issued-at",
      offerIssuedAt(),
      "--expires-at",
      offerExpiresAt(),
    ]);
    expect(offerResult.status, offerResult.stderr).toBe(0);
    const offer = JSON.parse(offerResult.stdout);
    const target = { accountId: "111111111111", instanceId: "i-abcdef1234567890" };
    const payload = {
      format: "mc-aws-backup-transfer",
      lifecycle: offer.lifecycle,
      operationId,
      offer,
      schemaVersion: 1,
      target,
    };
    writeFileSync(
      harness.transferAuthFile,
      canonical({
        ...payload,
        authentication: {
          algorithm: "HMAC-SHA256",
          keyId: "transfer-delegated",
          tag: createHmac("sha256", Buffer.from(offer.delegation.keyBase64, "base64"))
            .update(canonical(payload).trim())
            .digest("hex"),
        },
      })
    );
    writeFileSync(harness.instanceIdFile, `${target.instanceId}\n`);
    const consumeArgs = [
      "transfer-consume",
      "--expected-operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--expected-backup-id",
      "a".repeat(32),
      "--expected-generation",
      "7",
      "--expected-source-instance-id",
      "i-1234567890abcdef0",
      "--expected-lock-id",
      "lock-replacement",
      "--expected-fencing-token",
      "4",
      "--expected-lease-generation",
      "2",
      "--floor-state",
      harness.floorState,
    ];
    const firstConsume = harness.run(consumeArgs);
    expect(firstConsume.status, firstConsume.stderr).toBe(0);
    const retryConsume = harness.run(consumeArgs);
    expect(retryConsume.status, retryConsume.stderr).toBe(0);
    const differentOwnerArgs = consumeArgs.with(
      consumeArgs.indexOf(operationId),
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    );
    expect(harness.run(differentOwnerArgs).status).not.toBe(0);

    const floorCommit = harness.run([
      "floor-commit",
      "--state-file",
      harness.floorState,
      "--generation",
      "8",
      "--backup-id",
      "8".repeat(32),
      "--updated-at",
      offerIssuedAt(),
      "--transfer-id",
      offer.validity.transferId,
    ]);
    expect(floorCommit.status, floorCommit.stderr).toBe(0);
    expect(harness.run(consumeArgs).status).not.toBe(0);
  });

  it("rejects an arbitrary replacement host and wrong exact backup/account before consuming a transfer", () => {
    const harness = createHarness();
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const offerResult = harness.run([
      "transfer-create",
      "--operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--backup-id",
      "a".repeat(32),
      "--generation",
      "7",
      "--floor-generation",
      "0",
      "--floor-backup-id",
      "",
      "--lock-id",
      "lock-replacement",
      "--fencing-token",
      "4",
      "--lease-generation",
      "2",
      "--issued-at",
      offerIssuedAt(),
      "--expires-at",
      offerExpiresAt(),
    ]);
    const offer = JSON.parse(offerResult.stdout);
    const target = { accountId: "111111111111", instanceId: "i-abcdef1234567890" };
    const payload = {
      format: "mc-aws-backup-transfer",
      lifecycle: { fencingToken: 4, leaseGeneration: 2, lockId: "lock-replacement" },
      operationId,
      offer,
      schemaVersion: 1,
      target,
    };
    writeFileSync(
      harness.transferAuthFile,
      canonical({
        ...payload,
        authentication: {
          algorithm: "HMAC-SHA256",
          keyId: "transfer-delegated",
          tag: createHmac("sha256", Buffer.from(offer.delegation.keyBase64, "base64"))
            .update(canonical(payload).trim())
            .digest("hex"),
        },
      })
    );
    writeFileSync(harness.instanceIdFile, "i-99999999999999999\n");
    const rejectedHost = harness.run([
      "transfer-consume",
      "--expected-operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--expected-backup-id",
      "a".repeat(32),
      "--expected-generation",
      "7",
      "--expected-source-instance-id",
      "i-1234567890abcdef0",
      "--expected-lock-id",
      "lock-replacement",
      "--expected-fencing-token",
      "4",
      "--expected-lease-generation",
      "2",
      "--floor-state",
      harness.floorState,
    ]);
    expect(rejectedHost.status).not.toBe(0);
    expect(existsSync(harness.transferAuthFile)).toBe(true);
    writeFileSync(harness.instanceIdFile, "i-abcdef1234567890\n");
    expect(
      harness.run([
        "transfer-consume",
        "--expected-operation-id",
        operationId,
        "--archive-name",
        "other.tar.gz",
        "--expected-backup-id",
        "a".repeat(32),
        "--expected-generation",
        "7",
        "--expected-source-instance-id",
        "i-1234567890abcdef0",
        "--expected-lock-id",
        "lock-replacement",
        "--expected-fencing-token",
        "4",
        "--expected-lease-generation",
        "2",
        "--floor-state",
        harness.floorState,
      ]).status
    ).not.toBe(0);
    expect(existsSync(harness.transferAuthFile)).toBe(true);
    const wrongAccount = JSON.parse(readFileSync(harness.transferAuthFile, "utf8"));
    wrongAccount.target.accountId = "222222222222";
    writeFileSync(harness.transferAuthFile, canonical(wrongAccount));
    expect(
      harness.run([
        "transfer-consume",
        "--expected-operation-id",
        operationId,
        "--archive-name",
        "backup.tar.gz",
        "--expected-backup-id",
        "a".repeat(32),
        "--expected-generation",
        "7",
        "--expected-source-instance-id",
        "i-1234567890abcdef0",
        "--expected-lock-id",
        "lock-replacement",
        "--expected-fencing-token",
        "4",
        "--expected-lease-generation",
        "2",
        "--floor-state",
        harness.floorState,
      ]).status
    ).not.toBe(0);
  });

  it("renews an expired source offer beyond 24 hours with adopted authority without weakening consume freshness", () => {
    const harness = createHarness(true);
    const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 60 * 60 * 1000);
    const timestamp = (value: Date) => value.toISOString().replace(/\.\d{3}Z$/, "Z");
    const offerResult = harness.run([
      "transfer-create",
      "--operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--backup-id",
      "a".repeat(32),
      "--generation",
      "7",
      "--floor-generation",
      "0",
      "--floor-backup-id",
      "",
      "--lock-id",
      "lock-source",
      "--fencing-token",
      "4",
      "--lease-generation",
      "2",
      "--issued-at",
      timestamp(issuedAt),
      "--expires-at",
      timestamp(expiresAt),
    ]);
    expect(offerResult.status, offerResult.stderr).toBe(0);
    const expired = JSON.parse(offerResult.stdout) as Record<string, unknown> & {
      authentication: unknown;
      delegation: { keyBase64: string };
      validity: { expiresAt: string; issuedAt: string; transferId: string };
    };
    const { authentication: _authentication, ...expiredPayload } = expired;
    expiredPayload.validity = {
      expiresAt: "2026-09-04T01:00:00Z",
      issuedAt: "2026-09-04T00:00:00Z",
      transferId: "c".repeat(32),
    };
    const signedExpiredOffer = {
      ...expiredPayload,
      authentication: {
        algorithm: "HMAC-SHA256",
        keyId: "key-old",
        tag: createHmac("sha256", Buffer.alloc(32, 1)).update(canonical(expiredPayload).trim()).digest("hex"),
      },
    };
    writeFileSync(harness.transferOfferFile, canonical(signedExpiredOffer));

    const target = { accountId: "111111111111", instanceId: "i-abcdef1234567890" };
    const transferPayload = {
      format: "mc-aws-backup-transfer",
      lifecycle: expired.lifecycle,
      operationId,
      offer: signedExpiredOffer,
      schemaVersion: 1,
      target,
    };
    writeFileSync(
      harness.transferAuthFile,
      canonical({
        ...transferPayload,
        authentication: {
          algorithm: "HMAC-SHA256",
          keyId: "transfer-delegated",
          tag: createHmac("sha256", Buffer.from(expiredPayload.delegation.keyBase64, "base64"))
            .update(canonical(transferPayload).trim())
            .digest("hex"),
        },
      })
    );
    writeFileSync(harness.instanceIdFile, `${target.instanceId}\n`);
    const strictExpiredConsume = harness.run([
      "transfer-consume",
      "--expected-operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--expected-backup-id",
      "a".repeat(32),
      "--expected-generation",
      "7",
      "--expected-source-instance-id",
      "i-1234567890abcdef0",
      "--expected-lock-id",
      "lock-source",
      "--expected-fencing-token",
      "4",
      "--expected-lease-generation",
      "2",
      "--floor-state",
      harness.floorState,
    ]);
    expect(strictExpiredConsume.status).not.toBe(0);
    expect(existsSync(harness.transferAuthFile)).toBe(true);

    // The source instance is gone. Renewal uses only the retained/adopted
    // keyring and a freshly rebound lifecycle envelope, then re-signs with
    // its current active key.
    const renewalLifecycle = { fencingToken: 9, leaseGeneration: 10, lockId: "lock-adopted" };
    const renewalAuthorizationPayload = { ...transferPayload, lifecycle: renewalLifecycle };
    writeFileSync(
      harness.transferAuthFile,
      canonical({
        ...renewalAuthorizationPayload,
        authentication: {
          algorithm: "HMAC-SHA256",
          keyId: "transfer-delegated",
          tag: createHmac("sha256", Buffer.from(expiredPayload.delegation.keyBase64, "base64"))
            .update(canonical(renewalAuthorizationPayload).trim())
            .digest("hex"),
        },
      })
    );
    writeFileSync(harness.instanceIdFile, `${target.instanceId}\n`);
    writeFileSync(harness.keyringFile, JSON.stringify(keyring(true)));
    const renewedIssuedAt = new Date();
    const renewedExpiresAt = new Date(renewedIssuedAt.getTime() + 23 * 60 * 60 * 1000);
    const renewalArguments = [
      "transfer-renew",
      "--authorization-parameter",
      "/minecraft/backup-transfer-authorization",
      "--operation-id",
      operationId,
      "--archive-name",
      "backup.tar.gz",
      "--backup-id",
      "a".repeat(32),
      "--generation",
      "7",
      "--floor-generation",
      "0",
      "--floor-backup-id",
      "",
      "--lock-id",
      "lock-adopted",
      "--fencing-token",
      "9",
      "--lease-generation",
      "10",
      "--issued-at",
      timestamp(renewedIssuedAt),
      "--expires-at",
      timestamp(renewedExpiresAt),
    ];
    const renewed = harness.run(renewalArguments);
    expect(renewed.status, renewed.stderr).toBe(0);
    const renewedOffer = JSON.parse(renewed.stdout);
    expect(renewedOffer.authentication.keyId).toBe("key-new");
    expect(renewedOffer.source).toEqual(expired.source);
    expect(renewedOffer.backup).toEqual(expired.backup);
    expect(renewedOffer.restoreFloor).toEqual(expired.restoreFloor);
    expect(renewedOffer.operationId).toBe(expired.operationId);
    expect(renewedOffer.lifecycle).toEqual(renewalLifecycle);
    expect(renewedOffer.validity.expiresAt).toBe(timestamp(renewedExpiresAt));
    expect(renewedOffer.validity.transferId).not.toBe(expired.validity.transferId);
    expect(renewedOffer.delegation.keyBase64).not.toBe(expired.delegation.keyBase64);
    expect(existsSync(harness.transferAuthFile)).toBe(true);
    const retried = harness.run(renewalArguments);
    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.stdout).toBe(renewed.stdout);
    const renewalState = JSON.parse(readFileSync(harness.dynamoStateFile, "utf8"));
    renewalState[`backup-transfer-renewal-${signedExpiredOffer.validity.transferId}`].authorizationOwner.S =
      "other-operation";
    writeFileSync(harness.dynamoStateFile, JSON.stringify(renewalState));
    expect(harness.run(renewalArguments).status).not.toBe(0);
  });
});
