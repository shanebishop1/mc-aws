import {
  AGENT_CAPABILITIES,
  type AgentApproval,
  type ImmutableBoundaryFacts,
  type PermissionDecision,
  type PermissionEvaluationInput,
  type RiskFacts,
} from "@/lib/agent/contracts";
import { canonicalAgentFixtures } from "@/lib/agent/fixtures";
import {
  LOW_RISK_FACTS,
  NO_IMMUTABLE_BOUNDARY_VIOLATIONS,
  classifyRisk,
  consumeSingleInvocationApproval,
  createInvocationDigest,
  createInvocationSummaryDigest,
  createProposedInvocationSummary,
  evaluateBackup,
  evaluatePermission,
  permissionDecisionForRisk,
  raiseRisk,
} from "@/lib/agent/policy";
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_NAMES,
  createCustomPolicy,
  createCustomPreset,
  createPolicyFromPreset,
} from "@/lib/agent/presets";
import { describe, expect, it } from "vitest";

const NOW = "2026-09-02T12:00:00.000Z";
const DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const expectedPresetRules: Record<string, PermissionDecision[]> = {
  copilot: ["allow", "ask-always", "deny", "ask-always", "ask-always", "deny", "allow", "deny", "ask-always"],
  maintainer: [
    "allow",
    "ask-once",
    "ask-always",
    "ask-once",
    "ask-once",
    "ask-always",
    "allow",
    "ask-always",
    "ask-always",
  ],
  autopilot: ["allow", "allow", "ask-once", "allow", "allow", "ask-once", "allow", "ask-once", "ask-always"],
};

function evaluationInput(overrides: Partial<PermissionEvaluationInput> = {}): PermissionEvaluationInput {
  return {
    policy: createPolicyFromPreset("maintainer", "policy-1"),
    actorId: "admin-1",
    sessionId: "session-1",
    invocationDigest: DIGEST,
    capability: "workspace.write",
    targetScope: canonicalAgentFixtures.targetScope,
    risk: "risky",
    immutableBoundary: { ...NO_IMMUTABLE_BOUNDARY_VIOLATIONS },
    approvals: [],
    now: NOW,
    ...overrides,
  };
}

function approval(overrides: Partial<AgentApproval> = {}): AgentApproval {
  const result = {
    ...canonicalAgentFixtures.agentApproval,
    scope: {
      ...canonicalAgentFixtures.agentApproval.scope,
      targetScope: { ...canonicalAgentFixtures.agentApproval.scope.targetScope },
    },
    ...overrides,
  };
  if (overrides.invocationDigest && !overrides.invocationSummary) {
    result.invocationSummary = { ...result.invocationSummary, invocationDigest: overrides.invocationDigest };
  }
  return result;
}

