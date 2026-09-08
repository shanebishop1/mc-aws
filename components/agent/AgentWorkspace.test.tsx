// @vitest-environment jsdom

import {
  ApprovalCard,
  EventTimeline,
  PolicyEditor,
  ProviderSelector,
  createAgentDetailRefreshScheduler,
  shouldRefreshAgentSessionDetail,
} from "@/components/agent/AgentWorkspace";
import type { AgentEvent, BackupMode, CapabilityRule, PermissionPresetName } from "@/lib/agent/contracts";
import type { PublicAgentApprovalDto } from "@/lib/agent/control-plane/contracts";
import { PERMISSION_PRESETS } from "@/lib/agent/presets";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

function PolicyHarness() {
  const [policy, setPolicy] = useState<{
    preset: PermissionPresetName;
    rules: CapabilityRule[];
    backupMode: BackupMode;
  }>({
    preset: "maintainer",
    rules: PERMISSION_PRESETS.maintainer.rules.map((rule) => ({ ...rule })),
    backupMode: PERMISSION_PRESETS.maintainer.backupMode,
  });
  return <PolicyEditor {...policy} onChange={setPolicy} />;
}

function agentEvent(sequence: number, kind: AgentEvent["kind"], data: AgentEvent["payload"]["data"]): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    timestamp: `2026-09-02T12:00:0${sequence}.000Z`,
    kind,
    payload: { schemaVersion: 1, redacted: true, data },
    replayCursor: `session-1:${sequence}`,
  };
}

describe("agent workspace controls", () => {
  it("coalesces approval and status stream bursts into one active-detail refresh", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const scheduler = createAgentDetailRefreshScheduler(refresh);
    const streamed = [
      agentEvent(1, "tool-proposal", { status: "waiting-approval" }),
      agentEvent(2, "approval", { decision: "pending" }),
      agentEvent(3, "policy", { outcome: "require-approval" }),
    ];

    for (const event of streamed) {
      expect(shouldRefreshAgentSessionDetail(event)).toBe(true);
      scheduler.schedule();
    }
    vi.advanceTimersByTime(74);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();

    scheduler.schedule();
    scheduler.stop();
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("exposes every custom capability and persists explicit rule and backup selections", () => {
    render(<PolicyHarness />);

    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const writeRule = screen.getByRole("combobox", { name: "workspace / write permission" });
    fireEvent.change(writeRule, { target: { value: "deny" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Backup default" }), {
      target: { value: "never" },
    });

    expect(screen.getAllByRole("combobox")).toHaveLength(9);
    expect((writeRule as HTMLSelectElement).value).toBe("deny");
    expect((screen.getByRole("combobox", { name: "Backup default" }) as HTMLSelectElement).value).toBe("never");
  });

  it("renders ordered event evidence as text without interpreting markup", () => {
    render(
      <EventTimeline
        events={[
          agentEvent(1, "model", { message: "Task accepted" }),
          agentEvent(2, "tool-proposal", { summary: "<img src=x onerror=alert(1)>" }),
        ]}
      />
    );

    expect(screen.getByText("Task accepted")).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders exact sanitized approval evidence and labels broad grants without claiming exact scope", () => {
    const approval: PublicAgentApprovalDto = {
      schemaVersion: 1,
      approvalId: "approval-1",
      invocationId: "invocation-1",
      invocationDigest: "a".repeat(64),
      invocationSummaryDigest: "b".repeat(64),
      toolId: "network.download",
      sanitizedArguments: {
        sourceResource: "https://downloads.example/releases/reviewed.jar",
        destination: "mods/reviewed.jar",
        maxBytes: 8_388_608,
        expectedBytes: 123_456,
        expectedSha256: "a".repeat(64),
      },
      diffSummary: "File target: mods/reviewed.jar",
      backupFailureStatus: "unavailable",
      decision: "pending",
      scope: {
        schemaVersion: 1,
        kind: "session-capability",
        capability: "network.outbound",
        targetScope: {
          schemaVersion: 1,
          kind: "network",
          normalizedTarget: "https://downloads.example/releases/reviewed.jar|workspace:mods/reviewed.jar",
        },
        risk: "destructive",
      },
      expiresAt: "2026-09-02T13:00:00.000Z",
      grantLifetime: "until-session-end-or-expiry",
    };
    render(<ApprovalCard approval={approval} busy={false} onDecision={() => undefined} onRevoke={() => undefined} />);
    expect(screen.getByText("Session capability grant")).toBeTruthy();
    expect(screen.getByText("invocation-1")).toBeTruthy();
    expect(screen.getByText("Exact HTTPS resource")).toBeTruthy();
    expect(screen.getAllByText("https://downloads.example/releases/reviewed.jar", { exact: false })).toHaveLength(3);
    expect(screen.getByText("8,388,608 bytes")).toBeTruthy();
    expect(screen.getByText("123,456 bytes (exact)")).toBeTruthy();
    expect(screen.getByText("Expected SHA-256")).toBeTruthy();
    expect(screen.getByText(/Final URL must remain exactly this resource/)).toBeTruthy();
    expect(screen.getByText(/Required backup unavailable/)).toBeTruthy();
    expect(screen.getByText(/destructive — access, permissions, or server state may be affected/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Grant matching actions for session" })).toBeTruthy();
    expect(screen.queryByText(/Approve exact scope/i)).toBeNull();
  });

  it("offers accessible configured provider and model selectors", () => {
    let selection = { profileId: "profile-a", model: "model-a" };
    const { rerender } = render(
      <ProviderSelector
        catalog={{
          schemaVersion: 1,
          profiles: [
            {
              schemaVersion: 1,
              profileId: "profile-a",
              providerId: "provider-api-a",
              providerKind: "openai-compatible",
              displayName: "Reviewed provider",
              endpointOrigin: "https://models.example",
              endpointDisplay: "models.example",
              allowedModels: ["model-a", "model-b"],
              supportedFeatures: ["streaming", "tools"],
            },
          ],
        }}
        {...selection}
        onChange={(next) => {
          selection = next;
        }}
      />
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "model-b" } });
    rerender(
      <ProviderSelector
        catalog={{
          schemaVersion: 1,
          profiles: [
            {
              schemaVersion: 1,
              profileId: "profile-a",
              providerId: "provider-api-a",
              providerKind: "openai-compatible",
              displayName: "Reviewed provider",
              endpointOrigin: "https://models.example",
              endpointDisplay: "models.example",
              allowedModels: ["model-a", "model-b"],
              supportedFeatures: ["streaming", "tools"],
            },
          ],
        }}
        {...selection}
        onChange={() => undefined}
      />
    );
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe("model-b");
  });
});
