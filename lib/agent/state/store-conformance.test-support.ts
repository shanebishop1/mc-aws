import type { AgentSession, PermissionPolicy } from "@/lib/agent/contracts";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import { AgentStateConflictError, type AgentStateRepository } from "@/lib/agent/state/contracts";
import { InMemoryAgentSessionStore } from "@/lib/agent/state/store";
import { describe, expect, it } from "vitest";

const timestamp = (second: number) => `2026-09-02T12:00:${String(second).padStart(2, "0")}.000Z`;

function session(sessionId: string, actorId = "actor-1"): { session: AgentSession; policySnapshot: PermissionPolicy } {
  const policySnapshot = createPolicyFromPreset("maintainer", `policy-${sessionId}`);
  return {
    session: {
      schemaVersion: 1,
      sessionId,
      actorId,
      status: "pending",
      createdAt: timestamp(0),
      updatedAt: timestamp(0),
      policyId: policySnapshot.policyId,
      policyRevision: policySnapshot.revision,
      harness: {
        schemaVersion: 1,
        adapterId: "fake",
        adapterVersion: "1.0.0",
        providerProfileId: "fake-provider",
        providerProfileFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        model: "fake-model",
      },
      turns: [],
    },
    policySnapshot,
  };
}

/** Shared authoritative store contract, run against memory and Durable Object transports. */
export function runAgentStoreConformance(name: string, repositoryFactory: () => AgentStateRepository): void {
  describe(`${name} agent store conformance`, () => {
    it("creates, lists, reads, and rejects concurrent CAS writers", async () => {
      const store = new InMemoryAgentSessionStore(repositoryFactory());
      await store.createSession({ ...session("session-1"), idempotencyKey: "create-1" });
      await store.createSession({ ...session("session-2"), idempotencyKey: "create-2" });
      expect((await store.listSessions()).map((state) => state.session.sessionId)).toEqual(["session-1", "session-2"]);

      const write = (eventId: string) =>
        store.appendEvent({
          sessionId: "session-1",
          expectedRevision: 1,
          idempotencyKey: eventId,
          eventId,
          timestamp: timestamp(1),
          kind: "model",
          payload: { message: eventId },
        });
      const writes = await Promise.allSettled([write("event-a"), write("event-b")]);
      expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = writes.find((result) => result.status === "rejected");
      expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(AgentStateConflictError);
    });

    it("replays ordered events without duplicates and reports truncation", async () => {
      const store = new InMemoryAgentSessionStore(repositoryFactory(), { maxEvents: 2 });
      await store.createSession({ ...session("session-1"), idempotencyKey: "create" });
      let revision = 1;
      for (let sequence = 1; sequence <= 3; sequence++) {
        const result = await store.appendEvent({
          sessionId: "session-1",
          expectedRevision: revision,
          idempotencyKey: `append-${sequence}`,
          eventId: `event-${sequence}`,
          timestamp: timestamp(sequence),
          kind: "model",
          payload: { sequence },
        });
        revision = result.state.revision;
      }
      const replay = await store.replayEvents("session-1", "session-1:1");
      expect(replay.truncated).toBe(false);
      expect(replay.events.map((event) => event.sequence)).toEqual([2, 3]);
      const stale = await store.replayEvents("session-1", "session-1:0");
      expect(stale.truncated).toBe(true);
      expect(stale.events.map((event) => event.sequence)).toEqual([2, 3]);
    });

    it("wakes a bounded event wait after a committed revision", async () => {
      const store = new InMemoryAgentSessionStore(repositoryFactory());
      await store.createSession({ ...session("session-1"), idempotencyKey: "create" });
      const waiting = store.waitForEvents("session-1", "session-1:0", 10, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await store.appendEvent({
        sessionId: "session-1",
        expectedRevision: 1,
        idempotencyKey: "append",
        eventId: "event-1",
        timestamp: timestamp(1),
        kind: "model",
        payload: { message: "ready" },
      });
      const result = await waiting;
      expect(result.timedOut).toBe(false);
      expect(result.events.map((event) => event.eventId)).toEqual(["event-1"]);
    });

    it("bounds empty waits and observes abort signals", async () => {
      const store = new InMemoryAgentSessionStore(repositoryFactory());
      await store.createSession({ ...session("session-1"), idempotencyKey: "create" });
      const timedOut = await store.waitForEvents("session-1", "session-1:0", 10, 5);
      expect(timedOut).toMatchObject({ events: [], timedOut: true, terminal: false });

      const controller = new AbortController();
      controller.abort();
      const aborted = await store.waitForEvents("session-1", "session-1:0", 10, 1_000, controller.signal);
      expect(aborted).toMatchObject({ events: [], timedOut: true, terminal: false });
    });
  });
}
