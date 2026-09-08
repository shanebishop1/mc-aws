import { canonicalAgentFixtures } from "@/lib/agent/fixtures";
import { orderHookDefinitions } from "@/lib/agent/hooks";
import { agentSchemas, validateOrderedEvents } from "@/lib/agent/validators";
import { describe, expect, it } from "vitest";

type FixtureName = keyof typeof canonicalAgentFixtures;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("agent contract schemas", () => {
  const fixtureEntries = Object.entries(canonicalAgentFixtures) as Array<
    [FixtureName, (typeof canonicalAgentFixtures)[FixtureName]]
  >;

  it.each(fixtureEntries)("round-trips and validates the canonical %s fixture", (name, fixture) => {
    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toContain("undefined");
    expect(agentSchemas[name].parse(JSON.parse(serialized))).toEqual(fixture);
  });

  it.each(fixtureEntries)("rejects schema version drift for %s", (name, fixture) => {
    expect(() => agentSchemas[name].parse({ ...clone(fixture), schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it("rejects unknown security-relevant fields at defined object boundaries", () => {
    expect(() =>
      agentSchemas.toolInvocation.parse({
        ...clone(canonicalAgentFixtures.toolInvocation),
        runAsRoot: true,
      })
    ).toThrow(/unknown field/);
    expect(() =>
      agentSchemas.agentApproval.parse({
        ...clone(canonicalAgentFixtures.agentApproval),
        bypassPolicy: true,
      })
    ).toThrow(/unknown field/);

    const session = clone(canonicalAgentFixtures.agentSession);
    expect(() =>
      agentSchemas.agentSession.parse({
        ...session,
        harness: { ...session.harness, privileged: true },
      })
    ).toThrow(/unknown field/);
  });

  it("validates exact mutation truth for every terminal result status", () => {
    expect(() =>
      agentSchemas.toolResult.parse({
        ...clone(canonicalAgentFixtures.toolResult),
        mutationCommit: { committed: true, point: "atomic-rename" },
      })
    ).not.toThrow();
    expect(() =>
      agentSchemas.toolResult.parse({
        ...clone(canonicalAgentFixtures.toolResult),
        status: "indeterminate",
        mutationCommit: { committed: true, point: "console-dispatch" },
      })
    ).not.toThrow();
    expect(() =>
      agentSchemas.toolResult.parse({
        ...clone(canonicalAgentFixtures.toolResult),
        status: "cancelled",
        mutationCommit: { committed: false },
      })
    ).not.toThrow();
    expect(
      agentSchemas.toolResult.parse({ ...clone(canonicalAgentFixtures.toolResult), status: "indeterminate" }).status
    ).toBe("indeterminate");
  });

  it("accepts only opaque credential references and rejects raw credential fields", () => {
    expect(canonicalAgentFixtures.providerConfiguration.credentialRef).toMatch(/^secret-ref:/);
    expect(() =>
      agentSchemas.providerConfiguration.parse({
        ...clone(canonicalAgentFixtures.providerConfiguration),
        credentialRef: "sk-live-raw-secret",
      })
    ).toThrow(/credentialRef/);
    expect(() =>
      agentSchemas.providerConfiguration.parse({
        ...clone(canonicalAgentFixtures.providerConfiguration),
        apiKey: "sk-live-raw-secret",
      })
    ).toThrow(/unknown field/);
    expect(() =>
      agentSchemas.agentEvent.parse({
        ...clone(canonicalAgentFixtures.agentEvent),
        payload: {
          schemaVersion: 1,
          redacted: true,
          data: { apiKey: "sk-live-raw-secret" },
        },
      })
    ).toThrow(/raw credential fields/);
  });

  it.each([
    "sessionToken",
    "session_token",
    "AWS_SESSION_TOKEN",
    "clientSecret",
    "oauth-client-secret",
    "private.key",
    "private_key_pem",
  ])("rejects normalized sensitive contract key %s", (key) => {
    expect(() =>
      agentSchemas.agentEvent.parse({
        ...clone(canonicalAgentFixtures.agentEvent),
        payload: {
          schemaVersion: 1,
          redacted: true,
          data: { nested: { [key]: "raw-secret" } },
        },
      })
    ).toThrow(/raw credential fields/);
  });

  it("rejects malformed approval digests and inconsistent approval state", () => {
    expect(() =>
      agentSchemas.agentApproval.parse({
        ...clone(canonicalAgentFixtures.agentApproval),
        invocationDigest: "not-a-sha256",
      })
    ).toThrow(/invocationDigest/);
    expect(() =>
      agentSchemas.agentApproval.parse({
        ...clone(canonicalAgentFixtures.agentApproval),
        decision: "pending",
      })
    ).toThrow(/pending approvals/);
    expect(() =>
      agentSchemas.agentApproval.parse({
        ...clone(canonicalAgentFixtures.agentApproval),
        policyRevision: 0,
      })
    ).toThrow(/policyRevision/);
  });

  it("rejects obvious relative target-scope traversal", () => {
    expect(() =>
      agentSchemas.targetScope.parse({
        ...clone(canonicalAgentFixtures.targetScope),
        normalizedTarget: "config/../server.properties",
      })
    ).toThrow(/traversal/);
  });

  it("rejects malformed event envelopes and invalid ordered streams", () => {
    expect(() =>
      agentSchemas.agentEvent.parse({
        ...clone(canonicalAgentFixtures.agentEvent),
        replayCursor: "session-1:9",
      })
    ).toThrow(/replayCursor/);
    expect(() =>
      agentSchemas.agentEvent.parse({
        ...clone(canonicalAgentFixtures.agentEvent),
        sequence: 0,
      })
    ).toThrow(/sequence/);
    expect(() =>
      agentSchemas.agentEvent.parse({
        ...clone(canonicalAgentFixtures.agentEvent),
        payload: { ...clone(canonicalAgentFixtures.redactedEventPayload), redacted: false },
      })
    ).toThrow(/redacted/);

    const secondEvent = {
      ...clone(canonicalAgentFixtures.agentEvent),
      eventId: "event-2",
      sequence: 3,
      replayCursor: "session-1:3",
    };
    expect(() => validateOrderedEvents([canonicalAgentFixtures.agentEvent, secondEvent])).toThrow(/contiguous/);
  });

  it("requires one and only one rule for every capability", () => {
    const policy = clone(canonicalAgentFixtures.permissionPolicy);
    policy.rules.pop();
    expect(() => agentSchemas.permissionPolicy.parse(policy)).toThrow(/exactly one rule/);

    const duplicatePolicy = clone(canonicalAgentFixtures.permissionPolicy);
    duplicatePolicy.rules[0] = { ...duplicatePolicy.rules[1] };
    expect(() => agentSchemas.permissionPolicy.parse(duplicatePolicy)).toThrow(/exactly one rule/);
  });

  it("orders hooks deterministically by priority and stable hook ID", () => {
    const hook = canonicalAgentFixtures.hookDefinition;
    const ordered = orderHookDefinitions([
      { ...hook, hookId: "hook-z", priority: 20 },
      { ...hook, hookId: "hook-b", priority: 10 },
      { ...hook, hookId: "hook-a", priority: 10 },
    ]);
    expect(ordered.map((item) => item.hookId)).toEqual(["hook-a", "hook-b", "hook-z"]);
  });
});