describe("permission presets", () => {
  it("defines exactly the PRD capabilities and four preset names", () => {
    expect(AGENT_CAPABILITIES).toEqual([
      "workspace.read",
      "workspace.write",
      "workspace.delete",
      "shell.execute",
      "console.execute",
      "network.outbound",
      "backup.create",
      "extension.load",
      "maintenance.apply",
    ]);
    expect(PERMISSION_PRESET_NAMES).toEqual(["copilot", "maintainer", "autopilot", "custom"]);
  });

  it.each(Object.entries(expectedPresetRules))("expands every %s capability decision", (name, decisions) => {
    const preset = PERMISSION_PRESETS[name as keyof typeof PERMISSION_PRESETS];
    expect(preset.rules.map((rule) => rule.capability)).toEqual(AGENT_CAPABILITIES);
    expect(preset.rules.map((rule) => rule.decision)).toEqual(decisions);
    for (const [index, capability] of AGENT_CAPABILITIES.entries()) {
      const expectedOutcome =
        decisions[index] === "allow" ? "allow" : decisions[index] === "deny" ? "deny" : "require-approval";
      expect(
        evaluatePermission(
          evaluationInput({
            policy: createPolicyFromPreset(name as keyof typeof PERMISSION_PRESETS, `${name}-policy`),
            capability,
          })
        ).outcome
      ).toBe(expectedOutcome);
    }
  });

  it("uses Maintainer by default and the required backup defaults", () => {
    expect(PERMISSION_PRESETS.copilot.backupMode).toBe("before-any-mutation");
    expect(PERMISSION_PRESETS.maintainer).toMatchObject({ isDefault: true, backupMode: "before-risky" });
    expect(PERMISSION_PRESETS.autopilot.backupMode).toBe("before-destructive");
  });

  it("keeps MOTD maintenance on exact destructive approval and backup gates", () => {
    for (const name of ["copilot", "maintainer", "autopilot"] as const) {
      const policy = createPolicyFromPreset(name, `${name}-maintenance-policy`);
      expect(permissionDecisionForRisk(policy, "maintenance.apply", "destructive")).toBe("ask-always");
      expect(evaluateBackup(policy.backupMode, "destructive", true)).toMatchObject({
        required: true,
        outcome: "create-backup",
      });
    }
  });

  it.each(["allow", "ask-once"] as const)(
    "requires an exact decision for destructive work when the base rule is %s",
    (baseDecision) => {
      const policy = createPolicyFromPreset("autopilot", "autopilot-policy");
      policy.rules.find((rule) => rule.capability === "workspace.write")!.decision = baseDecision;
      expect(permissionDecisionForRisk(policy, "workspace.write", "risky")).toBe(baseDecision);
      expect(permissionDecisionForRisk(policy, "workspace.write", "destructive")).toBe("ask-always");
      expect(evaluatePermission(evaluationInput({ policy, risk: "destructive" }))).toMatchObject({
        outcome: "require-approval",
        approvalKind: "ask-always",
        risk: "destructive",
      });
    }
  );

  it("creates Custom as an independent copy of the selected preset with explicit overrides", () => {
    const source = createPolicyFromPreset("copilot", "source-policy", 3);
    const custom = createCustomPolicy(source, "custom-policy", 4, {
      "workspace.write": "allow",
      "network.outbound": "ask-once",
    });
    expect(custom).toMatchObject({ preset: "custom", revision: 4, backupMode: "before-any-mutation" });
    expect(custom.rules.find((rule) => rule.capability === "workspace.write")?.decision).toBe("allow");
    expect(custom.rules.find((rule) => rule.capability === "network.outbound")?.decision).toBe("ask-once");
    expect(source.rules.find((rule) => rule.capability === "workspace.write")?.decision).toBe("ask-always");
    expect(createCustomPreset(PERMISSION_PRESETS.autopilot)).toMatchObject({
      name: "custom",
      rules: PERMISSION_PRESETS.autopilot.rules,
    });
  });
});

