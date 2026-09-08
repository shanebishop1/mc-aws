import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  takeover: vi.fn(),
  renew: vi.fn(),
  finalize: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../../lib/server-action-lock", () => ({
  acquireServerActionLockWithOperation: mocks.acquire,
  takeOverProtectedServerActionLockWithOperation: mocks.takeover,
  renewServerActionLockWithOperation: mocks.renew,
  finalizeServerActionLockWithOperation: mocks.finalize,
}));
vi.mock("../../lib/aws/dynamodb-operation-store", () => ({
  readVersionedOperationRecord: mocks.read,
  writeVersionedOperationRecord: mocks.write,
  isOperationConditionalFailure: (error: unknown) =>
    (error as { name?: string })?.name === "ConditionalCheckFailedException",
}));

import {
  REPLACEMENT_FENCE_RENEW_INTERVAL_MS,
  type ReplacementFenceContext,
  ReplacementFenceHeartbeat,
  type ReplacementLifecycleOperation,
  assertSafeExpiredReplacementTakeover,
  claimReplacementLifecycleFence,
  initializeReplacementLifecycleOperation,
  renewReplacementLifecycleFence,
  takeOverExpiredReplacementFence,
} from "./replacement-lifecycle-operation";

type HeartbeatChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const ownerId = "11111111-1111-4111-8111-111111111111";
const takeoverOwnerId = "22222222-2222-4222-8222-222222222222";

function operation(overrides: Partial<ReplacementLifecycleOperation> = {}): ReplacementLifecycleOperation {
  return {
    schemaVersion: 1,
    kind: "mc-aws-host-replacement",
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    operationOwnerId: ownerId,
    version: 4,
    status: "running",
    phase: "prepared",
    stackId: "arn:aws:cloudformation:us-west-1:123456789012:stack/MinecraftStack/abc",
    oldInstanceId: "i-1234567890abcdef0",
    rootVolumeId: "vol-1234567890abcdef0",
    currentAmiId: "ami-11111111111111111",
    targetAmiId: "ami-22222222222222222",
    updatedAt: "2026-09-05T12:00:00.000Z",
    lockId: "lock-old",
    fencingToken: 7,
    lockLeaseGeneration: 4,
    lockLeaseExpiresAt: "2026-09-05T13:30:00.000Z",
    oldHostAgentDrained: true,
    oldHostMasked: true,
    oldHostStopped: true,
    restoreFloor: { generation: 0, backupId: "" },
    backupProof: {
      name: "host-upgrade.tar.gz",
      size: 1024,
      modifiedAt: "2026-09-05T10:30:00.000Z",
      backupId: "b".repeat(32),
      generation: 7,
      sourceInstanceId: "i-1234567890abcdef0",
      operationKey: createHash("sha256")
        .update("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\0replacement-backup")
        .digest("hex"),
      rootVolumeId: "vol-1234567890abcdef0",
      bootId: "boot-old-host",
      maintenanceOwner: "replacement-owner",
      quiescenceEpoch: "c".repeat(32),
      terminalMode: "terminal-replacement",
    },
    quiesceRequestedAt: "2026-09-05T11:00:00.000Z",
    stopRequestedAt: "2026-09-05T11:30:00.000Z",
    ...overrides,
  };
}

function context(overrides: Partial<ReplacementLifecycleOperation> = {}): ReplacementFenceContext {
  const current = operation(overrides);
  return {
    operation: current,
    fence: {
      lockId: current.lockId as string,
      fencingToken: current.fencingToken as number,
      leaseGeneration: current.lockLeaseGeneration as number,
      action: "backup",
      ownerEmail: "host-upgrade@local.invalid",
    },
  };
}

