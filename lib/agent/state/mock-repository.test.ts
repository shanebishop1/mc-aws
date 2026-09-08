import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalAgentFixtures } from "@/lib/agent/fixtures";
import { MockAgentStateRepository } from "@/lib/agent/state/mock-repository";
import { RepositoryAgentSessionStore } from "@/lib/agent/state/store";
import { MockStateStore } from "@/lib/aws/mock-state-store";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

function createStores() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-agent-state-"));
  directories.push(directory);
  const persistencePath = path.join(directory, "state.json");
  const options = { enablePersistence: true, persistencePath };
  const firstStateStore = new MockStateStore(options);
  const secondStateStore = new MockStateStore(options);
  return {
    firstStateStore,
    first: new RepositoryAgentSessionStore(new MockAgentStateRepository(firstStateStore)),
    second: new RepositoryAgentSessionStore(new MockAgentStateRepository(secondStateStore)),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("MockAgentStateRepository", () => {
  it("shares CAS-protected sessions between independent provider/store instances", async () => {
    const { first, second } = createStores();
    const session = structuredClone(canonicalAgentFixtures.agentSession);
    const policySnapshot = structuredClone(canonicalAgentFixtures.permissionPolicy);

    await first.createSession({ session, policySnapshot });
    const observed = await second.getSession(session.sessionId);
    expect(observed?.revision).toBe(1);

    await second.transitionSession({
      sessionId: session.sessionId,
      expectedRevision: 1,
      idempotencyKey: "cross-instance-transition",
      status: "completed",
      at: new Date(Date.parse(session.updatedAt) + 1_000).toISOString(),
      reason: "claimed by another route bundle",
    });

    await expect(
      first.transitionSession({
        sessionId: session.sessionId,
        expectedRevision: 1,
        idempotencyKey: "stale-transition",
        status: "cancelled",
        at: new Date(Date.parse(session.updatedAt) + 2_000).toISOString(),
        reason: "stale writer",
      })
    ).rejects.toThrow(/expected revision 1, found 2/);
    expect((await first.getSession(session.sessionId))?.session.status).toBe("completed");
  });

  it("clears persisted agent sessions as part of the shared mock reset", async () => {
    const { firstStateStore, first, second } = createStores();
    const session = structuredClone(canonicalAgentFixtures.agentSession);
    await first.createSession({
      session,
      policySnapshot: structuredClone(canonicalAgentFixtures.permissionPolicy),
    });

    await firstStateStore.resetState();

    await expect(second.getSession(session.sessionId)).resolves.toBeNull();
  });
});