describe("deterministic policy evaluation", () => {
  it.each([
    ["allow", "allow"],
    ["deny", "deny"],
    ["ask-once", "require-approval"],
    ["ask-always", "require-approval"],
  ] as const)("maps a %s rule to %s without an approval", (decision, outcome) => {
    const policy = createCustomPolicy(createPolicyFromPreset("maintainer", "base"), "custom", 2, {
      "workspace.write": decision,
    });
    expect(evaluatePermission(evaluationInput({ policy })).outcome).toBe(outcome);
  });

  it.each(Object.keys(NO_IMMUTABLE_BOUNDARY_VIOLATIONS) as Array<keyof ImmutableBoundaryFacts>)(
    "denies immutable boundary %s even when the custom rule allows it",
    (boundary) => {
      const immutableBoundary = { ...NO_IMMUTABLE_BOUNDARY_VIOLATIONS, [boundary]: true };
      const policy = createCustomPolicy(createPolicyFromPreset("autopilot", "base"), "custom", 2, {
        "workspace.write": "allow",
      });
      expect(evaluatePermission(evaluationInput({ policy, immutableBoundary }))).toMatchObject({
        outcome: "deny",
        immutableBoundary: expect.any(String),
      });
    }
  );

  it("reuses an active ask-once grant only for the same session, normalized scope, capability, and risk", () => {
    const activeGrant = approval();
    expect(evaluatePermission(evaluationInput({ approvals: [activeGrant] }))).toMatchObject({
      outcome: "allow",
      approvalId: "approval-1",
    });
    expect(evaluatePermission(evaluationInput({ sessionId: "session-2", approvals: [activeGrant] })).outcome).toBe(
      "require-approval"
    );
    expect(evaluatePermission(evaluationInput({ actorId: "admin-2", approvals: [activeGrant] })).outcome).toBe(
      "require-approval"
    );
    expect(evaluatePermission(evaluationInput({ risk: "destructive", approvals: [activeGrant] })).outcome).toBe(
      "require-approval"
    );
    expect(
      evaluatePermission(
        evaluationInput({
          policy: createPolicyFromPreset("maintainer", "policy-2", 2),
          approvals: [activeGrant],
        })
      ).outcome
    ).toBe("require-approval");
    expect(
      evaluatePermission(
        evaluationInput({
          targetScope: { ...canonicalAgentFixtures.targetScope, normalizedTarget: "config/other.properties" },
          approvals: [activeGrant],
        })
      ).outcome
    ).toBe("require-approval");
  });

  it("rejects duplicate approval IDs instead of ambiguously selecting one", () => {
    const first = approval();
    const changed = {
      ...first,
      invocationDigest: "b".repeat(64),
      invocationSummary: { ...first.invocationSummary, invocationDigest: "b".repeat(64) },
    };
    expect(() => evaluatePermission(evaluationInput({ approvals: [first, changed] }))).toThrow(
      /duplicate approval ID/i
    );
  });

  it("handles ask-once expiry and revocation deterministically", () => {
    expect(evaluatePermission(evaluationInput({ approvals: [approval({ expiresAt: NOW })] }))).toMatchObject({
      outcome: "require-approval",
      reason: "Approval expired.",
    });
    expect(
      evaluatePermission(
        evaluationInput({
          approvals: [
            approval({ decision: "revoked", decidedAt: "2026-09-02T12:01:00.000Z", reason: "Operator revoked it." }),
          ],
        })
      )
    ).toMatchObject({ outcome: "require-approval", reason: "The session approval was revoked." });
  });

  it("binds ask-always to one exact digest and rejects replay after consumption", () => {
    const policy = createPolicyFromPreset("copilot", "copilot-policy");
    const exactApproval = approval({
      policyId: "copilot-policy",
      scope: { ...canonicalAgentFixtures.approvalScope, kind: "single-invocation" },
    });
    expect(evaluatePermission(evaluationInput({ policy, approvals: [exactApproval] })).outcome).toBe("allow");
    expect(
      evaluatePermission(evaluationInput({ policy, invocationDigest: "b".repeat(64), approvals: [exactApproval] }))
        .outcome
    ).toBe("require-approval");

    const consumed = consumeSingleInvocationApproval(exactApproval, "session-1", DIGEST, "2026-09-02T12:00:01.000Z");
    expect(evaluatePermission(evaluationInput({ policy, approvals: [consumed] }))).toMatchObject({
      outcome: "require-approval",
      reason: expect.stringContaining("replay rejected"),
    });
    expect(() => consumeSingleInvocationApproval(consumed, "session-1", DIGEST, "2026-09-02T12:00:02.000Z")).toThrow(
      /replay rejected/
    );
  });

  it.each(["denied", "cancelled"] as const)("fails closed when an exact approval is %s", (decision) => {
    const policy = createPolicyFromPreset("copilot", "copilot-policy");
    const exactApproval = approval({
      policyId: "copilot-policy",
      scope: { ...canonicalAgentFixtures.approvalScope, kind: "single-invocation" },
      decision,
      reason: `Operator ${decision}.`,
    });
    expect(evaluatePermission(evaluationInput({ policy, approvals: [exactApproval] })).outcome).toBe("deny");
  });

  it("keeps pending exact approvals pending and rejects cross-session consumption", () => {
    const policy = createPolicyFromPreset("copilot", "copilot-policy");
    const pending = approval({
      policyId: "copilot-policy",
      scope: { ...canonicalAgentFixtures.approvalScope, kind: "single-invocation" },
      decision: "pending",
      reason: "",
      decidedAt: undefined,
    });
    expect(evaluatePermission(evaluationInput({ policy, approvals: [pending] }))).toMatchObject({
      outcome: "require-approval",
      approvalId: "approval-1",
    });
    expect(() =>
      consumeSingleInvocationApproval(
        approval({ scope: { ...canonicalAgentFixtures.approvalScope, kind: "single-invocation" } }),
        "session-2",
        DIGEST,
        NOW
      )
    ).toThrow(/another session/);
  });

  it("produces a stable SHA-256 digest independent of object key insertion order", async () => {
    const invocation = canonicalAgentFixtures.toolInvocation;
    const reordered = {
      ...invocation,
      arguments: { patch: "motd=Welcome", path: "config/server.properties" },
    };
    const [first, second] = await Promise.all([createInvocationDigest(invocation), createInvocationDigest(reordered)]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("creates tool-aware secret-free summaries bound to the exact invocation and summary digest", async () => {
    const invocation = {
      ...canonicalAgentFixtures.toolInvocation,
      toolId: "network.download",
      capability: "network.outbound" as const,
      arguments: {
        url: "https://DOWNLOADS.example/releases/must-not-persist/file.jar",
        destination: "plugins/file.jar",
        expectedSha256: "a".repeat(64),
        expectedBytes: 1,
        note: "Bearer must-not-persist-abcdefghijklmnop",
      },
    };
    const summary = await createProposedInvocationSummary(invocation, "risky", {
      exactSecrets: ["must-not-persist"],
      backupFailureStatus: "failed",
    });
    expect(summary).toMatchObject({
      invocationId: invocation.invocationId,
      capability: "network.outbound",
      sanitizedArguments: {
        sourceResource: "https://downloads.example/releases/[REDACTED]/file.jar",
        destination: "plugins/file.jar",
        maxBytes: 33_554_432,
        expectedSha256: "a".repeat(64),
        expectedBytes: 1,
      },
      backupFailureStatus: "failed",
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-persist");
    expect(summary.invocationDigest).toBe(await createInvocationDigest(invocation));
    const digest = await createInvocationSummaryDigest(summary);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await createInvocationSummaryDigest({ ...summary, sanitizedArguments: { destination: "other.jar" } })
    ).not.toBe(digest);
  });

  it.each([
    "https://downloads.example/file.jar?release=1",
    "https://downloads.example/file.jar#release",
    "https://downloads.example/a/../file.jar",
    "https://downloads.example/%2e%2e/file.jar",
  ])("refuses to create an approval summary for ambiguous resource %s", async (url) => {
    const invocation = {
      ...canonicalAgentFixtures.toolInvocation,
      toolId: "network.download",
      capability: "network.outbound" as const,
      arguments: {
        url,
        destination: "plugins/file.jar",
        expectedSha256: "a".repeat(64),
        expectedBytes: 1,
      },
    };
    await expect(createProposedInvocationSummary(invocation, "risky")).rejects.toThrow(/query|string|canonical/i);
  });
});

describe("risk and backup policy", () => {
  function facts(overrides: Partial<RiskFacts>): RiskFacts {
    return { ...LOW_RISK_FACTS, ...overrides };
  }

  it.each([
    ["workspace.read", facts({}), "low"],
    ["workspace.write", facts({ mutation: true }), "risky"],
    ["console.execute", facts({ consoleMutation: true }), "risky"],
    ["workspace.delete", facts({ mutation: true }), "destructive"],
    ["workspace.write", facts({ worldChange: true }), "destructive"],
    ["workspace.write", facts({ permissionChange: true }), "destructive"],
    ["shell.execute", facts({ broadMutation: true }), "destructive"],
    ["extension.load", facts({}), "risky"],
  ] as const)("classifies %s as %s", (capability, riskFacts, expected) => {
    expect(classifyRisk(capability, riskFacts)).toBe(expected);
  });

  it("allows hooks to raise but never lower risk", () => {
    expect(raiseRisk("low", "risky")).toBe("risky");
    expect(raiseRisk("destructive", "low")).toBe("destructive");
  });

  it.each([
    ["never", "destructive", true, false],
    ["before-destructive", "risky", true, false],
    ["before-destructive", "destructive", true, true],
    ["before-risky", "low", true, false],
    ["before-risky", "risky", true, true],
    ["before-risky", "destructive", true, true],
    ["before-any-mutation", "low", false, false],
    ["before-any-mutation", "low", true, true],
  ] as const)("evaluates %s / %s / mutation=%s", (mode, risk, mutation, required) => {
    expect(evaluateBackup(mode, risk, mutation).required).toBe(required);
  });

  it.each(["failed", "unavailable"] as const)(
    "pauses for explicit proceed-or-cancel when a required backup is %s",
    (status) => {
      expect(evaluateBackup("before-risky", "risky", true, status)).toMatchObject({ required: true, outcome: "pause" });
    }
  );

  it("proceeds only after a required backup succeeds", () => {
    expect(evaluateBackup("before-risky", "risky", true, "not-requested").outcome).toBe("create-backup");
    expect(evaluateBackup("before-risky", "risky", true, "succeeded").outcome).toBe("proceed");
  });
});
