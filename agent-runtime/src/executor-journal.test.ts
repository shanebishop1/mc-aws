import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TOOL_RESULT_BYTES } from "../../lib/agent/response-limits";
import { ExecutorEffectJournal } from "./executor-journal";

const roots: string[] = [];
const JOURNAL_KEY = Buffer.alloc(32, 0x5a);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function result(invocationId: string) {
  return {
    schemaVersion: 1 as const,
    invocationId,
    status: "succeeded" as const,
    completedAt: "2026-09-02T12:00:01.000Z",
    summary: "committed",
    output: { committed: true },
    evidence: [],
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function journalMac(domain: string, value: Record<string, unknown>): string {
  const { mac: _mac, ...unsigned } = value;
  return createHmac("sha256", JOURNAL_KEY)
    .update(`mc-aws-executor-journal:${domain}:v3\n${canonical(unsigned)}`)
    .digest("base64url");
}

function context(taskId: string, leaseGeneration: number) {
  return {
    taskId,
    leaseGeneration,
    behaviorFingerprint: "1".repeat(64),
    approvalsFingerprint: "2".repeat(64),
    approvalsWithoutAuthorizationFingerprint: "3".repeat(64),
  };
}

async function publicationAcknowledgement(
  journal: ExecutorEffectJournal,
  invocationId: string,
  invocationDigest: string,
  invocationContext: ReturnType<typeof context>
) {
  const terminalResult = result(invocationId);
  const terminal = await journal.terminalAttestation(invocationId, invocationContext, terminalResult);
  const terminalReceipt = {
    schemaVersion: 1 as const,
    source: "executor-journal" as const,
    proofKind: "terminal" as const,
    outcome: "committed" as const,
    executorKeyId: "executor-receipt-test",
    executorEpoch: "executor-epoch-test",
    runtimeId: "runtime-test",
    leaseId: `lease-${invocationContext.leaseGeneration}`,
    leaseGeneration: invocationContext.leaseGeneration,
    sessionId: "session-test",
    taskId: invocationContext.taskId,
    invocationId,
    invocationDigest,
    resultDigest: digest(terminalResult),
    journalSequence: terminal.journalSequence,
    completedAt: terminalResult.completedAt,
    signature: "A".repeat(86),
  };
  await journal.recordTerminalReceipt(invocationId, invocationContext, terminalResult, terminalReceipt);
  return {
    invocationId,
    invocationDigest,
    taskId: invocationContext.taskId,
    leaseGeneration: invocationContext.leaseGeneration,
    journalSequence: terminal.journalSequence,
    resultDigest: digest(terminalResult),
    authorization: {
      schemaVersion: 1 as const,
      source: "control-plane-terminal-publication" as const,
      runtimeId: terminalReceipt.runtimeId,
      sessionId: terminalReceipt.sessionId,
      taskId: invocationContext.taskId,
      leaseId: terminalReceipt.leaseId,
      leaseGeneration: invocationContext.leaseGeneration,
      invocationId,
      invocationDigest,
      journalSequence: terminal.journalSequence,
      resultDigest: terminalReceipt.resultDigest,
      terminalReceiptDigest: digest(terminalReceipt),
      outcome: "committed" as const,
      taskStatus: "completed" as const,
      sessionStatus: "idle" as const,
      publicationRevision: 1,
      publishedAt: terminalResult.completedAt,
      signature: "B".repeat(86),
    },
  };
}

async function assertTornAppendBoundary({
  statePath,
  appendPath,
  completeFrame,
  completeManifest,
  completeFloor,
  boundary,
  invocationContext,
}: {
  statePath: string;
  appendPath: string;
  completeFrame: Buffer;
  completeManifest: Buffer;
  completeFloor: Buffer;
  boundary: number;
  invocationContext: ReturnType<typeof context>;
}): Promise<ExecutorEffectJournal> {
  await writeFile(statePath, completeManifest);
  await writeFile(`${statePath}.generation-floor`, completeFloor);
  await writeFile(appendPath, completeFrame.subarray(0, boundary));
  const recovered = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
  await recovered.initialize();
  expect(await recovered.currentSequence(), `torn append boundary ${boundary}`).toBe(1);
  expect((await readFile(appendPath)).byteLength, `repaired append boundary ${boundary}`).toBe(0);
  await expect(
    recovered.begin("invocation-torn-frame", "a".repeat(64), "b".repeat(64), invocationContext),
    `torn append boundary ${boundary}`
  ).resolves.toMatchObject({
    outcome: "replay",
    result: { status: "indeterminate" },
  });
  return recovered;
}

describe("bounded executor effect journal", () => {
  it("reclaims acknowledged completed entries without discarding replay protection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const context = {
      taskId: "task-old",
      leaseGeneration: 1,
      behaviorFingerprint: "1".repeat(64),
      approvalsFingerprint: "2".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "3".repeat(64),
    };
    const journal = new ExecutorEffectJournal(statePath, { maxEntries: 1, authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    expect(await journal.begin("invocation-old", "a".repeat(64), "b".repeat(64), context)).toEqual({
      outcome: "execute",
    });
    await journal.commit("invocation-old", "a".repeat(64), "b".repeat(64), result("invocation-old"), context);
    const oldAcknowledgement = await publicationAcknowledgement(journal, "invocation-old", "a".repeat(64), context);
    await journal.acknowledgeTerminal(oldAcknowledgement);
    await expect(journal.acknowledgeTerminal(oldAcknowledgement)).resolves.toBeUndefined();
    const authenticated = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: number;
      generation: number;
      mac: string;
    };
    expect(authenticated).toMatchObject({
      schemaVersion: 3,
      generation: expect.any(Number),
      mac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const newContext = { ...context, taskId: "task-new", leaseGeneration: 2 };
    await expect(journal.begin("invocation-new", "c".repeat(64), "d".repeat(64), newContext)).resolves.toEqual({
      outcome: "execute",
    });
    await journal.commit("invocation-new", "c".repeat(64), "d".repeat(64), result("invocation-new"), newContext);
    await journal.acknowledgeTerminal(
      await publicationAcknowledgement(journal, "invocation-new", "c".repeat(64), newContext)
    );
    const thirdContext = { ...context, taskId: "task-third", leaseGeneration: 3 };
    await expect(journal.begin("invocation-third", "e".repeat(64), "f".repeat(64), thirdContext)).resolves.toEqual({
      outcome: "execute",
    });
    await journal.commit("invocation-third", "e".repeat(64), "f".repeat(64), result("invocation-third"), thirdContext);
    await expect(journal.inFlight()).resolves.toMatchObject({
      invocationId: "invocation-third",
      status: "terminal-pending",
    });
    await journal.acknowledgeTerminal(
      await publicationAcknowledgement(journal, "invocation-third", "e".repeat(64), thirdContext)
    );
    await expect(journal.begin("invocation-old", "a".repeat(64), "b".repeat(64), context)).resolves.toEqual({
      outcome: "reject",
    });
    const manifest = JSON.parse(await readFile(statePath, "utf8")) as { checkpointSlot: number; appendSlot: number };
    const checkpoint = await readFile(`${statePath}.checkpoint.${manifest.checkpointSlot}`, "utf8");
    const append = await readFile(`${statePath}.append.${manifest.appendSlot}`, "utf8");
    const persistedEvidence = `${checkpoint}${append}`;
    expect(persistedEvidence).toContain("replayFilter");
    expect(checkpoint).not.toContain("invocation-old");
    expect(append).not.toContain("delete-entry");

    const restarted = new ExecutorEffectJournal(statePath, { maxEntries: 1, authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    await expect(restarted.begin("invocation-old", "a".repeat(64), "b".repeat(64), context)).resolves.toEqual({
      outcome: "reject",
    });
  });

  it("persists bounded cancellation tombstones and refuses a later start after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const now = () => new Date("2026-09-02T12:00:02.000Z");
    const journal = new ExecutorEffectJournal(statePath, { now, authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.cancel("invocation-cancelled", "2026-09-02T12:00:00.000Z");

    const restarted = new ExecutorEffectJournal(statePath, { now, authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    await expect(restarted.begin("invocation-cancelled", "a".repeat(64), "b".repeat(64))).resolves.toMatchObject({
      outcome: "replay",
      result: { status: "cancelled" },
    });
  });

  it("binds cancellation to the exact durable invocation and effect identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-cancel-identity-"));
    roots.push(root);
    const journal = new ExecutorEffectJournal(path.join(root, "journal.json"), { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const context = { taskId: "task-cancel-identity", leaseGeneration: 1 };
    const identity = { invocationDigest: "a".repeat(64), effectFingerprint: "b".repeat(64) };
    await expect(
      journal.cancel("invocation-cancel-identity", "2026-09-02T12:00:00.000Z", context, identity)
    ).resolves.toMatchObject({ result: { status: "cancelled", mutationCommit: { committed: false } } });
    await expect(
      journal.cancel("invocation-cancel-identity", "2026-09-02T12:00:01.000Z", context, {
        ...identity,
        effectFingerprint: "c".repeat(64),
      })
    ).rejects.toThrow(/identity/i);
    await expect(
      journal.cancel("invocation-cancel-identity", "2026-09-02T12:00:01.000Z", context, identity)
    ).resolves.toMatchObject({ result: { status: "cancelled" } });
  });

  it("retains a recovered in-progress effect indefinitely until a root-authorized clean-start epoch changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    let now = new Date("2026-09-02T12:00:00.000Z");
    const clock = () => now;
    const context = {
      taskId: "task-uncertain",
      leaseGeneration: 1,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "d".repeat(64),
      executorEpoch: "epoch-before-restart",
    };
    const journal = new ExecutorEffectJournal(statePath, { now: clock, authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-uncertain", "a".repeat(64), "b".repeat(64), context);

    now = new Date("2026-09-02T12:00:01.000Z");
    const restarted = new ExecutorEffectJournal(statePath, { now: clock, authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    const reconciled = await restarted.begin("invocation-uncertain", "a".repeat(64), "b".repeat(64), context);
    expect(reconciled).toMatchObject({
      outcome: "replay",
      result: { status: "indeterminate", output: { code: "indeterminate-effect" } },
    });
    await expect(
      restarted.reconcile("invocation-uncertain", "a".repeat(64), "b".repeat(64), context, false)
    ).resolves.toMatchObject({
      outcome: "pending",
    });

    now = new Date("2036-09-02T12:03:00.000Z");
    await expect(
      restarted.reconcile("invocation-uncertain", "a".repeat(64), "b".repeat(64), context, false)
    ).resolves.toEqual({ outcome: "pending" });

    const cleanStartContext = { ...context, executorEpoch: "epoch-root-rotated" };
    const cleanStart = await restarted.reconcile(
      "invocation-uncertain",
      "a".repeat(64),
      "b".repeat(64),
      cleanStartContext,
      false
    );
    expect(cleanStart).toMatchObject({
      outcome: "terminal",
      proofKind: "clean-start-no-active",
      result: { status: "failed", output: { code: "reconciliation-clean-start", noActiveEffect: true } },
    });

    const secondRestart = new ExecutorEffectJournal(statePath, { now: clock, authenticationKey: JOURNAL_KEY });
    await secondRestart.initialize();
    await expect(
      secondRestart.begin("invocation-uncertain", "a".repeat(64), "b".repeat(64), cleanStartContext)
    ).resolves.toStrictEqual({ outcome: "replay", result: (cleanStart as { result: unknown }).result });
  });

  it("never expires an entry while the authoritative executor still reports it active", async () => {
    let now = new Date("2026-09-02T12:00:00.000Z");
    const context = {
      taskId: "task-active-beyond-horizon",
      leaseGeneration: 9,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "d".repeat(64),
      executorEpoch: "epoch-before-restart",
    };
    const journal = new ExecutorEffectJournal(undefined, { now: () => now, authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-active-beyond-horizon", "a".repeat(64), "b".repeat(64), context);
    now = new Date("2026-09-03T12:00:00.000Z");

    await expect(
      journal.reconcile("invocation-active-beyond-horizon", "a".repeat(64), "b".repeat(64), context, true)
    ).resolves.toMatchObject({ outcome: "active" });
  });

  it("durably serializes all sessions and lease generations behind one in-flight effect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const firstContext = {
      taskId: "task-first-session",
      leaseGeneration: 3,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "d".repeat(64),
    };
    const secondContext = {
      ...firstContext,
      taskId: "task-second-session",
      leaseGeneration: 8,
    };
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await expect(journal.begin("invocation-first", "a".repeat(64), "b".repeat(64), firstContext)).resolves.toEqual({
      outcome: "execute",
    });
    await expect(journal.inFlight()).resolves.toMatchObject({
      invocationId: "invocation-first",
      taskId: "task-first-session",
      leaseGeneration: 3,
      status: "in-progress",
    });

    const restarted = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    await expect(
      restarted.begin("invocation-second", "e".repeat(64), "f".repeat(64), secondContext)
    ).resolves.toMatchObject({
      outcome: "runtime-fenced",
      owner: { invocationId: "invocation-first", taskId: "task-first-session", leaseGeneration: 3 },
    });

    await restarted.commit(
      "invocation-first",
      "a".repeat(64),
      "b".repeat(64),
      result("invocation-first"),
      firstContext
    );
    await expect(restarted.inFlight()).resolves.toMatchObject({
      invocationId: "invocation-first",
      status: "terminal-pending",
    });
    await expect(
      restarted.begin("invocation-second", "e".repeat(64), "f".repeat(64), secondContext)
    ).resolves.toMatchObject({ outcome: "runtime-fenced", owner: { status: "terminal-pending" } });
    await restarted.acknowledgeTerminal(
      await publicationAcknowledgement(restarted, "invocation-first", "a".repeat(64), firstContext)
    );
    await expect(restarted.inFlight()).resolves.toBeNull();
    await expect(restarted.begin("invocation-second", "e".repeat(64), "f".repeat(64), secondContext)).resolves.toEqual({
      outcome: "execute",
    });
  });

  it("keeps an indeterminate terminal checkpoint as the global owner until safe reconciliation", async () => {
    let now = new Date("2026-09-02T12:00:00.000Z");
    const context = {
      taskId: "task-indeterminate-owner",
      leaseGeneration: 4,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "d".repeat(64),
      executorEpoch: "epoch-before-restart",
    };
    const journal = new ExecutorEffectJournal(undefined, {
      now: () => now,
      authenticationKey: JOURNAL_KEY,
    });
    await journal.initialize();
    await journal.begin("invocation-indeterminate-owner", "a".repeat(64), "b".repeat(64), context);
    await journal.commit(
      "invocation-indeterminate-owner",
      "a".repeat(64),
      "b".repeat(64),
      {
        schemaVersion: 1,
        invocationId: "invocation-indeterminate-owner",
        status: "indeterminate",
        completedAt: now.toISOString(),
        summary: "entered effect is indeterminate",
        output: { code: "indeterminate-effect" },
        evidence: [],
      },
      context
    );
    await expect(
      journal.begin("invocation-distinct", "e".repeat(64), "f".repeat(64), {
        ...context,
        taskId: "task-distinct",
      })
    ).resolves.toMatchObject({ outcome: "runtime-fenced" });

    now = new Date("2036-09-02T12:03:00.000Z");
    await expect(
      journal.reconcile("invocation-indeterminate-owner", "a".repeat(64), "b".repeat(64), context, false)
    ).resolves.toEqual({ outcome: "pending" });
    await expect(
      journal.begin("invocation-distinct", "e".repeat(64), "f".repeat(64), {
        ...context,
        taskId: "task-distinct",
      })
    ).resolves.toMatchObject({ outcome: "runtime-fenced" });

    await expect(
      journal.reconcile(
        "invocation-indeterminate-owner",
        "a".repeat(64),
        "b".repeat(64),
        { ...context, executorEpoch: "epoch-root-rotated" },
        false
      )
    ).resolves.toMatchObject({ outcome: "terminal", proofKind: "clean-start-no-active" });
  });

  it("keeps invocation authorization as a retryable non-effect precondition and binds behavior", async () => {
    const journal = new ExecutorEffectJournal(undefined, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const context = {
      taskId: "task-authorization",
      leaseGeneration: 2,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "d".repeat(64),
    };
    const waiting = {
      schemaVersion: 1 as const,
      invocationId: "invocation-authorization",
      status: "failed" as const,
      completedAt: "2026-09-02T12:00:01.000Z",
      summary: "authorization required",
      output: { code: "invocation-authorization-required" },
      evidence: [],
    };
    expect(await journal.begin("invocation-authorization", "a".repeat(64), "b".repeat(64), context)).toEqual({
      outcome: "execute",
    });
    await journal.commit("invocation-authorization", "a".repeat(64), "b".repeat(64), waiting, context);
    await expect(
      journal.begin("invocation-authorization", "a".repeat(64), "b".repeat(64), context)
    ).resolves.toMatchObject({ outcome: "replay", result: waiting });
    await expect(
      journal.begin("invocation-authorization", "a".repeat(64), "d".repeat(64), {
        ...context,
        behaviorFingerprint: "e".repeat(64),
        approvalAuthorizationFingerprint: "f".repeat(64),
      })
    ).resolves.toEqual({ outcome: "reject" });
    await expect(
      journal.begin("invocation-authorization", "a".repeat(64), "d".repeat(64), {
        ...context,
        approvalAuthorizationFingerprint: "f".repeat(64),
      })
    ).resolves.toEqual({ outcome: "execute" });
  });

  it("temporarily fails saturated requests and recovers safely after tombstone expiry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    let now = new Date("2026-09-02T12:00:00.000Z");
    const clock = () => now;
    const journal = new ExecutorEffectJournal(statePath, {
      maxCancellationTombstones: 1,
      cancellationTombstoneTtlMs: 1_000,
      now: clock,
      authenticationKey: JOURNAL_KEY,
    });
    await journal.initialize();
    await journal.cancel("invocation-oldest", "2026-09-02T12:00:00.000Z");
    await expect(journal.cancel("invocation-overflow", "2026-09-02T12:00:00.500Z")).rejects.toThrow(/temporarily/);
    await expect(journal.begin("invocation-unrelated", "c".repeat(64), "d".repeat(64))).resolves.toEqual({
      outcome: "reject",
    });

    now = new Date("2026-09-02T12:00:02.000Z");
    const restarted = new ExecutorEffectJournal(statePath, {
      maxCancellationTombstones: 1,
      cancellationTombstoneTtlMs: 1_000,
      now: clock,
      authenticationKey: JOURNAL_KEY,
    });
    await restarted.initialize();
    await expect(restarted.begin("invocation-unrelated", "c".repeat(64), "d".repeat(64))).resolves.toEqual({
      outcome: "execute",
    });
  });

  it.each([
    [
      "forged terminal result",
      async (statePath: string) => {
        const checkpointPath = `${statePath}.checkpoint.0`;
        const state = JSON.parse(await readFile(checkpointPath, "utf8")) as {
          entries: Array<Record<string, unknown>>;
        };
        state.entries[0]!.status = "committed";
        state.entries[0]!.result = result("invocation-authenticated");
        await writeFile(checkpointPath, `${JSON.stringify(state)}\n`);
      },
    ],
    [
      "truncated snapshot",
      async (statePath: string) => {
        const bytes = await readFile(statePath);
        await writeFile(statePath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
      },
    ],
  ])("rejects a %s before trusting any journal record", async (_case, corrupt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-authenticated", "a".repeat(64), "b".repeat(64), {
      taskId: "task-authenticated",
      leaseGeneration: 1,
      behaviorFingerprint: "c".repeat(64),
      approvalsFingerprint: "d".repeat(64),
      approvalsWithoutAuthorizationFingerprint: "e".repeat(64),
      approvalAuthorizationFingerprint: "f".repeat(64),
      backupAuthorizationFingerprint: "1".repeat(64),
    });
    await corrupt(statePath);

    const restarted = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await expect(restarted.initialize()).rejects.toThrow();
  });

  it("rejects an otherwise valid snapshot under the wrong key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-wrong-key", "a".repeat(64), "b".repeat(64));

    const restarted = new ExecutorEffectJournal(statePath, { authenticationKey: Buffer.alloc(32, 0x6b) });
    await expect(restarted.initialize()).rejects.toThrow(/authentication/i);
  });

  it("allows an absent journal to initialize only as a fresh no-handoff state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await expect(journal.currentSequence()).resolves.toBe(0);
    await expect(journal.begin("invocation-fresh", "a".repeat(64), "b".repeat(64))).resolves.toEqual({
      outcome: "execute",
    });
  });

  it("recovers a committed-without-receipt journal after a crash and records the receipt before acknowledgement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-committed-receipt-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const invocationContext = context("task-committed-receipt", 1);
    const invocationDigest = "a".repeat(64);
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-committed-receipt", invocationDigest, "b".repeat(64), invocationContext);
    await journal.commit(
      "invocation-committed-receipt",
      invocationDigest,
      "b".repeat(64),
      result("invocation-committed-receipt"),
      invocationContext
    );

    const restarted = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    await expect(
      restarted.terminalAttestation(
        "invocation-committed-receipt",
        invocationContext,
        result("invocation-committed-receipt")
      )
    ).resolves.toMatchObject({ journalSequence: expect.any(Number) });
    const acknowledgement = await publicationAcknowledgement(
      restarted,
      "invocation-committed-receipt",
      invocationDigest,
      invocationContext
    );
    await expect(restarted.acknowledgeTerminal(acknowledgement)).resolves.toBeUndefined();
    const afterRecovery = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await afterRecovery.initialize();
    await expect(
      afterRecovery.terminalAttestation(
        "invocation-committed-receipt",
        invocationContext,
        result("invocation-committed-receipt")
      )
    ).resolves.toMatchObject({ terminalReceipt: expect.objectContaining({ executorKeyId: "executor-receipt-test" }) });
  });

  it("reserves terminal capacity before execute and commits a bounded maximum result", async () => {
    const unavailable = new ExecutorEffectJournal(undefined, {
      maxBytes: 1_024,
      maxResultBytes: 512,
      authenticationKey: JOURNAL_KEY,
    });
    await unavailable.initialize();
    await expect(
      unavailable.begin("invocation-too-large", "a".repeat(64), "b".repeat(64), context("task-too-large", 1))
    ).rejects.toThrow(/capacity/i);

    const journal = new ExecutorEffectJournal(undefined, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const invocationContext = context("task-maximum", 1);
    await expect(
      journal.begin("invocation-maximum", "a".repeat(64), "b".repeat(64), invocationContext)
    ).resolves.toEqual({ outcome: "execute" });
    await expect(
      journal.commit(
        "invocation-maximum",
        "a".repeat(64),
        "b".repeat(64),
        { ...result("invocation-maximum"), output: { text: "x".repeat(MAX_TOOL_RESULT_BYTES * 2) } },
        invocationContext
      )
    ).resolves.toBeUndefined();
  });

  it("continues beyond the active-entry bound with constant-size aggregate evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-cycle-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { maxEntries: 1, authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const checkpointSizes: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const invocationId = `invocation-cycle-${index}`;
      const invocationContext = context(`task-cycle-${index}`, index + 1);
      const invocationDigest = index.toString(16).padStart(64, "0");
      const effectFingerprint = (index + 100).toString(16).padStart(64, "0");
      await expect(
        journal.begin(invocationId, invocationDigest, effectFingerprint, invocationContext)
      ).resolves.toEqual({ outcome: "execute" });
      const manifest = JSON.parse(await readFile(statePath, "utf8")) as { checkpointSlot: number };
      checkpointSizes.push((await readFile(`${statePath}.checkpoint.${manifest.checkpointSlot}`)).byteLength);
      await journal.commit(invocationId, invocationDigest, effectFingerprint, result(invocationId), invocationContext);
      await journal.acknowledgeTerminal(
        await publicationAcknowledgement(journal, invocationId, invocationDigest, invocationContext)
      );
    }
    const steadyStateSizes = checkpointSizes.slice(2);
    expect(Math.max(...steadyStateSizes) - Math.min(...steadyStateSizes)).toBeLessThan(2_048);
    expect(Math.max(...steadyStateSizes)).toBeLessThan(2 * 1024 * 1024);
    expect(
      `${await readFile(`${statePath}.append.0`, "utf8")}${await readFile(`${statePath}.append.1`, "utf8")}`
    ).not.toContain("claims");
    const restarted = new ExecutorEffectJournal(statePath, { maxEntries: 1, authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    await expect(
      restarted.begin("invocation-cycle-next", "f".repeat(64), "e".repeat(64), context("task-cycle-next", 13))
    ).resolves.toEqual({ outcome: "execute" });
  }, 20_000);

  it("rejects replay of an authenticated checkpoint below the durable generation floor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-floor-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { maxEntries: 1, authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const firstContext = context("task-floor-first", 1);
    await journal.begin("invocation-floor-first", "a".repeat(64), "b".repeat(64), firstContext);
    const oldManifest = JSON.parse(await readFile(statePath, "utf8")) as { checkpointSlot: number };
    const oldCheckpoint = await readFile(`${statePath}.checkpoint.${oldManifest.checkpointSlot}`);
    await journal.commit(
      "invocation-floor-first",
      "a".repeat(64),
      "b".repeat(64),
      result("invocation-floor-first"),
      firstContext
    );
    await journal.acknowledgeTerminal(
      await publicationAcknowledgement(journal, "invocation-floor-first", "a".repeat(64), firstContext)
    );
    await journal.begin("invocation-floor-second", "c".repeat(64), "d".repeat(64), context("task-floor-second", 2));

    await Promise.all([
      writeFile(`${statePath}.checkpoint.0`, oldCheckpoint),
      writeFile(`${statePath}.checkpoint.1`, oldCheckpoint),
    ]);
    const replayed = new ExecutorEffectJournal(statePath, { maxEntries: 1, authenticationKey: JOURNAL_KEY });
    await expect(replayed.initialize()).rejects.toThrow(/generation|floor/i);
  });

  it.each([
    "checkpoint-temp-written",
    "checkpoint-file-synced",
    "checkpoint-renamed",
    "checkpoint-directory-synced",
    "append-temp-written",
    "append-file-synced",
    "append-reset",
    "append-directory-synced",
    "manifest-temp-written",
    "manifest-file-synced",
    "manifest-switched",
    "manifest-directory-synced",
    "floor-temp-written",
    "floor-file-synced",
    "floor-written",
    "floor-directory-synced",
    "old-append-cleaned",
  ] as const)("recovers compaction stage %s before reserving and entering the next effect", async (stage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-crash-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const firstContext = context("task-crash-first", 1);
    await journal.begin("invocation-crash-first", "a".repeat(64), "b".repeat(64), firstContext);
    await journal.commit(
      "invocation-crash-first",
      "a".repeat(64),
      "b".repeat(64),
      result("invocation-crash-first"),
      firstContext
    );
    await journal.acknowledgeTerminal(
      await publicationAcknowledgement(journal, "invocation-crash-first", "a".repeat(64), firstContext)
    );
    const secondContext = context("task-crash-second", 2);
    await journal.begin("invocation-crash-second", "c".repeat(64), "d".repeat(64), secondContext);
    await journal.commit(
      "invocation-crash-second",
      "c".repeat(64),
      "d".repeat(64),
      result("invocation-crash-second"),
      secondContext
    );
    await journal.acknowledgeTerminal(
      await publicationAcknowledgement(journal, "invocation-crash-second", "c".repeat(64), secondContext)
    );
    const crashing = new ExecutorEffectJournal(statePath, {
      authenticationKey: JOURNAL_KEY,
      crashAtCompactionStage: stage,
    });
    await crashing.initialize();
    const thirdContext = context("task-crash-third", 3);
    await expect(
      crashing.reserve("invocation-crash-third", "e".repeat(64), "f".repeat(64), thirdContext)
    ).rejects.toThrow(/injected compaction crash/);
    const recovered = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await recovered.initialize();
    await expect(
      recovered.reserve("invocation-crash-third", "e".repeat(64), "f".repeat(64), thirdContext)
    ).resolves.toMatchObject({ outcome: "reserved" });
    await expect(
      recovered.begin("invocation-crash-third", "e".repeat(64), "f".repeat(64), thirdContext)
    ).resolves.toEqual({ outcome: "execute" });
    await recovered.commit(
      "invocation-crash-third",
      "e".repeat(64),
      "f".repeat(64),
      result("invocation-crash-third"),
      thirdContext
    );
    await recovered.acknowledgeTerminal(
      await publicationAcknowledgement(recovered, "invocation-crash-third", "e".repeat(64), thirdContext)
    );
    await expect(
      recovered.begin("invocation-crash-first", "a".repeat(64), "b".repeat(64), firstContext)
    ).resolves.toEqual({ outcome: "reject" });
  });

  it.each([
    "transaction-written",
    "transaction-synced",
    "manifest-temp-written",
    "manifest-file-synced",
    "manifest-switched",
    "manifest-directory-synced",
    "floor-temp-written",
    "floor-file-synced",
    "floor-written",
    "floor-directory-synced",
  ] as const)("repairs durable append publication after stage %s without reusing its generation", async (stage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-publication-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const invocationContext = context("task-publication-first", 1);
    const prepared = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await prepared.initialize();
    await prepared.begin("invocation-publication-first", "a".repeat(64), "b".repeat(64), invocationContext);

    const crashing = new ExecutorEffectJournal(statePath, {
      authenticationKey: JOURNAL_KEY,
      crashAtCompactionStage: stage,
    });
    await crashing.initialize();
    await expect(
      crashing.commit(
        "invocation-publication-first",
        "a".repeat(64),
        "b".repeat(64),
        result("invocation-publication-first"),
        invocationContext
      )
    ).rejects.toThrow(/injected compaction crash/);
    expect(await crashing.currentSequence()).toBe(2);

    const recovered = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await recovered.initialize();
    await expect(
      recovered.begin("invocation-publication-first", "a".repeat(64), "b".repeat(64), invocationContext)
    ).resolves.toMatchObject({ outcome: "replay", result: { status: "succeeded" } });
    await expect(recovered.inFlight()).resolves.toMatchObject({ status: "terminal-pending" });
    await recovered.acknowledgeTerminal(
      await publicationAcknowledgement(recovered, "invocation-publication-first", "a".repeat(64), invocationContext)
    );
    await expect(
      recovered.begin(
        "invocation-publication-second",
        "c".repeat(64),
        "d".repeat(64),
        context("task-publication-second", 2)
      )
    ).resolves.toEqual({ outcome: "execute" });

    const manifest = JSON.parse(await readFile(statePath, "utf8")) as { appendSlot: number };
    const generations = (await readFile(`${statePath}.append.${manifest.appendSlot}`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((frame) => (JSON.parse(frame) as { generation: number }).generation);
    expect(generations).toEqual([2, 3, 4, 5]);
  });

  it("keeps unacknowledged and indeterminate terminals while append mutations avoid checkpoint rewrites", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-retention-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    const retained = context("task-retained", 1);
    await journal.begin("invocation-retained", "a".repeat(64), "b".repeat(64), retained);
    await journal.commit(
      "invocation-retained",
      "a".repeat(64),
      "b".repeat(64),
      result("invocation-retained"),
      retained
    );
    const checkpointBefore = (await readFile(`${statePath}.checkpoint.0`)).byteLength;
    await expect(journal.begin("invocation-retained", "a".repeat(64), "b".repeat(64), retained)).resolves.toMatchObject(
      { outcome: "replay" }
    );
    const checkpointAfter = (await readFile(`${statePath}.checkpoint.0`)).byteLength;
    expect(checkpointAfter).toBe(checkpointBefore);
    expect((await readFile(`${statePath}.append.0`)).byteLength).toBeGreaterThan(0);
    await journal.acknowledgeTerminal(
      await publicationAcknowledgement(journal, "invocation-retained", "a".repeat(64), retained)
    );

    const uncertain = context("task-indeterminate-retained", 2);
    await journal.begin("invocation-indeterminate-retained", "c".repeat(64), "d".repeat(64), uncertain);
    await journal.commit(
      "invocation-indeterminate-retained",
      "c".repeat(64),
      "d".repeat(64),
      {
        ...result("invocation-indeterminate-retained"),
        status: "indeterminate",
        output: { code: "indeterminate-effect" },
      },
      uncertain
    );
    await expect(
      journal.begin("invocation-next", "e".repeat(64), "f".repeat(64), context("task-next", 3))
    ).resolves.toMatchObject({ outcome: "runtime-fenced" });
  });

  it("applies a production append transaction only when its complete authenticated frame is durable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-torn-frame-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const invocationContext = context("task-torn-frame", 1);
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-torn-frame", "a".repeat(64), "b".repeat(64), invocationContext);
    await journal.commit(
      "invocation-torn-frame",
      "a".repeat(64),
      "b".repeat(64),
      result("invocation-torn-frame"),
      invocationContext
    );
    const manifest = JSON.parse(await readFile(statePath, "utf8")) as { appendSlot: number };
    const appendPath = `${statePath}.append.${manifest.appendSlot}`;
    const completeFrame = await readFile(appendPath);
    const completeManifest = await readFile(statePath);
    const completeFloor = await readFile(`${statePath}.generation-floor`);
    expect(completeFrame.at(-1)).toBe(0x0a);
    expect(completeFrame.toString("utf8")).toContain('"mutations"');

    for (let boundary = 0; boundary < completeFrame.byteLength; boundary += 1) {
      await assertTornAppendBoundary({
        statePath,
        appendPath,
        completeFrame,
        completeManifest,
        completeFloor,
        boundary,
        invocationContext,
      });
    }

    // The exhaustive loop above exercises production recovery at every torn byte. The durable replacement path
    // only needs one repaired journal: repeating its fsync-heavy commit/restart sequence for every vector does not
    // add byte-boundary coverage and made this test exceed the full-suite budget.
    const recovered = await assertTornAppendBoundary({
      statePath,
      appendPath,
      completeFrame,
      completeManifest,
      completeFloor,
      boundary: 0,
      invocationContext,
    });
    await recovered.commit(
      "invocation-torn-frame",
      "a".repeat(64),
      "b".repeat(64),
      result("invocation-torn-frame"),
      invocationContext
    );
    const replacement = await readFile(appendPath, "utf8");
    expect(replacement.endsWith("\n")).toBe(true);
    expect(replacement.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(replacement).generation).toBe(2);
    const restarted = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await restarted.initialize();
    await expect(
      restarted.begin("invocation-torn-frame", "a".repeat(64), "b".repeat(64), invocationContext)
    ).resolves.toMatchObject({ outcome: "replay", result: { status: "succeeded" } });

    await writeFile(statePath, completeManifest);
    await writeFile(`${statePath}.generation-floor`, completeFloor);
    await writeFile(appendPath, completeFrame);
    const complete = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await complete.initialize();
    expect(await complete.currentSequence()).toBe(2);
  }, 60_000);

  it("fails closed without changing the checkpoint when a later authenticated transaction mutation is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-journal-atomic-transaction-"));
    roots.push(root);
    const statePath = path.join(root, "journal.json");
    const invocationContext = context("task-atomic-transaction", 1);
    const journal = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await journal.initialize();
    await journal.begin("invocation-atomic-transaction", "a".repeat(64), "b".repeat(64), invocationContext);
    const manifest = JSON.parse(await readFile(statePath, "utf8")) as { appendSlot: number };
    const transaction: Record<string, unknown> = {
      schemaVersion: 3,
      generation: 2,
      mutations: [
        {
          operation: "delete-entry",
          key: "task-atomic-transaction:1:invocation-atomic-transaction",
          value: null,
        },
        { operation: "delete-entry", key: "missing:1:entry", value: null },
      ],
      mac: "",
    };
    transaction.mac = journalMac("transaction", transaction);
    await writeFile(`${statePath}.append.${manifest.appendSlot}`, `${canonical(transaction)}\n`);

    const recovered = new ExecutorEffectJournal(statePath, { authenticationKey: JOURNAL_KEY });
    await expect(recovered.initialize()).rejects.toThrow(/recovery|generation/i);
    const durableManifest = JSON.parse(await readFile(statePath, "utf8")) as { checkpointSlot: number };
    expect(await readFile(`${statePath}.checkpoint.${durableManifest.checkpointSlot}`, "utf8")).toContain(
      "invocation-atomic-transaction"
    );
  });
});
