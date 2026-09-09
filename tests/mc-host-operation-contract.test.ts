import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve(process.cwd(), "infra/src/ec2/mc-host-operation.py");
const contract = path.resolve(process.cwd(), "infra/src/ec2/host-operation-contract.json");
const roots: string[] = [];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function mac(key: Buffer, domain: string, value: Record<string, unknown>, version = 3): string {
  const { mac: _mac, ...unsigned } = value;
  return createHmac("sha256", key)
    .update(`mc-aws-executor-journal:${domain}:v${version}\n${canonical(unsigned)}`)
    .digest("base64url");
}

function run(
  root: string,
  journal: Record<string, unknown> | undefined,
  key: Buffer,
  options: {
    handoffState?: "auto" | "never-used" | "durable";
    checkpointSequence?: number;
    gateway?: Record<string, unknown>;
    checkpoint?: Record<string, unknown>;
    checkpointOne?: Record<string, unknown>;
    floor?: Record<string, unknown>;
    omitAppend?: boolean;
    preserveAppend?: boolean;
    appendContent?: string | Buffer;
  } = {}
) {
  const journalPath = path.join(root, "executor-effect-journal.json");
  const keyPath = path.join(root, "executor-journal-hmac.key");
  if (journal) writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  const gatewayPath = path.join(root, "executor-reconciliations.json");
  if (options.gateway) writeFileSync(gatewayPath, `${JSON.stringify(options.gateway)}\n`);
  if (options.checkpoint) writeFileSync(`${journalPath}.checkpoint.0`, `${JSON.stringify(options.checkpoint)}\n`);
  if (options.checkpointOne) writeFileSync(`${journalPath}.checkpoint.1`, `${JSON.stringify(options.checkpointOne)}\n`);
  if (journal && !options.omitAppend && !options.preserveAppend)
    writeFileSync(`${journalPath}.append.${String(journal.appendSlot)}`, options.appendContent ?? "", { mode: 0o600 });
  if (options.floor) writeFileSync(`${journalPath}.generation-floor`, `${JSON.stringify(options.floor)}\n`);
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, key, { mode: 0o400 });
    chmodSync(keyPath, 0o400);
  }
  return spawnSync(
    "python3",
    [
      helper,
      "--contract",
      contract,
      "executor-idle",
      "--journal",
      journalPath,
      "--credential",
      keyPath,
      "--gateway-journal",
      gatewayPath,
      "--handoff-state",
      options.handoffState ?? "auto",
      "--checkpoint-sequence",
      String(options.checkpointSequence ?? 0),
    ],
    {
      encoding: "utf8",
    }
  );
}

function scanReceiptReferences(root: string, keyId = "executor-receipt-test", keyEpoch = 1) {
  return spawnSync(
    "python3",
    [
      helper,
      "--contract",
      contract,
      "executor-receipt-references",
      "--journal",
      path.join(root, "executor-effect-journal.json"),
      "--credential",
      path.join(root, "executor-journal-hmac.key"),
      "--gateway-journal",
      path.join(root, "executor-reconciliations.json"),
      "--key-id",
      keyId,
      "--key-epoch",
      String(keyEpoch),
    ],
    { encoding: "utf8" }
  );
}

function toolResult(invocationId: string, status: "succeeded" | "failed" | "indeterminate" = "failed") {
  return {
    schemaVersion: 1,
    invocationId,
    status,
    completedAt: "2026-09-04T00:00:00.000Z",
    summary: "Authenticated fixture result.",
    output: {},
    evidence: [],
    ...(status === "indeterminate"
      ? {}
      : status === "succeeded"
        ? { mutationCommit: { committed: true, point: "atomic-rename" } }
        : { mutationCommit: { committed: false } }),
  };
}

