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
    const maintenanceRule = screen.getByRole("combobox", { name: "maintenance / apply permission" });
    fireEvent.change(writeRule, { target: { value: "deny" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Backup default" }), {
      target: { value: "never" },
    });

    expect(screen.getAllByRole("combobox")).toHaveLength(10);
    expect((writeRule as HTMLSelectElement).value).toBe("deny");
    expect((maintenanceRule as HTMLSelectElement).value).toBe("ask-always");
    expect(screen.getAllByText(/maintenance \/ apply — ask always/)).toHaveLength(3);
    expect(screen.getByText("Executable plugin installation unavailable through agent tools")).toBeTruthy();
    expect(screen.getByText(/complete profile rollout is a separate operator-reviewed path/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /plugin/i })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Backup default" }) as HTMLSelectElement).value).toBe("never");
  });

  it("shows shell details for a capability alias and its effective scopes", () => {
    const command = "printf '%s\\n' 'reviewed command'";
    const approval: PublicAgentApprovalDto = {
      schemaVersion: 1,
      approvalId: "shell-approval",
      invocationId: "shell-invocation",
      invocationDigest: "a".repeat(64),
      invocationSummaryDigest: "b".repeat(64),
      toolId: "reviewed-shell-alias",
      sanitizedArguments: {
        mode: "staged-write",
        command,
        timeoutMs: 15_000,
        change: { operation: "delete", path: "notes/reviewed.txt" },
      },
      decision: "pending",
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: "shell.execute",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "notes/reviewed.txt" },
        risk: "risky",
      },
      expiresAt: "2026-09-02T13:00:00.000Z",
      grantLifetime: "single-invocation",
    };

    render(<ApprovalCard approval={approval} busy={false} onDecision={() => undefined} onRevoke={() => undefined} />);

    expect(screen.getByTestId("reviewed-shell-command").textContent).toBe(command);
    expect(screen.getByText(/Mounted workspace root \(\.\)/)).toBeTruthy();
    expect(screen.getByText("delete notes/reviewed.txt")).toBeTruthy();
    expect(screen.getByText(/No automatic rollback/)).toBeTruthy();
  });

  it("shows the narrow MOTD maintenance contract and its recovery limits", () => {
    const approval: PublicAgentApprovalDto = {
      schemaVersion: 1,
      approvalId: "maintenance-approval",
      invocationId: "maintenance-invocation",
      invocationDigest: "c".repeat(64),
      invocationSummaryDigest: "d".repeat(64),
      toolId: "maintenance.apply",
      sanitizedArguments: {
        path: "server.properties",
        key: "motd",
        value: "Reviewed MOTD",
        expectedSha256: "e".repeat(64),
        expectedBytes: 100,
        resultSha256: "f".repeat(64),
        resultBytes: 104,
        serviceIntent: "restore-prior",
        expectedProtocol: { schemaVersion: 1, host: "127.0.0.1", port: 25565, motd: "Reviewed MOTD" },
      },
      decision: "pending",
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: "maintenance.apply",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "server.properties" },
        risk: "risky",
      },
      expiresAt: "2026-09-02T13:00:00.000Z",
      grantLifetime: "single-invocation",
    };

    render(<ApprovalCard approval={approval} busy={false} onDecision={() => undefined} onRevoke={() => undefined} />);

    expect(screen.getByText("server.properties -> motd only")).toBeTruthy();
    expect(screen.getByText(/SHA-256 e{64}; 100 bytes/)).toBeTruthy();
    expect(screen.getByText(/SHA-256 f{64}; 104 bytes/)).toBeTruthy();
    expect(screen.getByText(/Required before the service stop and MOTD edit/)).toBeTruthy();
    expect(screen.getByText(/Independent Minecraft protocol observation/)).toBeTruthy();
    expect(screen.getByText(/restore-prior restores service intent, not the prior file value/)).toBeTruthy();
  });

  it("distinguishes successful MOTD observation from unknown maintenance evidence", () => {
    render(
      <EventTimeline
        events={[
          agentEvent(1, "tool-result", {
            invocationId: "maintenance-success",
            status: "succeeded",
            completedAt: "2026-09-02T12:00:01.000Z",
            summary: "Approved MOTD committed and independently observed.",
            output: {
              committed: true,
              configSha256: "a".repeat(64),
              configBytes: 104,
              verification: "observed",
              protocol: {
                protocol: "minecraft-status",
                host: "127.0.0.1",
                port: 25565,
                motd: "Reviewed MOTD",
                independentlyObserved: true,
              },
            },
            evidence: [],
            mutationCommit: { committed: true, point: "maintenance-edit" },
          }),
          agentEvent(2, "tool-result", {
            invocationId: "maintenance-unknown",
            status: "indeterminate",
            completedAt: "2026-09-02T12:00:02.000Z",
            summary: "Protocol verification is unresolved.",
            output: { code: "indeterminate-effect", commitPoint: "maintenance-edit", reconciliation: "required" },
            evidence: [],
            mutationCommit: { committed: true, point: "maintenance-edit" },
          }),
          agentEvent(3, "tool-result", {
            invocationId: "unrelated-protocol",
            status: "succeeded",
            completedAt: "2026-09-02T12:00:03.000Z",
            summary: "Unrelated status query completed.",
            output: {
              verification: "observed",
              protocol: {
                protocol: "minecraft-status",
                host: "127.0.0.1",
                port: 25565,
                motd: "Other MOTD",
                independentlyObserved: true,
              },
            },
            evidence: [],
          }),
        ]}
      />
    );

    expect(screen.getByText(/MOTD observation status: success - independently observed/)).toBeTruthy();
    expect(screen.getByText(/MOTD observation status: unknown - reconciliation required/)).toBeTruthy();
    expect(screen.getAllByTestId("motd-observation-status")).toHaveLength(2);
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