function nextContext(current: ReplacementFenceContext): ReplacementFenceContext {
  const generation = current.fence.leaseGeneration + 1;
  const version = current.operation.version + 1;
  return {
    operation: {
      ...current.operation,
      version,
      lockLeaseGeneration: generation,
      lockLeaseExpiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    fence: { ...current.fence, leaseGeneration: generation },
  };
}

function writeDurableContext(statePath: string, value: ReplacementFenceContext): void {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = openSync(temporary, "r");
  fsyncSync(descriptor);
  closeSync(descriptor);
  renameSync(temporary, statePath);
  const parent = openSync(path.dirname(statePath), "r");
  fsyncSync(parent);
  closeSync(parent);
}

function waitForChildReady(child: HeartbeatChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`heartbeat child exited before ready: ${code}/${signal}: ${stderr}`))
    );
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => {
      if (String(chunk).trim() !== "ready") {
        reject(new Error(`unexpected heartbeat child output: ${String(chunk)}`));
        return;
      }
      resolve();
    });
  });
}

function waitForChildExit(
  child: HeartbeatChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function startHeartbeatChild(statePath: string, stopAtGeneration?: number): HeartbeatChildProcess {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "scripts/aws/replacement-lifecycle-operation.ts")).href;
  const source = `
    import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
    import path from "node:path";
    const imported = await import(${JSON.stringify(moduleUrl)});
    const { ReplacementFenceHeartbeat } = imported.default ?? imported;
    const statePath = process.env.MC_TEST_REPLACEMENT_STATE;
    const stopAt = Number(process.env.MC_TEST_REPLACEMENT_STOP_AT || 0);
    const initial = JSON.parse(readFileSync(statePath, "utf8"));
    const heartbeat = new ReplacementFenceHeartbeat(initial, {
      intervalMs: 25,
      renew: async (current) => {
        const generation = current.fence.leaseGeneration + 1;
        return {
          operation: {
            ...current.operation,
            version: current.operation.version + 1,
            lockLeaseGeneration: generation,
            lockLeaseExpiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
            updatedAt: new Date().toISOString(),
          },
          fence: { ...current.fence, leaseGeneration: generation },
        };
      },
      persist: async (current) => {
        const temporary = statePath + "." + process.pid + ".tmp";
        writeFileSync(temporary, JSON.stringify(current) + "\\n", { flag: "wx", mode: 0o600 });
        const descriptor = openSync(temporary, "r");
        fsyncSync(descriptor);
        closeSync(descriptor);
        renameSync(temporary, statePath);
        const parent = openSync(path.dirname(statePath), "r");
        fsyncSync(parent);
        closeSync(parent);
        if (stopAt > 0 && current.fence.leaseGeneration >= stopAt) process.exit(0);
      },
    });
    heartbeat.start();
    setInterval(() => undefined, 1_000);
    process.stdout.write("ready\\n");
  `;
  return spawn(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MC_TEST_REPLACEMENT_STATE: statePath,
      MC_TEST_REPLACEMENT_STOP_AT: stopAtGeneration === undefined ? "" : String(stopAtGeneration),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForGeneration(statePath: string, minimum: number): Promise<ReplacementFenceContext> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = JSON.parse(readFileSync(statePath, "utf8")) as ReplacementFenceContext;
    if (current.fence.leaseGeneration >= minimum) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`heartbeat child did not persist generation ${minimum}`);
}

