import type { AgentApproval, AgentSession, PermissionPolicy } from "@/lib/agent/contracts";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import { AgentSessionDurableObject } from "@/lib/agent/state/agent-session-durable-object";
import { AgentSessionIndexDurableObject } from "@/lib/agent/state/agent-session-index-durable-object";
import { AgentSessionShardDurableObject } from "@/lib/agent/state/agent-session-shard-durable-object";
import { CloudflareAgentStateRepository } from "@/lib/agent/state/cloudflare-repository";
import type { DurableAgentSessionState } from "@/lib/agent/state/contracts";
import { InMemoryAgentStateRepository } from "@/lib/agent/state/in-memory-repository";
import { projectAgentSessionSummary } from "@/lib/agent/state/repository-metadata";
import { deserializeAgentSessionState, serializeAgentSessionState } from "@/lib/agent/state/serialization";
import { RepositoryAgentSessionStore } from "@/lib/agent/state/store";
import { runAgentStoreConformance } from "@/lib/agent/state/store-conformance.test-support";
import { describe, expect, it } from "vitest";

interface TestStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(callback: (transaction: TestStorage) => Promise<T>): Promise<T>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

interface RequestMetric {
  objectName: string;
  path: string;
  requestBytes: number;
  responseBytes: number;
}

function storage() {
  const values = new Map<string, unknown>();
  const alarms: number[] = [];
  let transactionTail = Promise.resolve();
  const api: TestStorage = {
    get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T): Promise<void> => {
      values.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => values.delete(key),
    transaction: async <T>(callback: (transaction: TestStorage) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const preceding = transactionTail;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await preceding;
      try {
        return await callback(api);
      } finally {
        release();
      }
    },
    setAlarm: async (scheduledTime: number) => {
      alarms.push(scheduledTime);
    },
  };
  return { alarms, api, values };
}

function namespaceFor<T extends { fetch(request: Request): Promise<Response> }>(
  create: (state: { storage: TestStorage }) => T,
  metrics: RequestMetric[]
) {
  const objects = new Map<string, { alarms: number[]; object: T; values: Map<string, unknown> }>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const name = String(id);
        let entry = objects.get(name);
        if (!entry) {
          const state = storage();
          entry = { alarms: state.alarms, object: create({ storage: state.api }), values: state.values };
          objects.set(name, entry);
        }
        const request = new Request(input, init);
        const requestBody = init?.body ? String(init.body) : "";
        const response = await entry.object.fetch(request);
        const cloned = response.clone();
        metrics.push({
          objectName: name,
          path: new URL(request.url).pathname,
          requestBytes: new TextEncoder().encode(requestBody).byteLength,
          responseBytes: new TextEncoder().encode(await cloned.text()).byteLength,
        });
        return response;
      },
    }),
    objects,
  };
}

function durableRepository(options: { indexUpsertFailures?: number; now?: () => Date } = {}) {
  const metrics: RequestMetric[] = [];
  const rawIndex = namespaceFor((state) => new AgentSessionIndexDurableObject(state), metrics);
  let remainingIndexUpsertFailures = options.indexUpsertFailures ?? 0;
  const index = {
    idFromName: rawIndex.idFromName,
    get: (id: unknown) => {
      const stub = rawIndex.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (new URL(String(input)).pathname === "/index/upsert" && remainingIndexUpsertFailures > 0) {
            remainingIndexUpsertFailures--;
            return Response.json({ ok: false, code: "unavailable" }, { status: 503 });
          }
          return await stub.fetch(input, init);
        },
      };
    },
    objects: rawIndex.objects,
  };
  const sessions = namespaceFor(
    (state) => new AgentSessionShardDurableObject(state, { AGENT_SESSION_INDEX_DURABLE_OBJECT: index }),
    metrics
  );
  const legacy = namespaceFor(
    (state) =>
      new AgentSessionDurableObject(state, {
        AGENT_SESSION_SHARD_DURABLE_OBJECT: sessions,
      }),
    metrics
  );
  return {
    legacy,
    index,
    sessions,
    metrics,
    repository: new CloudflareAgentStateRepository(legacy, index, sessions, { now: options.now }),
  };
}

const timestamp = (index = 0) => new Date(Date.parse("2026-09-02T12:00:00.000Z") + index * 1_000).toISOString();

function testSession(sessionId: string, status: AgentSession["status"] = "pending", at = timestamp()): AgentSession {
  return {
    schemaVersion: 1,
    sessionId,
    actorId: "actor-retention",
    status,
    createdAt: at,
    updatedAt: at,
    policyId: `policy-${sessionId}`,
    policyRevision: 1,
    harness: {
      schemaVersion: 1,
      adapterId: "fake",
      adapterVersion: "1.0.0",
      providerProfileId: "fake-provider",
      providerProfileFingerprint: "0".repeat(64),
      model: "fake-model",
    },
    turns: [],
  };
}