function makeV3Journal(key: Buffer, recordSequence = 1) {
  const entry: Record<string, unknown> = {
    schemaVersion: 3,
    recordSequence,
    invocationId: "invocation-fixture",
    invocationDigest: "a".repeat(64),
    effectFingerprint: "b".repeat(64),
    status: "committed",
    updatedAt: "2026-09-04T00:00:00.000Z",
    result: toolResult("invocation-fixture"),
    mac: "",
  };
  entry.mac = mac(key, "entry", entry);
  const checkpoint: Record<string, unknown> = {
    schemaVersion: 3,
    format: "manifest-checkpoint-transaction-v1",
    generation: 1,
    entries: [entry],
    cancellationTombstones: [],
    evidence: [],
    mac: "",
  };
  checkpoint.mac = mac(key, "checkpoint", checkpoint);
  const journal: Record<string, unknown> = {
    schemaVersion: 3,
    format: "manifest-checkpoint-transaction-v1",
    generation: 1,
    checkpointGeneration: 1,
    appendGeneration: 1,
    generationFloor: 1,
    checkpointSlot: 0,
    appendSlot: 0,
    mac: "",
  };
  journal.mac = mac(key, "manifest", journal);
  const floor: Record<string, unknown> = { schemaVersion: 3, generationFloor: 1, mac: "" };
  floor.mac = mac(key, "floor", floor);
  return { journal, checkpoint, floor };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared host-operation contract", () => {
  it("reports a committed journal result without a terminal receipt as a retiring-key reference", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-receipt-scan-"));
    roots.push(root);
    const key = Buffer.alloc(32, 23);
    const fixture = makeV3Journal(key);
    writeFileSync(path.join(root, "executor-effect-journal.json"), `${JSON.stringify(fixture.journal)}\n`);
    writeFileSync(
      path.join(root, "executor-effect-journal.json.checkpoint.0"),
      `${JSON.stringify(fixture.checkpoint)}\n`
    );
    writeFileSync(path.join(root, "executor-effect-journal.json.append.0"), "", { mode: 0o600 });
    writeFileSync(
      path.join(root, "executor-effect-journal.json.generation-floor"),
      `${JSON.stringify(fixture.floor)}\n`
    );
    writeFileSync(path.join(root, "executor-journal-hmac.key"), key, { mode: 0o400 });
    const scanned = scanReceiptReferences(root);
    expect(scanned.status, scanned.stderr).toBe(0);
    expect(JSON.parse(scanned.stdout)).toEqual({
      references: [{ invocationId: "invocation-fixture", source: "executor-journal" }],
    });
  });

  it("accepts a normal authenticated production executor journal entry", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 7);
    const resultValue = toolResult("invocation-production", "succeeded");
    const entry: Record<string, unknown> = {
      schemaVersion: 3,
      recordSequence: 1,
      invocationId: "invocation-production",
      invocationDigest: "a".repeat(64),
      effectFingerprint: "b".repeat(64),
      taskId: "task-production",
      leaseGeneration: 3,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "e".repeat(64),
      executorEpoch: "epoch-production",
      status: "committed",
      updatedAt: "2026-09-04T00:00:00.000Z",
      result: resultValue,
      publicationAcknowledgement: {
        invocationId: "invocation-production",
        invocationDigest: "a".repeat(64),
        taskId: "task-production",
        leaseGeneration: 3,
        journalSequence: 1,
        resultDigest: createHash("sha256").update(canonical(resultValue)).digest("hex"),
        authorization: {
          schemaVersion: 1,
          source: "control-plane-terminal-publication",
          runtimeId: "runtime-production",
          sessionId: "session-production",
          taskId: "task-production",
          leaseId: "lease-production",
          leaseGeneration: 3,
          invocationId: "invocation-production",
          invocationDigest: "a".repeat(64),
          journalSequence: 1,
          resultDigest: createHash("sha256").update(canonical(resultValue)).digest("hex"),
          terminalReceiptDigest: "f".repeat(64),
          outcome: "committed",
          taskStatus: "completed",
          sessionStatus: "idle",
          publicationRevision: 9,
          publishedAt: "2026-09-04T00:00:00.500Z",
          signature: "A".repeat(86),
        },
        acknowledgedAt: "2026-09-04T00:00:01.000Z",
      },
      mac: "",
    };
    entry.mac = mac(key, "entry", entry);
    const checkpoint: Record<string, unknown> = {
      schemaVersion: 3,
      format: "manifest-checkpoint-transaction-v1",
      generation: 1,
      entries: [entry],
      cancellationTombstones: [],
      evidence: [],
      mac: "",
    };
    checkpoint.mac = mac(key, "checkpoint", checkpoint);
    const journal: Record<string, unknown> = {
      schemaVersion: 3,
      format: "manifest-checkpoint-transaction-v1",
      generation: 1,
      checkpointGeneration: 1,
      appendGeneration: 1,
      generationFloor: 1,
      checkpointSlot: 0,
      appendSlot: 0,
      mac: "",
    };
    journal.mac = mac(key, "manifest", journal);
    const floor: Record<string, unknown> = { schemaVersion: 3, generationFloor: 1, mac: "" };
    floor.mac = mac(key, "floor", floor);
    const result = run(root, journal, key, { checkpoint, floor });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("idle\t1\n");
  });

  it("accepts authenticated no-effect truth but blocks an unacknowledged committed effect", () => {
    const key = Buffer.alloc(32, 29);
    const noEffectRoot = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-no-effect-"));
    roots.push(noEffectRoot);
    const noEffect = makeV3Journal(key);
    const accepted = run(noEffectRoot, noEffect.journal, key, {
      checkpoint: noEffect.checkpoint,
      floor: noEffect.floor,
    });
    expect({ status: accepted.status, stderr: accepted.stderr, stdout: accepted.stdout }).toMatchObject({ status: 0 });

    const committedRoot = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-unpublished-"));
    roots.push(committedRoot);
    const committed = makeV3Journal(key);
    const entry = (committed.checkpoint.entries as Array<Record<string, unknown>>)[0]!;
    entry.result = toolResult("invocation-fixture", "succeeded");
    entry.mac = mac(key, "entry", entry);
    committed.checkpoint.mac = mac(key, "checkpoint", committed.checkpoint);
    const blocked = run(committedRoot, committed.journal, key, {
      checkpoint: committed.checkpoint,
      floor: committed.floor,
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/idle|publication|acknowledgement/i);
  });

  it("replays an authenticated transaction with the same Unicode and number canonical bytes as TypeScript", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 19);
    const fixture = makeV3Journal(key);
    const resultValue = {
      ...toolResult("invocation-unicode"),
      summary: "café 雪 😀",
      output: {
        "\uE000": "private-use",
        "😀": "snow 雪",
        é: "café",
        numbers: [-0, 1e-7, 1e-6, 1e20, 1e21],
      },
    };
    const entry: Record<string, unknown> = {
      schemaVersion: 3,
      recordSequence: 2,
      invocationId: "invocation-unicode",
      invocationDigest: "a".repeat(64),
      effectFingerprint: "b".repeat(64),
      taskId: "task-unicode",
      leaseGeneration: 1,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "e".repeat(64),
      status: "committed",
      updatedAt: "2026-09-04T00:00:00.000Z",
      result: resultValue,
      mac: "",
    };
    entry.mac = mac(key, "entry", entry);
    const transaction: Record<string, unknown> = {
      schemaVersion: 3,
      generation: 2,
      mutations: [
        {
          operation: "upsert-entry",
          key: "task-unicode:1:invocation-unicode",
          value: entry,
        },
      ],
      mac: "",
    };
    transaction.mac = mac(key, "transaction", transaction);
    const manifest = {
      ...fixture.journal,
      generation: 2,
      appendGeneration: 2,
    } as Record<string, unknown>;
    manifest.mac = mac(key, "manifest", manifest);

    const verified = run(root, manifest, key, {
      checkpoint: fixture.checkpoint,
      floor: fixture.floor,
      appendContent: `${canonical(transaction)}\n`,
    });
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toBe("idle\t2\n");
  });

  it.each(["invalid MAC", "replayed sequence"])("rejects %s before destroy trusts the journal", (kind) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 8);
    const fixture = makeV3Journal(key, kind === "replayed sequence" ? 2 : 1);
    if (kind === "invalid MAC") fixture.journal.mac = "A".repeat(43);
    const result = run(root, fixture.journal, key, { checkpoint: fixture.checkpoint, floor: fixture.floor });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/authentication|replayed|schema|sequence/i);
  });

  it("accepts a fresh host with no journal only with explicit never-used context", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const result = run(root, undefined, Buffer.alloc(32, 1), { handoffState: "never-used" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("idle\t0\tabsent-fresh\n");
  });

  it("rejects an orphaned schema-v3 sidecar when the manifest is absent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    writeFileSync(path.join(root, "executor-effect-journal.json.append.0"), "", { mode: 0o600 });
    const result = run(root, undefined, Buffer.alloc(32, 1), { handoffState: "never-used" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/sidecar|manifest/i);
  });

  it("rejects a missing executor journal after a durable gateway dispatch checkpoint", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const invocation = { sessionId: "session-dispatched", invocationId: "invocation-dispatched" };
    const result = run(root, undefined, Buffer.alloc(32, 2), {
      checkpointSequence: 1,
      gateway: {
        schemaVersion: 1,
        entries: [
          {
            schemaVersion: 1,
            key: "runtime-production:task-dispatched:lease-dispatched:1:invocation-dispatched",
            runtimeId: "runtime-production",
            sessionId: "session-dispatched",
            taskId: "task-dispatched",
            leaseId: "lease-dispatched",
            leaseGeneration: 1,
            invocationId: "invocation-dispatched",
            invocationDigest: createHash("sha256").update(canonical(invocation)).digest("hex"),
            state: "dispatching",
            payload: {
              invocation,
              runtimeContext: {
                runtimeId: "runtime-production",
                taskId: "task-dispatched",
                leaseId: "lease-dispatched",
                leaseGeneration: 1,
              },
            },
            updatedAt: "2026-09-04T00:00:00.000Z",
            expectedJournalSequence: 1,
          },
        ],
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing|checkpoint|dispatch/i);
  });

  it.each([
    [
      "unknown field",
      (journal: Record<string, unknown>) => {
        journal.extra = true;
      },
    ],
    [
      "unsupported version",
      (journal: Record<string, unknown>) => {
        journal.schemaVersion = 99;
      },
    ],
    [
      "invalid sequence",
      (journal: Record<string, unknown>) => {
        journal.generation = 0;
      },
    ],
    [
      "invalid epoch",
      (_journal: Record<string, unknown>, checkpoint: Record<string, unknown>) => {
        const entries = checkpoint.entries as Array<Record<string, unknown>>;
        entries[0]!.executorEpoch = "bad epoch";
      },
    ],
  ])("rejects %s before trusting the journal", (_kind, mutate) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 3);
    const fixture = makeV3Journal(key);
    const journal = fixture.journal;
    mutate(journal, fixture.checkpoint);
    const result = run(root, journal, key, { checkpoint: fixture.checkpoint, floor: fixture.floor });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/authentication|schema|sequence|epoch|version|unknown/i);
  });

  it("selects the newest valid checkpoint after a replayed old manifest", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 4);
    const old = makeV3Journal(key);
    const newer = { ...old.checkpoint, generation: 2 } as Record<string, unknown>;
    newer.mac = mac(key, "checkpoint", newer);
    const manifest = {
      ...old.journal,
      generation: 2,
      checkpointGeneration: 2,
      appendGeneration: 2,
      generationFloor: 2,
      checkpointSlot: 1,
    } as Record<string, unknown>;
    manifest.mac = mac(key, "manifest", manifest);
    const floor: Record<string, unknown> = { schemaVersion: 3, generationFloor: 2, mac: "" };
    floor.mac = mac(key, "floor", floor);
    const result = run(root, manifest, key, { checkpoint: old.checkpoint, checkpointOne: newer, floor });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("idle\t2\n");
  });

  it("fails closed when only a valid checkpoint below the authenticated floor remains", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 5);
    const fixture = makeV3Journal(key);
    const manifest = {
      ...fixture.journal,
      generation: 2,
      checkpointGeneration: 2,
      appendGeneration: 2,
      generationFloor: 2,
    } as Record<string, unknown>;
    manifest.mac = mac(key, "manifest", manifest);
    const floor: Record<string, unknown> = { schemaVersion: 3, generationFloor: 2, mac: "" };
    floor.mac = mac(key, "floor", floor);
    const result = run(root, manifest, key, { checkpoint: fixture.checkpoint, floor });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/floor|recovery|checkpoint/i);
  });

  it("fails closed when the manifest-selected append sidecar is missing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 9);
    const fixture = makeV3Journal(key);
    const result = run(root, fixture.journal, key, {
      checkpoint: fixture.checkpoint,
      floor: fixture.floor,
      omitAppend: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/append|sidecar|missing/i);
  });

  it("accepts the single bounded authenticated folded terminal aggregate", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 10);
    const fixture = makeV3Journal(key);
    const evidence: Record<string, unknown> = {
      schemaVersion: 3,
      recordSequence: 1,
      acknowledgedCount: 100_001,
      latestTerminalSequence: 1,
      aggregateDigest: "f".repeat(64),
      replayFilter: Buffer.alloc(1_048_576, 0x01).toString("base64url"),
      mac: "",
    };
    evidence.mac = mac(key, "evidence", evidence);
    fixture.checkpoint.entries = [];
    fixture.checkpoint.evidence = [evidence];
    fixture.checkpoint.mac = mac(key, "checkpoint", fixture.checkpoint);
    const result = run(root, fixture.journal, key, { checkpoint: fixture.checkpoint, floor: fixture.floor });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("idle\t1\n");
  });

  it("ignores an incomplete final append frame and exposes the lower recovered generation", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 11);
    const fixture = makeV3Journal(key);
    fixture.journal.generation = 2;
    fixture.journal.appendGeneration = 2;
    fixture.journal.mac = mac(key, "manifest", fixture.journal);
    const result = run(root, fixture.journal, key, {
      checkpoint: fixture.checkpoint,
      floor: fixture.floor,
      appendContent: '{"schemaVersion":3',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("idle\t1\n");
    const appendPath = path.join(root, "executor-effect-journal.json.append.0");
    expect(readFileSync(appendPath).byteLength).toBe(0);
    const replacementEntry: Record<string, unknown> = {
      schemaVersion: 3,
      recordSequence: 2,
      invocationId: "invocation-after-repair",
      invocationDigest: "c".repeat(64),
      effectFingerprint: "d".repeat(64),
      status: "committed",
      updatedAt: "2026-09-04T00:00:01.000Z",
      result: toolResult("invocation-after-repair"),
      mac: "",
    };
    replacementEntry.mac = mac(key, "entry", replacementEntry);
    const replacement: Record<string, unknown> = {
      schemaVersion: 3,
      generation: 2,
      mutations: [
        {
          operation: "upsert-entry",
          key: "legacy:0:invocation-after-repair",
          value: replacementEntry,
        },
      ],
      mac: "",
    };
    replacement.mac = mac(key, "transaction", replacement);
    writeFileSync(appendPath, `${canonical(replacement)}\n`, { flag: "a" });
    const recovered = run(root, fixture.journal, key, {
      checkpoint: fixture.checkpoint,
      floor: fixture.floor,
      preserveAppend: true,
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toBe("idle\t2\n");
    const blocked = run(root, fixture.journal, key, {
      checkpoint: fixture.checkpoint,
      floor: fixture.floor,
      appendContent: '{"schemaVersion":3',
      checkpointSequence: 2,
      gateway: { schemaVersion: 1, entries: [] },
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/behind|checkpoint|generation/i);
  });

  it.each(["active", "reserved", "indeterminate"] as const)("does not report %s journal state as idle", (state) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-"));
    roots.push(root);
    const key = Buffer.alloc(32, 6);
    const fixture = makeV3Journal(key);
    const entry = (fixture.checkpoint.entries as Array<Record<string, unknown>>)[0]!;
    if (state === "active" || state === "reserved") {
      entry.status = state === "active" ? "in-progress" : "reserved";
      entry.result = undefined;
    } else {
      (entry.result as Record<string, unknown>).status = "indeterminate";
    }
    entry.mac = mac(key, "entry", entry);
    fixture.checkpoint.mac = mac(key, "checkpoint", fixture.checkpoint);
    const result = run(root, fixture.journal, key, { checkpoint: fixture.checkpoint, floor: fixture.floor });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checkpoint|idle|active|indeterminate/i);
  });

  it("authorizes only the exact active entry, gateway dispatch, and backup snapshot", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-host-operation-active-"));
    roots.push(root);
    const key = Buffer.alloc(32, 31);
    const invocation = {
      schemaVersion: 1,
      invocationId: "invocation-active",
      sessionId: "session-active",
      toolId: "maintenance.apply",
      capability: "maintenance.apply",
      targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
      arguments: {},
      requestedAt: "2026-09-04T00:00:00.000Z",
    };
    const invocationDigest = createHash("sha256").update(canonical(invocation)).digest("hex");
    const backupFingerprint = "9".repeat(64);
    const entry: Record<string, unknown> = {
      schemaVersion: 3,
      recordSequence: 1,
      invocationId: invocation.invocationId,
      invocationDigest,
      effectFingerprint: "8".repeat(64),
      taskId: "task-active",
      leaseGeneration: 4,
      behaviorFingerprint: "7".repeat(64),
      approvalsFingerprint: "6".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "5".repeat(64),
      backupAuthorizationFingerprint: backupFingerprint,
      executorEpoch: "epoch-active",
      status: "in-progress",
      updatedAt: "2026-09-04T00:00:00.000Z",
      mac: "",
    };
    entry.mac = mac(key, "entry", entry);
    const checkpoint: Record<string, unknown> = {
      schemaVersion: 3,
      format: "manifest-checkpoint-transaction-v1",
      generation: 1,
      entries: [entry],
      cancellationTombstones: [],
      evidence: [],
      mac: "",
    };
    checkpoint.mac = mac(key, "checkpoint", checkpoint);
    const journal: Record<string, unknown> = {
      schemaVersion: 3,
      format: "manifest-checkpoint-transaction-v1",
      generation: 1,
      checkpointGeneration: 1,
      appendGeneration: 1,
      generationFloor: 1,
      checkpointSlot: 0,
      appendSlot: 0,
      mac: "",
    };
    journal.mac = mac(key, "manifest", journal);
    const floor: Record<string, unknown> = { schemaVersion: 3, generationFloor: 1, mac: "" };
    floor.mac = mac(key, "floor", floor);
    const gateway = {
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          key: `runtime-active:task-active:lease-active:4:${invocation.invocationId}`,
          runtimeId: "runtime-active",
          sessionId: invocation.sessionId,
          taskId: "task-active",
          leaseId: "lease-active",
          leaseGeneration: 4,
          invocationId: invocation.invocationId,
          invocationDigest,
          state: "dispatching",
          payload: {
            invocation,
            runtimeContext: {
              runtimeId: "runtime-active",
              taskId: "task-active",
              leaseId: "lease-active",
              leaseGeneration: 4,
            },
          },
          updatedAt: "2026-09-04T00:00:00.000Z",
          expectedJournalSequence: 1,
        },
      ],
    };
    run(root, journal, key, { checkpoint, floor, gateway, handoffState: "durable" });
    const command = (fingerprint: string) =>
      spawnSync(
        "python3",
        [
          helper,
          "--contract",
          contract,
          "executor-active-effect",
          "--journal",
          path.join(root, "executor-effect-journal.json"),
          "--credential",
          path.join(root, "executor-journal-hmac.key"),
          "--gateway-journal",
          path.join(root, "executor-reconciliations.json"),
          "--runtime-id",
          "runtime-active",
          "--session-id",
          invocation.sessionId,
          "--task-id",
          "task-active",
          "--lease-id",
          "lease-active",
          "--lease-generation",
          "4",
          "--invocation-id",
          invocation.invocationId,
          "--invocation-digest",
          invocationDigest,
          "--backup-authorization-fingerprint",
          fingerprint,
        ],
        { encoding: "utf8" }
      );
    const accepted = command(backupFingerprint);
    expect({ status: accepted.status, stderr: accepted.stderr, stdout: accepted.stdout }).toMatchObject({ status: 0 });
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      generation: 1,
      recordSequence: 1,
      effectFingerprint: "8".repeat(64),
      backupAuthorizationFingerprint: backupFingerprint,
    });
    expect(command("4".repeat(64)).status).not.toBe(0);
  });

  it("captures and restores the exact service active and enablement inventory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-service-state-"));
    roots.push(root);
    const systemctl = path.join(root, "systemctl");
    const commandLog = path.join(root, "commands.log");
    writeFileSync(
      systemctl,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${commandLog}"
case "$1" in
  is-active)
    unit="\${3:-\${2:-}}"
    [[ "$unit" == "minecraft-dns.service" || "$unit" == "minecraft.service" || "$unit" == "mc-agent-world-roots.service" || "$unit" == "mc-agent-executor.socket" ]]
    ;;
  is-enabled)
    case "$2" in
      minecraft-dns.service) printf 'static\n' ;;
      minecraft.service) printf 'enabled\n' ;;
      mc-agent-executor.socket) printf 'enabled\n' ;;
      mc-agent-world-roots.service) printf 'enabled\n' ;;
      *) printf 'disabled\n'; exit 1 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 }
    );
    chmodSync(systemctl, 0o755);
    const environment = { ...process.env, PATH: `${root}:${process.env.PATH}` };
    const captured = spawnSync("python3", [helper, "--contract", contract, "service-state", "capture"], {
      env: environment,
      encoding: "utf8",
    });
    expect(captured.status, captured.stderr).toBe(0);
    expect(JSON.parse(captured.stdout)).toEqual([
      { unit: "minecraft-dns.service", active: true, enablement: "static" },
      { unit: "minecraft.service", active: true, enablement: "enabled" },
      { unit: "mc-agent-world-roots.service", active: true, enablement: "enabled" },
      { unit: "mc-agent-tool-read.socket", active: false, enablement: "disabled" },
      { unit: "mc-agent-tool-read.service", active: false, enablement: "disabled" },
      { unit: "mc-agent-tool-write.socket", active: false, enablement: "disabled" },
      { unit: "mc-agent-tool-write.service", active: false, enablement: "disabled" },
      { unit: "mc-agent-executor.socket", active: true, enablement: "enabled" },
      { unit: "mc-agent-executor.service", active: false, enablement: "disabled" },
      { unit: "mc-agent-gateway.service", active: false, enablement: "disabled" },
      { unit: "mc-agent-host-broker.socket", active: false, enablement: "disabled" },
      { unit: "mc-agent-host-broker.service", active: false, enablement: "disabled" },
    ]);
    const restored = spawnSync(
      "python3",
      [helper, "--contract", contract, "service-state", "restore", "--state-json", captured.stdout.trim()],
      { env: environment, encoding: "utf8" }
    );
    expect(restored.status, restored.stderr).toBe(0);
    const commands = readFileSync(commandLog, "utf8");
    expect(commands).toContain("enable minecraft.service");
    expect(commands).toContain("disable mc-agent-executor.service");
    expect(commands).toContain("start minecraft.service");
    expect(commands).toContain("stop mc-agent-executor.service");
    expect(commands).toContain("stop mc-agent-gateway.service");
  });
});