describe("replacement lifecycle operation fencing", () => {
  it("creates a locally persistable preparing identity before remote operation creation", () => {
    expect(
      initializeReplacementLifecycleOperation(
        {
          stackId: "arn:aws:cloudformation:us-west-1:123456789012:stack/MinecraftStack/abc",
          instanceId: "i-1234567890abcdef0",
          rootVolumeId: "vol-1234567890abcdef0",
          currentAmiId: "ami-11111111111111111",
          targetAmiId: "ami-22222222222222222",
        },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerId,
        "host-upgrade.tar.gz",
        "2026-09-05T12:00:00.000Z"
      )
    ).toMatchObject({
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operationOwnerId: ownerId,
      version: 1,
      phase: "preparing",
      backupName: "host-upgrade.tar.gz",
    });
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("protects a newly claimed replacement operation from generic expiry takeover", async () => {
    const initial = operation({
      version: 1,
      phase: "preparing",
      lockId: undefined,
      fencingToken: undefined,
      lockLeaseGeneration: undefined,
      lockLeaseExpiresAt: undefined,
    });
    let persisted: ReplacementLifecycleOperation | undefined;
    mocks.acquire.mockImplementationOnce(async (_action, _email, input) => {
      const lock = {
        lockId: "lock-protected",
        fencingToken: 8,
        leaseGeneration: 1,
        agentFenceActive: true,
        action: "backup",
        ownerEmail: "host-upgrade@local.invalid",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        operationId: initial.operationId,
        operationOwnerId: initial.operationOwnerId,
      };
      persisted = JSON.parse(input.payload(lock));
      return { lock, ownership: "acquired" };
    });
    mocks.read.mockImplementationOnce(async () => ({ version: 2, payload: JSON.stringify(persisted) }));

    await expect(claimReplacementLifecycleFence(initial)).resolves.toMatchObject({
      fence: { lockId: "lock-protected", fencingToken: 8, leaseGeneration: 1 },
    });
    expect(mocks.acquire.mock.calls[0][2].retainForAgentEffect).toBe(true);
  });

  it("renews continuously beyond 90 minutes and durably persists every matching generation", async () => {
    const persisted: ReplacementFenceContext[] = [];
    const renew = vi.fn(async (current: ReplacementFenceContext) => nextContext(current));
    const heartbeat = new ReplacementFenceHeartbeat(context(), {
      renew,
      persist: async (current) => {
        persisted.push(structuredClone(current));
      },
    });
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(95 * 60_000);
    await heartbeat.assertHealthy();

    expect(renew).toHaveBeenCalledTimes(Math.floor((95 * 60_000) / REPLACEMENT_FENCE_RENEW_INTERVAL_MS));
    expect(heartbeat.context.fence.leaseGeneration).toBe(4 + renew.mock.calls.length);
    expect(persisted.at(-1)?.operation.lockLeaseGeneration).toBe(heartbeat.context.fence.leaseGeneration);
    expect(persisted.at(-1)?.operation.version).toBe(4 + renew.mock.calls.length);
  });

  it("reconciles an ambiguous renewal response to the authoritative operation generation", async () => {
    const current = context();
    const authoritative = nextContext(current);
    mocks.renew.mockImplementationOnce(async (_lockId, _token, _input) => ({
      lock: {
        ...authoritative.fence,
        action: "backup",
        ownerEmail: "host-upgrade@local.invalid",
        createdAt: "2026-09-05T11:00:00.000Z",
        expiresAt: authoritative.operation.lockLeaseExpiresAt,
        operationId: authoritative.operation.operationId,
        operationOwnerId: ownerId,
      },
      operationPayload: JSON.stringify(authoritative.operation),
      operationVersion: authoritative.operation.version,
      ownership: "reconciled",
    }));

    await expect(renewReplacementLifecycleFence(current)).resolves.toEqual(authoritative);
    expect(mocks.renew.mock.calls[0][2].retainForAgentEffect).toBe(true);
  });

  it("serializes timer renewals and explicit checkpoints on one lease generation", async () => {
    let concurrent = 0;
    let maximumConcurrent = 0;
    const renew = vi.fn(async (current: ReplacementFenceContext) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return nextContext(current);
    });
    const heartbeat = new ReplacementFenceHeartbeat(context(), {
      intervalMs: 5,
      persist: () => undefined,
      renew,
    });
    heartbeat.start();

    const checkpoint = heartbeat.checkpoint({ phase: "executing" });
    await vi.advanceTimersByTimeAsync(100);
    await checkpoint;

    expect(maximumConcurrent).toBe(1);
    expect(heartbeat.context.operation.lockLeaseGeneration).toBe(heartbeat.context.fence.leaseGeneration);
  });

  it("durably resumes after a crash at every replacement preparation phase", async () => {
    const phases = [
      "backup-requested",
      "backup-verified",
      "quiesce-requested",
      "quiesced",
      "stop-requested",
      "old-host-safe",
      "snapshot-requested",
      "snapshot-complete",
      "change-set-requested",
      "prepared",
    ] as const;
    let persisted = context({
      phase: "preparing",
      oldHostAgentDrained: false,
      oldHostMasked: false,
      oldHostStopped: false,
      stopRequestedAt: undefined,
    });
    for (const phase of phases) {
      const heartbeat = new ReplacementFenceHeartbeat(structuredClone(persisted), {
        renew: async (current, patch) => {
          const next = nextContext(current);
          return { ...next, operation: { ...next.operation, ...patch } };
        },
        persist: (current) => {
          persisted = structuredClone(current);
        },
      });
      const patch =
        phase === "quiesced"
          ? { phase, oldHostAgentDrained: true, oldHostMasked: true }
          : phase === "stop-requested"
            ? { phase, stopRequestedAt: new Date().toISOString() }
            : phase === "old-host-safe"
              ? { phase, oldHostStopped: true, oldHostDisposition: "stopped" as const }
              : { phase };
      await heartbeat.checkpoint(patch);

      const restarted = structuredClone(persisted);
      expect(restarted.operation.phase).toBe(phase);
      expect(restarted.operation.lockLeaseGeneration).toBe(restarted.fence.leaseGeneration);
      expect(restarted.operation.version).toBe(restarted.fence.leaseGeneration);
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(persisted.operation).toMatchObject({
      phase: "prepared",
      oldHostAgentDrained: true,
      oldHostMasked: true,
      oldHostStopped: true,
      stopRequestedAt: expect.any(String),
    });
  });

  it("resumes from the latest persisted generation after reconstructing its runtime", async () => {
    let persisted = context();
    const renew = vi.fn(async (current: ReplacementFenceContext) => nextContext(current));
    const first = new ReplacementFenceHeartbeat(persisted, {
      renew,
      persist: async (current) => {
        persisted = structuredClone(current);
      },
      intervalMs: 1_000,
    });
    first.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await first.assertHealthy();
    vi.clearAllTimers();

    const restarted = new ReplacementFenceHeartbeat(persisted, {
      renew,
      persist: async (current) => {
        persisted = structuredClone(current);
      },
      intervalMs: 1_000,
    });
    restarted.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await restarted.assertHealthy();

    expect(persisted.fence.leaseGeneration).toBe(7);
    expect(renew.mock.calls[2][0].fence.leaseGeneration).toBe(6);
  });

  it("resumes from the latest fsynced generation after its heartbeat process is killed", async () => {
    vi.useRealTimers();
    const directory = mkdtempSync(path.join(tmpdir(), "mc-replacement-heartbeat-"));
    const statePath = path.join(directory, "state.json");
    let first: HeartbeatChildProcess | undefined;
    let restarted: HeartbeatChildProcess | undefined;
    try {
      writeDurableContext(statePath, context());
      first = startHeartbeatChild(statePath);
      await waitForChildReady(first);
      const beforeKill = await waitForGeneration(statePath, 6);
      const killed = waitForChildExit(first);
      first.kill("SIGKILL");
      await expect(killed).resolves.toMatchObject({ signal: "SIGKILL" });

      restarted = startHeartbeatChild(statePath, beforeKill.fence.leaseGeneration + 1);
      await waitForChildReady(restarted);
      await expect(waitForChildExit(restarted)).resolves.toMatchObject({ code: 0, signal: null });
      const recovered = JSON.parse(readFileSync(statePath, "utf8")) as ReplacementFenceContext;
      expect(recovered.fence.leaseGeneration).toBe(beforeKill.fence.leaseGeneration + 1);
      expect(recovered.operation.lockLeaseGeneration).toBe(recovered.fence.leaseGeneration);
      expect(recovered.operation.version).toBe(beforeKill.operation.version + 1);
    } finally {
      if (first && first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
      if (restarted && restarted.exitCode === null && restarted.signalCode === null) restarted.kill("SIGKILL");
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("takes over an expired operation only after durable quiescence intent and exact stopped proof", async () => {
    const stale = operation({ lockLeaseExpiresAt: "2026-09-05T11:59:59.000Z" });
    const replacement = operation({
      operationOwnerId: takeoverOwnerId,
      version: 5,
      lockId: "lock-new",
      fencingToken: 8,
      lockLeaseGeneration: 1,
      lockLeaseExpiresAt: "2026-09-05T13:30:00.000Z",
    });
    mocks.takeover.mockImplementationOnce(async (_email, input) => {
      const lock = {
        lockId: "lock-new",
        fencingToken: 8,
        leaseGeneration: 1,
        agentFenceActive: true,
        action: "backup",
        ownerEmail: "host-upgrade@local.invalid",
        createdAt: "2026-09-05T12:00:00.000Z",
        expiresAt: replacement.lockLeaseExpiresAt,
        operationId: replacement.operationId,
        operationOwnerId: takeoverOwnerId,
      };
      input.payload(lock);
      return { lock, ownership: "acquired" };
    });
    mocks.read.mockResolvedValueOnce({ version: 5, payload: JSON.stringify(replacement) });

    await expect(takeOverExpiredReplacementFence(stale, "stopped", takeoverOwnerId)).resolves.toMatchObject({
      fence: { lockId: "lock-new", fencingToken: 8, leaseGeneration: 1 },
      operation: { operationOwnerId: takeoverOwnerId, oldHostStopped: true },
    });
  });

  it("atomically invalidates prior evidence during an expired takeover after observed host activity", async () => {
    const stale = operation({ lockLeaseExpiresAt: "2026-09-05T11:59:59.000Z", oldHostSafetyCheckPending: true });
    let persisted: ReplacementLifecycleOperation | undefined;
    mocks.takeover.mockImplementationOnce(async (_email, input) => {
      const lock = {
        lockId: "lock-new",
        fencingToken: 8,
        leaseGeneration: 1,
        agentFenceActive: true,
        action: "backup",
        ownerEmail: "host-upgrade@local.invalid",
        createdAt: "2026-09-05T12:00:00.000Z",
        expiresAt: "2026-09-05T13:30:00.000Z",
        operationId: stale.operationId,
        operationOwnerId: takeoverOwnerId,
      };
      persisted = JSON.parse(input.payload(lock)) as ReplacementLifecycleOperation;
      return { lock, ownership: "acquired" };
    });
    mocks.read.mockImplementationOnce(async () => ({ version: 5, payload: JSON.stringify(persisted) }));

    await expect(takeOverExpiredReplacementFence(stale, "stopped", takeoverOwnerId, true)).resolves.toMatchObject({
      operation: {
        phase: "recovery-required",
        oldHostSafetyInvalidatedAt: expect.any(String),
        oldHostSafetyCheckPending: true,
      },
    });
    expect(persisted).toMatchObject({
      phase: "recovery-required",
      oldHostSafetyInvalidatedAt: expect.any(String),
    });
  });

  it("rejects expired takeover while the old host is active or durable quiescence intent is absent", () => {
    expect(() => assertSafeExpiredReplacementTakeover(operation(), "running")).toThrow(/old host is active/);
    expect(() => assertSafeExpiredReplacementTakeover(operation({ quiesceRequestedAt: undefined }), "stopped")).toThrow(
      /quiescence intent is absent/
    );
  });

  it.each(["stopped", "terminated", "absent"])(
    "accepts a safely evidenced expired takeover when the old host is %s",
    (disposition) => {
      expect(() => assertSafeExpiredReplacementTakeover(operation(), disposition)).not.toThrow();
    }
  );

  it.each(["pending", "running", "stopping", "shutting-down", "unknown", undefined])(
    "rejects expired takeover when old-host disposition is active or unproven: %s",
    (disposition) => {
      expect(() => assertSafeExpiredReplacementTakeover(operation(), disposition)).toThrow(/active or.*unproven/);
    }
  );
});
