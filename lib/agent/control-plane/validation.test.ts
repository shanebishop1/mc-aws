import {
  AgentApiValidationError,
  parseApprovalDecision,
  parseContinueSessionRequest,
  parseCreateSessionRequest,
  parseRevisionMutation,
} from "@/lib/agent/control-plane/validation";
import { createPolicyFromPreset } from "@/lib/agent/presets";
import { describe, expect, it } from "vitest";

function createBody() {
  const policy = createPolicyFromPreset("maintainer", "ignored");
  return {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: "create-1",
    task: "Inspect configuration",
    providerProfileId: "local-fake",
    model: "deterministic-v1",
    policy: {
      schemaVersion: 1,
      preset: policy.preset,
      rules: policy.rules,
      backupMode: policy.backupMode,
    },
  };
}

describe("agent API validation", () => {
  it("accepts exact expanded policies and rejects unknown or inconsistent fields", () => {
    expect(parseCreateSessionRequest(createBody())).toEqual(createBody());
    expect(() => parseCreateSessionRequest({ ...createBody(), credential: "raw" })).toThrow(AgentApiValidationError);
    const inconsistent = createBody();
    inconsistent.policy.rules[0] = { ...inconsistent.policy.rules[0], decision: "deny" };
    expect(() => parseCreateSessionRequest(inconsistent)).toThrow(AgentApiValidationError);
  });

  it("allows only approve or deny decisions and positive revisions", () => {
    const base = { schemaVersion: 1, expectedRevision: 8, idempotencyKey: "decision-1" };
    expect(parseApprovalDecision({ ...base, decision: "approve" }).decision).toBe("approve");
    expect(parseApprovalDecision({ ...base, decision: "deny" }).decision).toBe("deny");
    expect(() => parseApprovalDecision({ ...base, decision: "approved" })).toThrow(AgentApiValidationError);
    expect(() => parseApprovalDecision({ ...base, decision: "cancelled" })).toThrow(AgentApiValidationError);
    expect(() => parseRevisionMutation({ ...base, expectedRevision: 0 })).toThrow(AgentApiValidationError);
  });

  it("strictly validates bounded revision-bound continuation turns", () => {
    const continuation = {
      schemaVersion: 1,
      expectedRevision: 8,
      idempotencyKey: "continue-1",
      task: "Continue the existing task",
      providerProfileId: "local-fake",
      model: "deterministic-v1",
    };
    expect(parseContinueSessionRequest(continuation)).toEqual(continuation);
    expect(() => parseContinueSessionRequest({ ...continuation, expectedRevision: 0 })).toThrow(
      AgentApiValidationError
    );
    expect(() => parseContinueSessionRequest({ ...continuation, credentialRef: "secret-ref:not-public" })).toThrow(
      AgentApiValidationError
    );
    expect(() => parseContinueSessionRequest({ ...continuation, task: "x".repeat(8_001) })).toThrow(
      AgentApiValidationError
    );
  });
});