function stateValue(
  sessionId: string,
  options: {
    status?: AgentSession["status"];
    at?: string;
    pendingTask?: boolean;
    actorId?: string;
    revision?: number;
    marker?: string;
    pendingTaskContent?: string;
  } = {}
): string {
  const session = {
    ...testSession(sessionId, options.status, options.at),
    actorId: options.actorId ?? "actor-retention",
  };
  const policySnapshot: PermissionPolicy = createPolicyFromPreset("maintainer", `policy-${sessionId}`);
  const state: DurableAgentSessionState = {
    schemaVersion: 1,
    revision: options.revision ?? 1,
    session: {
      ...session,
      turns: options.marker
        ? [
            {
              schemaVersion: 1,
              turnId: `turn-${sessionId}`,
              kind: "user",
              content: options.marker,
              createdAt: session.createdAt,
            },
          ]
        : [],
    },
    policySnapshot,
    statusHistory: [{ schemaVersion: 1, from: null, to: session.status, at: session.createdAt, reason: "created" }],
    tasks: options.pendingTask
      ? [
          {
            schemaVersion: 1,
            taskId: `task-${sessionId}`,
            sessionId,
            status: "pending",
            content: options.pendingTaskContent ?? "bounded work",
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
        ]
      : [],
    approvals: [],
    events: [],
    nextEventSequence: 1,
    retainedFromSequence: 1,
    idempotency: [],
  };
  return serializeAgentSessionState(state);
}

function lineageStateValue(
  sessionId: string,
  revision: number,
  marker: string,
  eventId: string,
  idempotencyKey: string,
  at: string
): string {
  const state = JSON.parse(stateValue(sessionId, { revision, marker, at })) as DurableAgentSessionState;
  state.session.turns[0].turnId = `turn-${sessionId}-${marker}`;
  state.events = [
    {
      schemaVersion: 1,
      eventId,
      sessionId,
      sequence: 1,
      timestamp: at,
      kind: "model",
      payload: { schemaVersion: 1, redacted: true, data: { marker } },
      replayCursor: `${sessionId}:1`,
    },
  ];
  state.nextEventSequence = 2;
  state.idempotency = [
    {
      schemaVersion: 1,
      key: idempotencyKey,
      operation: `lineage:${marker}`,
      fingerprint: (marker === "legacy" ? "a" : "b").repeat(64),
      recordedAt: at,
    },
  ];
  return serializeAgentSessionState(state);
}

function largeLineageStateValue(sessionId: string, revision: number, marker: string, at: string): string {
  const state = JSON.parse(
    stateValue(sessionId, { revision, pendingTask: true, at, marker: `${marker}:${marker.repeat(455_000)}` })
  ) as DurableAgentSessionState;
  state.session.turns[0].turnId = `turn-${sessionId}-${marker}`;
  return serializeAgentSessionState(state);
}

function approval(
  sessionId: string,
  decision: AgentApproval["decision"],
  options: { consumedAt?: string; target?: string; kind?: AgentApproval["scope"]["kind"] } = {}
): AgentApproval {
  const digest = "a".repeat(64);
  const targetScope = {
    schemaVersion: 1 as const,
    kind: "workspace" as const,
    normalizedTarget: options.target ?? "server.properties",
  };
  return {
    schemaVersion: 1,
    approvalId: "approval-divergent",
    actorId: "actor-retention",
    sessionId,
    policyId: `policy-${sessionId}`,
    policyRevision: 1,
    invocationDigest: digest,
    invocationSummary: {
      schemaVersion: 1,
      invocationId: "invocation-divergent",
      invocationDigest: digest,
      toolId: "workspace.write",
      capability: "workspace.write",
      targetScope,
      risk: "risky",
      sanitizedArguments: { path: targetScope.normalizedTarget },
    },
    invocationSummaryDigest: "b".repeat(64),
    scope: {
      schemaVersion: 1,
      kind: options.kind ?? "single-invocation",
      capability: "workspace.write",
      targetScope,
      risk: "risky",
    },
    expiresAt: timestamp(100),
    decision,
    reason: decision === "pending" ? "" : decision,
    ...(decision === "pending" ? {} : { decidedAt: timestamp(3) }),
    ...(options.consumedAt ? { consumedAt: options.consumedAt } : {}),
  };
}

function stateWithApproval(sessionId: string, revision: number, at: string, value: AgentApproval): string {
  const state = JSON.parse(stateValue(sessionId, { revision, at })) as DurableAgentSessionState;
  state.approvals = [value];
  return serializeAgentSessionState(state);
}

function cancelledStateValue(sessionId: string, revision: number, at: string): string {
  const state = JSON.parse(
    stateValue(sessionId, { revision, pendingTask: true, at: timestamp(), marker: "before-cancellation" })
  ) as DurableAgentSessionState;
  state.session.status = "cancelled";
  state.session.updatedAt = at;
  state.session.turns[0].turnId = `turn-${sessionId}-cancelled`;
  state.statusHistory.push({
    schemaVersion: 1,
    from: "pending",
    to: "cancelled",
    at,
    reason: "mixed-version cancellation",
  });
  for (const task of state.tasks) {
    task.status = "cancelled";
    task.updatedAt = at;
    task.lease = undefined;
  }
  state.cancellation = {
    schemaVersion: 1,
    requestedAt: at,
    requestedBy: "admin-1",
    reason: "mixed-version cancellation",
  };
  return serializeAgentSessionState(state);
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeLegacyRevision(
  legacy: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  sessionId: string,
  revision: number,
  marker: string
): Promise<void> {
  expect(
    (
      await legacy.fetch("https://agent-session.internal/repository/create", {
        method: "POST",
        body: JSON.stringify({ sessionId, value: stateValue(sessionId, { marker: `${marker}-1` }) }),
      })
    ).status
  ).toBe(200);
  for (let current = 1; current < revision; current++) {
    const response = await legacy.fetch("https://agent-session.internal/repository/cas", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        expectedRevision: current,
        value: stateValue(sessionId, {
          revision: current + 1,
          marker: `${marker}-${current + 1}`,
          at: timestamp(current + 1),
        }),
      }),
    });
    expect(response.status).toBe(200);
  }
}

runAgentStoreConformance("in-memory", () => new InMemoryAgentStateRepository());
runAgentStoreConformance("sharded Durable Object", () => durableRepository().repository);

describe("sharded AgentSession Durable Object persistence", () => {
  it("uses one object per session and rejects malformed shard requests", async () => {
    const { repository, sessions } = durableRepository();
    await repository.create("session-one", stateValue("session-one"));
    await repository.create("session-two", stateValue("session-two"));
    expect(sessions.objects.has("mc-aws-agent-session-v2:session-one")).toBe(true);
    expect(sessions.objects.has("mc-aws-agent-session-v2:session-two")).toBe(true);

    const shard = sessions.get("mc-aws-agent-session-v2:bad");
    const response = await shard.fetch("https://agent-session.internal/session/create", {
      method: "POST",
      body: JSON.stringify({ sessionId: "bad/session", value: "{}" }),
    });
    expect(response.status).toBe(400);
  });

  it("retains a revision-stamped index outbox and retries a failed coordinator update", async () => {
    const state = storage();
    let unavailable = true;
    const index = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          unavailable ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, applied: true }),
      }),
    };
    const shard = new AgentSessionShardDurableObject(
      { storage: state.api },
      { AGENT_SESSION_INDEX_DURABLE_OBJECT: index }
    );
    const created = await shard.fetch(
      new Request("https://agent-session.internal/session/create", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-outbox", value: stateValue("session-outbox") }),
      })
    );
    expect(created.status).toBe(200);
    expect(state.values.has("agent-session-index-outbox-v2")).toBe(true);
    expect(state.alarms).toHaveLength(1);

    unavailable = false;
    await shard.alarm();
    expect(state.values.has("agent-session-index-outbox-v2")).toBe(false);
  });

  it("archives idle detail, keeps its summary listable, and reopens it through CAS", async () => {
    const fixture = durableRepository();
    const store = new RepositoryAgentSessionStore(fixture.repository);
    await store.createSession({
      session: testSession("session-archive"),
      policySnapshot: createPolicyFromPreset("maintainer", "policy-session-archive"),
      idempotencyKey: "create",
    });
    const running = await store.transitionSession({
      sessionId: "session-archive",
      expectedRevision: 1,
      idempotencyKey: "running",
      status: "running",
      at: timestamp(1),
      reason: "running",
    });
    const idle = await store.transitionSession({
      sessionId: "session-archive",
      expectedRevision: running.state.revision,
      idempotencyKey: "idle",
      status: "idle",
      at: timestamp(2),
      reason: "successful turn",
    });
    const shard = fixture.sessions.objects.get("mc-aws-agent-session-v2:session-archive")?.values;
    expect(shard?.has("agent-session-active-v2")).toBe(false);
    expect(shard?.has("agent-session-archive-v2")).toBe(true);
    expect((await store.listSessionSummaries(10, "actor-retention"))[0]).toMatchObject({
      sessionId: "session-archive",
      archived: true,
    });

    const reopened = await store.addTask({
      sessionId: "session-archive",
      expectedRevision: idle.state.revision,
      idempotencyKey: "continue",
      task: {
        schemaVersion: 1,
        taskId: "task-reopened",
        sessionId: "session-archive",
        status: "pending",
        content: "continue",
        createdAt: timestamp(3),
        updatedAt: timestamp(3),
      },
    });
    expect(reopened.state.session.status).toBe("pending");
    expect(shard?.has("agent-session-active-v2")).toBe(true);
    expect(shard?.has("agent-session-archive-v2")).toBe(false);
  });

  it("retains more than 500 ordinary idle sessions without exhausting creation", async () => {
    const { repository } = durableRepository();
    for (let index = 0; index < 550; index++) {
      const id = `idle-${String(index).padStart(4, "0")}`;
      await repository.create(id, stateValue(id, { status: "idle", at: timestamp(index) }));
    }
    await repository.create("new-pending", stateValue("new-pending", { pendingTask: true, at: timestamp(600) }));
    expect(await repository.read("idle-0000")).not.toBeNull();
    expect(await repository.listSummaries(100, "actor-retention")).toHaveLength(100);
  }, 30_000);

  it("lists the newest summaries from a 10k paged index without loading session detail", async () => {
    const fixture = durableRepository();
    const indexStub = fixture.index.get("mc-aws-agent-session-index-v2");
    for (let index = 0; index < 10_000; index++) {
      const id = `summary-${String(index).padStart(5, "0")}`;
      const summary = projectAgentSessionSummary(
        JSON.parse(stateValue(id, { status: "idle", at: timestamp(index), actorId: "actor-scale" }))
      );
      const response = await indexStub.fetch("https://agent-session.internal/index/upsert", {
        method: "POST",
        body: JSON.stringify({ summary }),
      });
      expect(response.status).toBe(200);
    }
    fixture.metrics.length = 0;
    const summaries = await fixture.repository.listSummaries(100, "actor-scale");
    expect(summaries).toHaveLength(100);
    expect(summaries[0].sessionId).toBe("summary-09999");
    expect(fixture.metrics.some((metric) => metric.path.startsWith("/session/"))).toBe(false);
  }, 30_000);

  it("progressively migrates bounded singleton records", async () => {
    const fixture = durableRepository();
    const legacy = fixture.legacy.get("mc-aws-agent-control-plane-v1");
    for (let index = 0; index < 12; index++) {
      const id = `legacy-${index}`;
      const response = await legacy.fetch("https://agent-session.internal/repository/create", {
        method: "POST",
        body: JSON.stringify({ sessionId: id, value: stateValue(id, { status: "idle", at: timestamp(index) }) }),
      });
      expect(response.status).toBe(200);
    }
    expect(await fixture.repository.listSummaries(100, "actor-retention")).toHaveLength(1);
    for (let index = 1; index < 12; index++) {
      await fixture.repository.listSummaries(100, "actor-retention");
    }
    expect(await fixture.repository.listSummaries(100, "actor-retention")).toHaveLength(12);
    expect(fixture.sessions.objects.has("mc-aws-agent-session-v2:legacy-0")).toBe(true);
    expect(await fixture.repository.read("legacy-0")).not.toBeNull();
  });

  it("imports a legacy aggregate above revision one exactly and idempotently", async () => {
    const state = storage();
    const shard = new AgentSessionShardDurableObject({ storage: state.api });
    const value = stateValue("legacy-revision-seven", { revision: 7, marker: "legacy-seven" });
    const source = {
      schemaVersion: 1,
      kind: "legacy-singleton-v1",
      epoch: 2,
      revision: 7,
      digest: await sha256(value),
    };
    const request = () =>
      shard.fetch(
        new Request("https://agent-session.internal/session/import", {
          method: "POST",
          body: JSON.stringify({ sessionId: "legacy-revision-seven", value, source }),
        })
      );
    expect(await (await request()).json()).toMatchObject({ ok: true, applied: true, revision: 7 });
    expect(await (await request()).json()).toMatchObject({ ok: true, applied: false, revision: 7 });
    expect(state.values.get("agent-session-migration-watermark-v2")).toEqual(source);
    const read = await shard.fetch(
      new Request("https://agent-session.internal/session/read", {
        method: "POST",
        body: JSON.stringify({ sessionId: "legacy-revision-seven" }),
      })
    );
    expect(await read.json()).toMatchObject({ ok: true, record: { revision: 7, value } });
    const revisionEight = stateValue("legacy-revision-seven", { revision: 8, marker: "post-import-cas" });
    const cas = () =>
      shard.fetch(
        new Request("https://agent-session.internal/session/cas", {
          method: "POST",
          body: JSON.stringify({
            sessionId: "legacy-revision-seven",
            expectedRevision: 7,
            value: revisionEight,
          }),
        })
      );
    expect((await cas()).status).toBe(200);
    expect((await cas()).status).toBe(409);
  });

  it("keeps rollback and re-upgrade cancellation monotonic through the epoch facade", async () => {
    let now = new Date("2026-09-02T12:00:00.000Z");
    const fixture = durableRepository({ now: () => now });
    const legacy = fixture.legacy.get("mc-aws-agent-control-plane-v1");
    await writeLegacyRevision(legacy, "rollback-session", 5, "legacy-initial");
    await fixture.repository.listSummaries(10);
    expect((await fixture.repository.read("rollback-session"))?.revision).toBe(5);
    const legacyValues = fixture.legacy.objects.get("mc-aws-agent-control-plane-v1")?.values;
    const fencedLegacyRecord = legacyValues?.get("agent-session-v1:rollback-session");
    expect(fencedLegacyRecord).toBe('{"schemaVersion":0,"kind":"agent-session-write-fence-v2"}');
    expect(() => deserializeAgentSessionState(String(fencedLegacyRecord))).toThrow(
      /unknown field|unsupported version/i
    );
    expect(legacyValues?.get("agent-session-migration-source-v2:rollback-session")).toBeDefined();

    const cancelled = cancelledStateValue("rollback-session", 6, timestamp(6));
    await fixture.repository.compareAndSwap("rollback-session", 5, cancelled);
    const rollbackRead = await legacy.fetch("https://agent-session.internal/repository/read", {
      method: "POST",
      body: JSON.stringify({ sessionId: "rollback-session" }),
    });
    expect(await rollbackRead.json()).toMatchObject({ ok: true, record: { revision: 6, value: cancelled } });
    const rollbackCas = await legacy.fetch("https://agent-session.internal/repository/cas", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "rollback-session",
        expectedRevision: 6,
        value: stateValue("rollback-session", {
          revision: 7,
          pendingTask: true,
          marker: "legacy-active-after-cancellation",
          at: timestamp(7),
        }),
      }),
    });
    expect(rollbackCas.status).toBe(409);

    const cancelledRevisionSeven = JSON.parse(cancelled) as DurableAgentSessionState;
    cancelledRevisionSeven.revision = 7;
    cancelledRevisionSeven.session.updatedAt = timestamp(7);
    const staleEpochCas = await fixture.sessions
      .get("mc-aws-agent-session-v2:rollback-session")
      .fetch("https://agent-session.internal/session/cas-value", {
        method: "POST",
        headers: {
          "x-agent-session-id": "rollback-session",
          "x-agent-expected-revision": "6",
          "x-agent-migration-epoch": "1",
        },
        body: serializeAgentSessionState(cancelledRevisionSeven),
      });
    expect(staleEpochCas.status).toBe(409);
    const validFacadeCas = await legacy.fetch("https://agent-session.internal/repository/cas", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "rollback-session",
        expectedRevision: 6,
        value: serializeAgentSessionState(cancelledRevisionSeven),
      }),
    });
    expect(validFacadeCas.status).toBe(200);

    now = new Date(now.getTime() + 6 * 60_000);
    const reupgraded = new CloudflareAgentStateRepository(fixture.legacy, fixture.index, fixture.sessions, {
      now: () => now,
    });
    await reupgraded.listSummaries(10);
    const reconciled = await reupgraded.read("rollback-session");
    expect(reconciled?.revision).toBe(7);
    expect(JSON.parse(reconciled!.value).session.status).toBe("cancelled");
    expect(JSON.parse(reconciled!.value).tasks[0].status).toBe("cancelled");
    expect((await reupgraded.read("rollback-session"))?.revision).toBe(7);
  });

  it("makes cancellation win a migration probe/CAS race against later active legacy state", async () => {
    const state = storage();
    const shard = new AgentSessionShardDurableObject({ storage: state.api });
    const initial = stateValue("cancel-race", { revision: 5, pendingTask: true, at: timestamp(1) });
    const initialSource = {
      schemaVersion: 1,
      kind: "legacy-singleton-v1",
      epoch: 1,
      revision: 5,
      digest: await sha256(initial),
    };
    const importValue = async (value: string, source: typeof initialSource) =>
      await shard.fetch(
        new Request("https://agent-session.internal/session/import", {
          method: "POST",
          body: JSON.stringify({ sessionId: "cancel-race", value, source }),
        })
      );
    expect((await importValue(initial, initialSource)).status).toBe(200);
    const legacyActive = stateValue("cancel-race", {
      revision: 6,
      pendingTask: true,
      marker: "active-legacy-after-probe",
      at: timestamp(7),
    });
    const legacySource = { ...initialSource, epoch: 2, revision: 6, digest: await sha256(legacyActive) };
    const probe = await shard.fetch(
      new Request("https://agent-session.internal/session/migration-probe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "cancel-race", source: legacySource }),
      })
    );
    expect(await probe.json()).toMatchObject({ ok: true, needsImport: true });

    const cancellationCas = await shard.fetch(
      new Request("https://agent-session.internal/session/cas", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "cancel-race",
          expectedRevision: 5,
          value: cancelledStateValue("cancel-race", 6, timestamp(6)),
        }),
      })
    );
    expect(cancellationCas.status).toBe(200);
    const mergedResponse = await importValue(legacyActive, legacySource);
    expect(await mergedResponse.json()).toMatchObject({
      ok: true,
      revision: 7,
      summary: { status: "cancelled", work: null },
    });
    const merged = state.values.get("agent-session-archive-v2") as string;
    expect(JSON.parse(merged)).toMatchObject({
      session: { status: "cancelled" },
      tasks: [{ status: "cancelled" }],
    });

    const resurrect = stateValue("cancel-race", {
      revision: 8,
      pendingTask: true,
      marker: "resurrect-cancelled-task",
      at: timestamp(8),
    });
    const resurrectionCas = await shard.fetch(
      new Request("https://agent-session.internal/session/cas", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "cancel-race",
          expectedRevision: 7,
          value: resurrect,
        }),
      })
    );
    expect(resurrectionCas.status).toBe(409);
  });

  it("merges divergent lineage evidence and keeps the merged revision CAS-writable", async () => {
    const state = storage();
    const shard = new AgentSessionShardDurableObject({ storage: state.api });
    const shardValue = lineageStateValue("lineage-session", 6, "shard", "event-shard", "op-shard", timestamp(6));
    const legacyValue = lineageStateValue("lineage-session", 6, "legacy", "event-legacy", "op-legacy", timestamp(7));
    const importValue = async (value: string, epoch: number) =>
      await shard.fetch(
        new Request("https://agent-session.internal/session/import", {
          method: "POST",
          body: JSON.stringify({
            sessionId: "lineage-session",
            value,
            source: {
              schemaVersion: 1,
              kind: "legacy-singleton-v1",
              epoch,
              revision: 6,
              digest: await sha256(value),
            },
          }),
        })
      );
    expect((await importValue(shardValue, 1)).status).toBe(200);
    const mergedResponse = await importValue(legacyValue, 2);
    expect(await mergedResponse.json()).toMatchObject({ ok: true, applied: true, revision: 7 });

    const read = await shard.fetch(
      new Request("https://agent-session.internal/session/read", {
        method: "POST",
        body: JSON.stringify({ sessionId: "lineage-session" }),
      })
    );
    const payload = (await read.json()) as { record: { value: string } };
    const merged = JSON.parse(payload.record.value) as DurableAgentSessionState;
    expect(merged.session.turns.map((turn) => turn.content)).toEqual(["legacy", "shard"]);
    expect(merged.events.map((event) => event.eventId)).toEqual(["event-legacy", "event-shard"]);
    expect(merged.idempotency.map((entry) => entry.key)).toEqual(["op-legacy", "op-shard"]);

    merged.revision = 8;
    merged.session.updatedAt = timestamp(8);
    const cas = await shard.fetch(
      new Request("https://agent-session.internal/session/cas", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "lineage-session",
          expectedRevision: 7,
          value: serializeAgentSessionState(merged),
        }),
      })
    );
    expect(cas.status).toBe(200);
  });

  it.each([
    ["denied", approval("approval-denied", "approved"), approval("approval-denied", "denied")],
    [
      "revoked",
      approval("approval-revoked", "approved", { kind: "session-capability" }),
      approval("approval-revoked", "revoked", { kind: "session-capability" }),
    ],
    [
      "consumed",
      approval("approval-consumed", "approved"),
      approval("approval-consumed", "approved", { consumedAt: timestamp(4) }),
    ],
  ] as const)(
    "keeps %s approval authority removal monotonic across divergent migration",
    async (_kind, active, terminal) => {
      const state = storage();
      const shard = new AgentSessionShardDurableObject({ storage: state.api });
      const sessionId = active.sessionId;
      const current = stateWithApproval(sessionId, 6, timestamp(8), active);
      const imported = stateWithApproval(sessionId, 6, timestamp(9), terminal);
      const importValue = async (value: string, epoch: number) =>
        await shard.fetch(
          new Request("https://agent-session.internal/session/import", {
            method: "POST",
            body: JSON.stringify({
              sessionId,
              value,
              source: {
                schemaVersion: 1,
                kind: "legacy-singleton-v1",
                epoch,
                revision: 6,
                digest: await sha256(value),
              },
            }),
          })
        );
      expect((await importValue(current, 1)).status).toBe(200);
      expect((await importValue(imported, 2)).status).toBe(200);
      const stored = JSON.parse(state.values.get("agent-session-active-v2") as string) as DurableAgentSessionState;
      expect(stored.approvals).toHaveLength(1);
      expect(stored.approvals[0]).toMatchObject({
        decision: terminal.decision,
        ...(terminal.consumedAt ? { consumedAt: terminal.consumedAt } : {}),
      });
    }
  );

  it("fails closed when divergent migration reuses an approval ID for another immutable scope", async () => {
    const state = storage();
    const shard = new AgentSessionShardDurableObject({ storage: state.api });
    const sessionId = "approval-conflict";
    const current = stateWithApproval(sessionId, 4, timestamp(4), approval(sessionId, "approved"));
    const conflicting = stateWithApproval(
      sessionId,
      4,
      timestamp(5),
      approval(sessionId, "denied", { target: "world/level.dat" })
    );
    const importValue = async (value: string, epoch: number) =>
      await shard.fetch(
        new Request("https://agent-session.internal/session/import", {
          method: "POST",
          body: JSON.stringify({
            sessionId,
            value,
            source: {
              schemaVersion: 1,
              kind: "legacy-singleton-v1",
              epoch,
              revision: 4,
              digest: await sha256(value),
            },
          }),
        })
      );
    expect((await importValue(current, 1)).status).toBe(200);
    expect((await importValue(conflicting, 2)).status).toBe(409);
  });

  it("migrates and reads escape-heavy state whose JSON envelope exceeds one megabyte", async () => {
    const fixture = durableRepository();
    const sessionId = "escaped-migration";
    const value = stateValue(sessionId, {
      pendingTask: true,
      pendingTaskContent: '"'.repeat(380_000),
    });
    expect(new TextEncoder().encode(value).byteLength).toBeLessThan(900_000);
    expect(new TextEncoder().encode(JSON.stringify({ sessionId, value })).byteLength).toBeGreaterThan(1_000_000);
    const legacy = fixture.legacy.get("mc-aws-agent-control-plane-v1");
    expect(
      (
        await legacy.fetch("https://agent-session.internal/repository/create", {
          method: "POST",
          body: JSON.stringify({ sessionId, value }),
        })
      ).status
    ).toBe(200);

    fixture.metrics.length = 0;
    await fixture.repository.listSummaries(10);
    const migrated = await fixture.repository.read(sessionId);
    expect(migrated?.value).toBe(value);
    expect(fixture.metrics.some((metric) => metric.path === "/repository/migration-value")).toBe(true);
    expect(fixture.metrics.some((metric) => metric.path === "/session/import-value")).toBe(true);
    expect(fixture.metrics.every((metric) => metric.requestBytes <= 1_000_000)).toBe(true);
  });

  it("quarantines an over-budget lineage merge and advances migration to healthy work", async () => {
    const fixture = durableRepository();
    const sessionId = "merge-over-budget";
    const current = largeLineageStateValue(sessionId, 1, "a", timestamp(1));
    const legacyValue = largeLineageStateValue(sessionId, 1, "b", timestamp(2));
    expect(new TextEncoder().encode(current).byteLength).toBeLessThan(900_000);
    expect(new TextEncoder().encode(legacyValue).byteLength).toBeLessThan(900_000);
    await fixture.repository.create(sessionId, current);

    const legacy = fixture.legacy.get("mc-aws-agent-control-plane-v1");
    await legacy.fetch("https://agent-session.internal/repository/migration-version", {
      method: "POST",
      body: JSON.stringify({ sessionId: "initialize-legacy" }),
    });
    const legacyValues = fixture.legacy.objects.get("mc-aws-agent-control-plane-v1")!.values;
    legacyValues.set("agent-session-index-v1", [sessionId, "healthy-after-quarantine"]);
    legacyValues.set(`agent-session-v1:${sessionId}`, legacyValue);
    legacyValues.set(
      "agent-session-v1:healthy-after-quarantine",
      stateValue("healthy-after-quarantine", { pendingTask: true, at: timestamp(3) })
    );

    await expect(fixture.repository.listSummaries(10)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId })])
    );
    const migrationState = await fixture.index
      .get("mc-aws-agent-session-index-v2")
      .fetch("https://agent-session.internal/index/migration-state", {
        method: "POST",
        body: JSON.stringify({ sourceEpoch: 2, now: timestamp(4) }),
      });
    expect(await migrationState.json()).toMatchObject({ migration: { cursor: 1 } });
    const shardValues = fixture.sessions.objects.get(`mc-aws-agent-session-v2:${sessionId}`)!.values;
    expect(shardValues.get("agent-session-migration-quarantine-source-v2")).toBe(legacyValue);
    expect(shardValues.get("agent-session-migration-quarantine-v2")).toMatchObject({
      reason: "migration-merge-over-budget",
      currentRevision: 1,
      source: { revision: 1 },
    });
    const shard = fixture.sessions.get(`mc-aws-agent-session-v2:${sessionId}`);
    const recoveryMetadata = await shard.fetch("https://agent-session.internal/session/migration-quarantine", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    expect(await recoveryMetadata.json()).toMatchObject({
      ok: true,
      quarantine: { reason: "migration-merge-over-budget", currentRevision: 1 },
    });
    const recoveryValue = await shard.fetch("https://agent-session.internal/session/migration-quarantine-value", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    expect(await recoveryValue.text()).toBe(legacyValue);

    const work = await new RepositoryAgentSessionStore(fixture.repository).leaseNextRuntimeWork({
      runtimeId: "runtime-quarantine",
      claimId: "claim-quarantine",
      leaseId: "lease-quarantine",
      now: timestamp(10),
      leaseDurationMs: 20_000,
    });
    expect(work?.session.sessionId).toBe("healthy-after-quarantine");
    expect(fixture.metrics.every((metric) => metric.requestBytes <= 1_000_000)).toBe(true);
  });

  it("migrates more than 500 legacy records through bounded one-record scans", async () => {
    const fixture = durableRepository();
    await fixture.legacy
      .get("mc-aws-agent-control-plane-v1")
      .fetch("https://agent-session.internal/repository/migration-version", {
        method: "POST",
        body: JSON.stringify({ sessionId: "seed-legacy-storage" }),
      });
    const legacyState = fixture.legacy.objects.get("mc-aws-agent-control-plane-v1")?.values;
    const ids = Array.from({ length: 501 }, (_, index) => `bulk-legacy-${String(index).padStart(3, "0")}`);
    legacyState?.set("agent-session-index-v1", ids);
    for (let index = 0; index < ids.length; index++) {
      legacyState?.set(
        `agent-session-v1:${ids[index]}`,
        stateValue(ids[index], { status: "idle", revision: 2, at: timestamp(index) })
      );
    }
    fixture.metrics.length = 0;
    await fixture.repository.listSummaries(1);
    expect(fixture.metrics.filter((metric) => metric.path === "/session/import-value")).toHaveLength(1);
    expect(fixture.metrics.every((metric) => metric.requestBytes <= 1_000_000)).toBe(true);
    for (let index = 1; index < ids.length; index++) await fixture.repository.listSummaries(1);
    expect(fixture.sessions.objects.size).toBe(501);
    expect((await fixture.repository.read(ids[500]))?.revision).toBe(2);
  }, 30_000);

  it("spills a full work-index page without rejecting or hiding an accepted task", async () => {
    const fixture = durableRepository();
    const index = fixture.index.get("mc-aws-agent-session-index-v2");
    for (let position = 0; position < 100; position++) {
      const sessionId = `stale-work-${String(position).padStart(3, "0")}`;
      const pending = projectAgentSessionSummary(
        JSON.parse(stateValue(sessionId, { pendingTask: true, at: timestamp(position) }))
      );
      expect(
        (
          await index.fetch("https://agent-session.internal/index/upsert", {
            method: "POST",
            body: JSON.stringify({ summary: pending }),
          })
        ).status
      ).toBe(200);
      const idle = projectAgentSessionSummary(
        JSON.parse(stateValue(sessionId, { status: "idle", revision: 2, at: timestamp(position + 1) }))
      );
      expect(
        (
          await index.fetch("https://agent-session.internal/index/upsert", {
            method: "POST",
            body: JSON.stringify({ summary: idle }),
          })
        ).status
      ).toBe(200);
    }
    const accepted = projectAgentSessionSummary(
      JSON.parse(stateValue("accepted-after-full-page", { pendingTask: true, at: timestamp(200) }))
    );
    expect(
      (
        await index.fetch("https://agent-session.internal/index/upsert", {
          method: "POST",
          body: JSON.stringify({ summary: accepted }),
        })
      ).status
    ).toBe(200);
    const candidates = await index.fetch("https://agent-session.internal/index/work-candidates", {
      method: "POST",
      body: JSON.stringify({ runtimeId: "runtime-a", claimId: "claim-a", now: timestamp(300), limit: 4 }),
    });
    expect(await candidates.json()).toEqual({ ok: true, sessionIds: ["accepted-after-full-page"] });
  });

  it("makes newly appended work visible after the queue drains completely", async () => {
    const fixture = durableRepository();
    const index = fixture.index.get("mc-aws-agent-session-index-v2");
    const upsert = async (summary: ReturnType<typeof projectAgentSessionSummary>) =>
      await index.fetch("https://agent-session.internal/index/upsert", {
        method: "POST",
        body: JSON.stringify({ summary }),
      });
    await upsert(projectAgentSessionSummary(JSON.parse(stateValue("drain-reappend", { pendingTask: true }))));
    await upsert(projectAgentSessionSummary(JSON.parse(stateValue("drain-reappend", { status: "idle", revision: 2 }))));
    const poll = () =>
      index.fetch("https://agent-session.internal/index/work-candidates", {
        method: "POST",
        body: JSON.stringify({ runtimeId: "runtime-a", claimId: "claim-a", now: timestamp(10), limit: 4 }),
      });
    expect(await (await poll()).json()).toEqual({ ok: true, sessionIds: [] });
    await upsert(
      projectAgentSessionSummary(
        JSON.parse(stateValue("drain-reappend", { pendingTask: true, revision: 3, at: timestamp(3) }))
      )
    );
    expect(await (await poll()).json()).toEqual({ ok: true, sessionIds: ["drain-reappend"] });
  });

  it("durably quarantines four near-772 KB poison candidates and leases healthy work", async () => {
    const fixture = durableRepository();
    for (let index = 0; index < 4; index++) {
      const sessionId = `poll-poison-${index}`;
      const poison = stateValue(sessionId, {
        pendingTask: true,
        pendingTaskContent: "x".repeat(700_000),
        at: timestamp(index + 1),
      });
      expect(new TextEncoder().encode(poison).byteLength).toBeLessThanOrEqual(772_000);
      await fixture.repository.create(sessionId, poison);
    }
    await fixture.repository.create(
      "poll-after-poison",
      stateValue("poll-after-poison", { pendingTask: true, at: timestamp(5) })
    );
    fixture.metrics.length = 0;
    const work = await new RepositoryAgentSessionStore(fixture.repository).leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-a",
      leaseId: "lease-a",
      now: timestamp(10),
      leaseDurationMs: 20_000,
    });
    expect(work?.session.sessionId).toBe("poll-after-poison");
    expect(fixture.metrics.filter((metric) => metric.path === "/index/work-quarantine")).toHaveLength(4);
    expect(fixture.metrics.filter((metric) => metric.path === "/index/work-claim")).toHaveLength(5);
    expect(fixture.metrics.filter((metric) => metric.path === "/session/read-value")).toHaveLength(6);
    expect(fixture.metrics.every((metric) => metric.requestBytes <= 1_000_000)).toBe(true);
  });

  it("acknowledges an accepted task while indexing is down and makes it pollable by alarm retry", async () => {
    const fixture = durableRepository({ indexUpsertFailures: 2 });
    await expect(
      fixture.repository.create(
        "accepted-outbox-task",
        stateValue("accepted-outbox-task", { pendingTask: true, at: timestamp(1) })
      )
    ).resolves.toBeUndefined();
    const shard = fixture.sessions.objects.get("mc-aws-agent-session-v2:accepted-outbox-task");
    expect(shard?.values.has("agent-session-index-outbox-v2")).toBe(true);
    expect(shard?.alarms).toHaveLength(1);
    await shard?.object.alarm();
    expect(shard?.values.has("agent-session-index-outbox-v2")).toBe(false);

    const work = await new RepositoryAgentSessionStore(fixture.repository).leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-outbox",
      leaseId: "lease-outbox",
      now: timestamp(10),
      leaseDurationMs: 20_000,
    });
    expect(work?.session.sessionId).toBe("accepted-outbox-task");
  });

  it("polls only a bounded fair work-candidate batch and never reads idle detail", async () => {
    const fixture = durableRepository();
    for (let index = 0; index < 520; index++) {
      const id = `poll-idle-${index}`;
      await fixture.repository.create(id, stateValue(id, { status: "idle", at: timestamp(index) }));
    }
    for (let index = 0; index < 8; index++) {
      const id = `poll-work-${index}`;
      await fixture.repository.create(id, stateValue(id, { pendingTask: true, at: timestamp(1_000 + index) }));
    }
    fixture.metrics.length = 0;
    const store = new RepositoryAgentSessionStore(fixture.repository);
    const lease = await store.leaseNextRuntimeWork({
      runtimeId: "runtime-a",
      claimId: "claim-a",
      leaseId: "lease-a",
      now: timestamp(2_000),
      leaseDurationMs: 20_000,
    });
    expect(lease?.session.sessionId).toBe("poll-work-0");
    const detailRequests = fixture.metrics.filter((metric) => metric.path === "/session/read-value");
    expect(detailRequests.length).toBeLessThanOrEqual(4);
    expect(detailRequests.every((metric) => metric.objectName.includes("poll-work-"))).toBe(true);
    expect(fixture.metrics.length).toBeLessThanOrEqual(16);
    expect(fixture.metrics.every((metric) => metric.requestBytes <= 1_000_000)).toBe(true);
    expect(detailRequests.reduce((total, metric) => total + metric.responseBytes, 0)).toBeLessThanOrEqual(3_700_000);
  }, 30_000);

  it("issues one runtime-wide coordinator claim across racing shard lease requests", async () => {
    const fixture = durableRepository();
    await fixture.repository.create(
      "claim-race-a",
      stateValue("claim-race-a", { pendingTask: true, at: timestamp(1) })
    );
    await fixture.repository.create(
      "claim-race-b",
      stateValue("claim-race-b", { pendingTask: true, at: timestamp(2) })
    );
    const store = new RepositoryAgentSessionStore(fixture.repository);
    const [first, second] = await Promise.all([
      store.leaseNextRuntimeWork({
        runtimeId: "runtime-claim-race",
        claimId: "claim-race-first",
        leaseId: "lease-race-first",
        now: timestamp(10),
        leaseDurationMs: 20_000,
      }),
      store.leaseNextRuntimeWork({
        runtimeId: "runtime-claim-race",
        claimId: "claim-race-second",
        leaseId: "lease-race-second",
        now: timestamp(10),
        leaseDurationMs: 20_000,
      }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const winner = [first, second].find((assignment) => assignment !== null)!;
    expect(winner.session.sessionId).toBe("claim-race-a");
    const renewed = await store.renewRuntimeWork({
      sessionId: winner.session.sessionId,
      taskId: winner.task.taskId,
      leaseId: winner.lease.leaseId,
      runtimeId: winner.lease.runtimeId,
      expectedRevision: winner.revision,
      idempotencyKey: "renew-coordinator-claim",
      at: timestamp(25),
      leaseDurationMs: 20_000,
    });
    expect(renewed.state.tasks[0].lease?.expiresAt).toBe(timestamp(45));
    await expect(
      store.leaseNextRuntimeWork({
        runtimeId: "runtime-claim-race",
        claimId: "claim-race-after-original-expiry",
        leaseId: "lease-race-after-original-expiry",
        now: timestamp(35),
        leaseDurationMs: 20_000,
      })
    ).resolves.toBeNull();
  });

  it("rejects a shard lease CAS without its exact coordinator-issued claim token", async () => {
    const fixture = durableRepository();
    const sessionId = "claim-required";
    await fixture.repository.create(sessionId, stateValue(sessionId, { pendingTask: true }));
    const next = JSON.parse(
      stateValue(sessionId, { pendingTask: true, revision: 2, at: timestamp(1) })
    ) as DurableAgentSessionState;
    next.tasks[0].lease = {
      schemaVersion: 1,
      leaseId: "lease-forged",
      claimId: "claim-forged",
      runtimeId: "runtime-forged",
      generation: 1,
      acquiredAt: timestamp(1),
      expiresAt: timestamp(20),
    };
    const response = await fixture.sessions
      .get(`mc-aws-agent-session-v2:${sessionId}`)
      .fetch("https://agent-session.internal/session/cas", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          expectedRevision: 1,
          value: serializeAgentSessionState(next),
        }),
      });
    expect(response.status).toBe(409);
  });
});
