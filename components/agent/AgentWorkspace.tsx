"use client";

import { ArtDecoBorder } from "@/components/ArtDecoBorder";
import { PageHeader } from "@/components/PageHeader";
import { ApprovalOperationalDetails, MaintenanceObservationStatus } from "@/components/agent/approval-presentation";
import { useAuth } from "@/components/auth/auth-provider";
import { LuxuryButton } from "@/components/ui/Button";
import {
  type AgentStreamMessage,
  agentQueryKeys,
  cancelAgentSession,
  continueAgentSession,
  createAgentSession,
  decideAgentApproval,
  fetchAgentProviderCatalog,
  fetchAgentSession,
  fetchAgentSessions,
  readAgentEventStream,
  revokeAgentApproval,
} from "@/lib/agent/client";
import {
  AGENT_CAPABILITIES,
  type AgentCapability,
  type AgentEvent,
  type BackupMode,
  type CapabilityRule,
  type PermissionDecision,
  type PermissionPresetName,
} from "@/lib/agent/contracts";
import type {
  PublicAgentApprovalDto,
  PublicAgentSessionDetailDto,
  PublicAgentSessionSummaryDto,
} from "@/lib/agent/control-plane/contracts";
import type { PublicAgentProviderCatalogDto } from "@/lib/agent/control-plane/provider-catalog";
import { PERMISSION_PRESETS } from "@/lib/agent/presets";
import { ClientApiError } from "@/lib/client-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export { maintenanceObservationStatus } from "@/components/agent/approval-presentation";

const TERMINAL = new Set(["cancelled", "failed", "completed"]);
const DETAIL_REFRESH_EVENTS = new Set<AgentEvent["kind"]>([
  "tool-proposal",
  "tool-result",
  "policy",
  "backup",
  "approval",
  "error",
  "cancellation",
  "completion",
]);
const DECISIONS: PermissionDecision[] = ["allow", "ask-once", "ask-always", "deny"];
const BACKUP_MODES: Array<{ value: BackupMode; label: string }> = [
  { value: "never", label: "Never" },
  { value: "before-destructive", label: "Before destructive work" },
  { value: "before-risky", label: "Before risky work" },
  { value: "before-any-mutation", label: "Before any mutation" },
];

export function shouldRefreshAgentSessionDetail(event: AgentEvent): boolean {
  return DETAIL_REFRESH_EVENTS.has(event.kind) || typeof event.payload.data.status === "string";
}

export function createAgentDetailRefreshScheduler(refresh: () => void, delayMs = 75) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  return {
    schedule() {
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!stopped) refresh();
      }, delayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

const PRESET_DESCRIPTIONS = {
  copilot: "Observe freely; ask for each mutation or command.",
  maintainer: "Remember scoped grants while keeping destructive work explicit.",
  autopilot: "Operate routine changes; stop at broad or destructive boundaries.",
} as const;

function operationKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(-10);
}

function copyRules(preset: keyof typeof PERMISSION_PRESETS): CapabilityRule[] {
  return PERMISSION_PRESETS[preset].rules.map((rule) => ({ ...rule }));
}

function readable(value: string): string {
  return value.replaceAll("-", " ").replaceAll(".", " / ");
}

function eventSummary(event: AgentEvent): string {
  const data = event.payload.data;
  for (const key of ["summary", "message", "reason", "target", "capability", "decision"]) {
    const value = data[key];
    if (typeof value === "string") return value;
  }
  return (
    Object.entries(data)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => `${readable(key)}: ${String(value)}`)
      .join(" · ") || "Redacted event recorded."
  );
}

function StatusPip({ status }: { status: PublicAgentSessionSummaryDto["status"] }) {
  const active = status === "running" || status === "waiting-approval";
  return (
    <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
      <span
        className={`h-2 w-2 rounded-full ${active ? "bg-green" : status === "failed" ? "bg-red-700" : "bg-charcoal/35"}`}
        aria-hidden="true"
      />
      {readable(status)}
    </span>
  );
}

function AccessState({ kind }: { kind: "loading" | "denied" }) {
  return (
    <main className="relative flex min-h-dvh flex-col bg-cream px-6 py-4 selection:bg-green selection:text-white">
      <ArtDecoBorder />
      <PageHeader showUtilities={false} />
      <section className="m-auto max-w-lg border-y border-charcoal/20 px-8 py-12 text-center">
        <p className="mb-3 text-[10px] uppercase tracking-[0.28em] text-green">Restricted operations room</p>
        <h2 className="font-serif text-3xl italic text-charcoal">
          {kind === "loading" ? "Verifying clearance" : "Admin clearance required"}
        </h2>
        <p className="mt-4 text-sm leading-6 text-charcoal/60">
          {kind === "loading"
            ? "Checking your authenticated portal role…"
            : "The agent workspace can inspect and change the live server. Sign in with the configured administrator account."}
        </p>
      </section>
    </main>
  );
}

function SessionRail({
  sessions,
  selectedId,
  pending,
  onSelect,
}: {
  sessions: PublicAgentSessionSummaryDto[];
  selectedId: string | null;
  pending: boolean;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <aside className="min-w-0 border-b border-charcoal/15 lg:border-b-0 lg:border-r" aria-label="Session history">
      <div className="flex items-end justify-between px-4 py-3 lg:px-5 lg:py-5">
        <div>
          <p className="text-[9px] uppercase tracking-[0.24em] text-charcoal/45">Archive</p>
          <h2 className="font-serif text-xl italic">Sessions</h2>
        </div>
        <span className="font-serif text-lg text-green">{sessions.length.toString().padStart(2, "0")}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-4 lg:max-h-[calc(100dvh-13rem)] lg:flex-col lg:overflow-y-auto lg:px-3">
        {pending && <p className="px-2 py-5 text-xs text-charcoal/50">Loading history…</p>}
        {!pending && sessions.length === 0 && (
          <p className="min-w-56 border border-dashed border-charcoal/20 px-4 py-5 text-xs leading-5 text-charcoal/50">
            No operations recorded. Compose the first task.
          </p>
        )}
        {sessions.map((session, index) => (
          <button
            key={session.sessionId}
            type="button"
            onClick={() => onSelect(session.sessionId)}
            aria-current={selectedId === session.sessionId ? "true" : undefined}
            className={`min-w-56 border px-4 py-3 text-left transition-colors lg:min-w-0 ${
              selectedId === session.sessionId
                ? "border-green bg-green text-cream"
                : "border-charcoal/15 bg-white/35 hover:border-green/50 hover:bg-white/70"
            }`}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="font-serif text-sm">Run {String(sessions.length - index).padStart(2, "0")}</span>
              <span className="font-mono text-[9px] opacity-60">{shortSessionId(session.sessionId)}</span>
            </span>
            <span className="mt-3 flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.12em] opacity-75">
              <span>{readable(session.status)}</span>
              <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString()}</time>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function PolicyEditor({
  preset,
  rules,
  backupMode,
  disabled,
  onChange,
}: {
  preset: PermissionPresetName;
  rules: CapabilityRule[];
  backupMode: BackupMode;
  disabled?: boolean;
  onChange: (value: { preset: PermissionPresetName; rules: CapabilityRule[]; backupMode: BackupMode }) => void;
}) {
  const selectPreset = (next: PermissionPresetName) => {
    if (next === "custom") return onChange({ preset: next, rules, backupMode });
    const selected = PERMISSION_PRESETS[next];
    onChange({ preset: next, rules: copyRules(next), backupMode: selected.backupMode });
  };
  const setRule = (capability: AgentCapability, decision: PermissionDecision) => {
    onChange({
      preset: "custom",
      backupMode,
      rules: rules.map((rule) => (rule.capability === capability ? { ...rule, decision } : rule)),
    });
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-charcoal/60">
        Permission protocol
      </legend>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {(["copilot", "maintainer", "autopilot"] as const).map((name) => {
          const selected = PERMISSION_PRESETS[name];
          return (
            <label
              key={name}
              className={`cursor-pointer border px-3 py-2 ${preset === name ? "border-green bg-green/[0.06]" : "border-charcoal/15 bg-white/35"}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="permission-preset"
                  value={name}
                  aria-label={selected.displayName}
                  checked={preset === name}
                  onChange={() => selectPreset(name)}
                />
                <span className="font-serif text-sm">{selected.displayName}</span>
              </span>
              <span className="mt-1 block text-[10px] leading-4 text-charcoal/55">{PRESET_DESCRIPTIONS[name]}</span>
              <details className="mt-2 text-[9px] leading-4 text-charcoal/55">
                <summary className="cursor-pointer uppercase tracking-[0.12em]">Rules & backup</summary>
                <ul className="mt-1 border-l border-charcoal/15 pl-2">
                  {selected.rules.map((rule) => (
                    <li key={rule.capability}>
                      {readable(rule.capability)} — {readable(rule.decision)}
                    </li>
                  ))}
                  <li>backup — {readable(selected.backupMode)}</li>
                </ul>
              </details>
            </label>
          );
        })}
        <label
          className={`cursor-pointer border px-3 py-2 ${preset === "custom" ? "border-green bg-green/[0.06]" : "border-charcoal/15 bg-white/35"}`}
        >
          <span className="flex items-center gap-2">
            <input
              type="radio"
              name="permission-preset"
              aria-label="Custom"
              checked={preset === "custom"}
              onChange={() => selectPreset("custom")}
            />
            <span className="font-serif text-sm">Custom</span>
          </span>
          <span className="mt-1 block text-[10px] leading-4 text-charcoal/55">
            Set an explicit decision for every capability.
          </span>
        </label>
      </div>

      {preset === "custom" && (
        <div className="mt-3 border border-charcoal/15 bg-white/40 p-3">
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {AGENT_CAPABILITIES.map((capability) => (
              <label key={capability} className="flex items-center justify-between gap-3 text-xs">
                <span>{readable(capability)}</span>
                <select
                  aria-label={`${readable(capability)} permission`}
                  value={rules.find((rule) => rule.capability === capability)?.decision}
                  onChange={(event) => setRule(capability, event.target.value as PermissionDecision)}
                  className="border border-charcoal/20 bg-cream px-2 py-1 text-xs"
                >
                  {DECISIONS.map((decision) => (
                    <option key={decision} value={decision}>
                      {readable(decision)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <label className="mt-3 flex items-center justify-between gap-3 border-t border-charcoal/10 pt-3 text-xs">
            Backup default
            <select
              value={backupMode}
              onChange={(event) => onChange({ preset: "custom", rules, backupMode: event.target.value as BackupMode })}
              className="border border-charcoal/20 bg-cream px-2 py-1 text-xs"
            >
              {BACKUP_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <aside
        aria-label="Executable plugin availability"
        className="mt-3 border border-amber-900/25 bg-[#f5efe1] p-3 text-xs leading-5 text-charcoal/70"
      >
        <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-amber-900">Capability boundary</p>
        <h3 className="mt-1 font-serif text-base italic text-charcoal">
          Executable plugin installation unavailable through agent tools
        </h3>
        <p className="mt-1">
          The agent can use reviewed data-only extensions, but it cannot install or enable executable plugins. A
          complete profile rollout is a separate operator-reviewed path; this panel intentionally offers no action for
          it.
        </p>
        <p className="mt-2 border-t border-amber-900/15 pt-2 text-[10px] uppercase tracking-[0.08em] text-charcoal/55">
          A reviewed runner and toolchain must be available for execution. If they are unavailable, the runtime fails
          closed; this UI does not claim that the OS or plugin is enabled.
        </p>
      </aside>
    </fieldset>
  );
}

function DownloadApprovalDetails({ approval }: { approval: PublicAgentApprovalDto }) {
  if (approval.toolId !== "network.download") return null;
  const source = approval.sanitizedArguments.sourceResource;
  const destination = approval.sanitizedArguments.destination;
  const maxBytes = approval.sanitizedArguments.maxBytes;
  const expectedSha256 = approval.sanitizedArguments.expectedSha256;
  const expectedBytes = approval.sanitizedArguments.expectedBytes;
  if (
    typeof source !== "string" ||
    typeof destination !== "string" ||
    typeof maxBytes !== "number" ||
    typeof expectedSha256 !== "string" ||
    typeof expectedBytes !== "number"
  )
    return null;
  return (
    <>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Exact HTTPS resource</dt>
      <dd className="break-all font-mono">{source}</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Destination</dt>
      <dd className="break-all font-mono">{destination}</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Byte bound</dt>
      <dd className="font-mono">{maxBytes.toLocaleString("en-US")} bytes</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Expected size</dt>
      <dd className="font-mono">{expectedBytes.toLocaleString("en-US")} bytes (exact)</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Expected SHA-256</dt>
      <dd className="break-all font-mono text-[10px]">{expectedSha256}</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Redirect policy</dt>
      <dd>Final URL must remain exactly this resource; content is staged until verified.</dd>
    </>
  );
}

export function ApprovalCard({
  approval,
  busy,
  onDecision,
  onRevoke,
}: {
  approval: PublicAgentApprovalDto;
  busy: boolean;
  onDecision: (decision: "approve" | "deny") => void;
  onRevoke: () => void;
}) {
  const canRevoke = approval.decision === "approved" && approval.scope.kind === "session-capability";
  const single = approval.scope.kind === "single-invocation";
  return (
    <article className="border-l-4 border-green bg-[#f0eee7] px-4 py-4 shadow-[0_8px_25px_rgba(26,26,26,0.06)]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-green">
            {single ? "Exact invocation approval" : "Session capability grant"}
          </p>
          <h4 className="mt-1 font-serif text-lg italic">{readable(approval.scope.capability)}</h4>
        </div>
        <span className="border border-charcoal/20 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.15em]">
          {approval.decision}
        </span>
      </header>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Invocation</dt>
        <dd className="break-all font-mono">{approval.invocationId}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Digest</dt>
        <dd className="break-all font-mono text-[10px]">{approval.invocationDigest}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Tool</dt>
        <dd className="font-mono">{approval.toolId}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Target</dt>
        <dd className="break-all font-mono">{approval.scope.targetScope.normalizedTarget}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Boundary</dt>
        <dd>{readable(approval.scope.targetScope.kind)}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Grant breadth</dt>
        <dd>{single ? "This invocation only" : "Matching capability, target, and risk for this session"}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Lifetime</dt>
        <dd>{single ? "Single use before expiry" : "Until session ends, revocation, or expiry"}</dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Risk</dt>
        <dd className={approval.scope.risk !== "low" ? "font-semibold text-red-800" : ""}>
          {readable(approval.scope.risk)}
          {approval.scope.risk === "destructive" ? " — access, permissions, or server state may be affected" : ""}
        </dd>
        <dt className="uppercase tracking-[0.12em] text-charcoal/50">Expires</dt>
        <dd>
          <time dateTime={approval.expiresAt}>{formatDate(approval.expiresAt)}</time>
        </dd>
        <ApprovalOperationalDetails approval={approval} />
        <DownloadApprovalDetails approval={approval} />
      </dl>
      <div className="mt-4 border-y border-charcoal/15 py-3">
        <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-charcoal/50">Sanitized arguments</p>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-5">
          {JSON.stringify(approval.sanitizedArguments, null, 2)}
        </pre>
        {approval.diffSummary && (
          <>
            <p className="mt-3 text-[9px] font-bold uppercase tracking-[0.16em] text-charcoal/50">File diff summary</p>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words border-l-2 border-green/40 pl-3 font-mono text-[10px] leading-5">
              {approval.diffSummary}
            </pre>
          </>
        )}
        {approval.backupFailureStatus && (
          <p role="alert" className="mt-3 border border-red-800/30 bg-red-50 p-3 text-xs font-semibold text-red-800">
            Required backup {approval.backupFailureStatus}.{" "}
            {approval.scope.capability === "maintenance.apply"
              ? "Maintenance remains blocked; proceeding without backup is not supported."
              : "An explicit proceed-or-cancel decision is required before mutation."}
          </p>
        )}
      </div>
      {approval.decision === "pending" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <LuxuryButton className="px-5 py-2" disabled={busy} onClick={() => onDecision("approve")}>
            {single ? "Approve this invocation" : "Grant matching actions for session"}
          </LuxuryButton>
          <LuxuryButton variant="pill" disabled={busy} onClick={() => onDecision("deny")}>
            Deny
          </LuxuryButton>
        </div>
      )}
      {canRevoke && (
        <LuxuryButton className="mt-4 px-5 py-2" disabled={busy} onClick={onRevoke}>
          Revoke grant
        </LuxuryButton>
      )}
    </article>
  );
}

export function ProviderSelector({
  catalog,
  profileId,
  model,
  disabled,
  onChange,
}: {
  catalog: PublicAgentProviderCatalogDto | undefined;
  profileId: string;
  model: string;
  disabled?: boolean;
  onChange: (selection: { profileId: string; model: string }) => void;
}) {
  const profiles = catalog?.profiles ?? [];
  const selected = profiles.find((profile) => profile.profileId === profileId) ?? profiles[0];
  return (
    <fieldset disabled={disabled || profiles.length === 0} className="grid gap-3 sm:grid-cols-2">
      <legend className="sr-only">Provider and model</legend>
      <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-charcoal/60">
        Provider profile
        <select
          aria-label="Provider profile"
          value={selected?.profileId ?? ""}
          onChange={(event) => {
            const profile = profiles.find((candidate) => candidate.profileId === event.target.value);
            if (profile) onChange({ profileId: profile.profileId, model: profile.allowedModels[0] });
          }}
          className="mt-1 block w-full border border-charcoal/20 bg-cream px-3 py-2 font-mono text-xs normal-case tracking-normal"
        >
          {profiles.map((profile) => (
            <option key={profile.profileId} value={profile.profileId}>
              {profile.displayName} — {profile.endpointDisplay}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-charcoal/60">
        Model
        <select
          aria-label="Model"
          value={selected?.allowedModels.includes(model) ? model : (selected?.allowedModels[0] ?? "")}
          onChange={(event) => selected && onChange({ profileId: selected.profileId, model: event.target.value })}
          className="mt-1 block w-full border border-charcoal/20 bg-cream px-3 py-2 font-mono text-xs normal-case tracking-normal"
        >
          {selected?.allowedModels.map((allowed) => (
            <option key={allowed} value={allowed}>
              {allowed}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

export function EventTimeline({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="border border-dashed border-charcoal/20 px-5 py-10 text-center text-xs text-charcoal/50">
        No output yet. Ordered events will appear here.
      </p>
    );
  }
  return (
    <ol className="relative space-y-0 before:absolute before:bottom-4 before:left-[1.1rem] before:top-4 before:w-px before:bg-charcoal/15">
      {events.map((event) => (
        <li key={event.eventId} className="relative grid grid-cols-[2.25rem_1fr] gap-3 py-3">
          <span className="z-10 flex h-9 w-9 items-center justify-center rounded-full border border-charcoal/20 bg-cream font-mono text-[9px]">
            {event.sequence}
          </span>
          <div className="min-w-0 border-b border-charcoal/10 pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-[10px] font-bold uppercase tracking-[0.18em] text-green">{readable(event.kind)}</h4>
              <time className="text-[9px] text-charcoal/40" dateTime={event.timestamp}>
                {new Date(event.timestamp).toLocaleTimeString()}
              </time>
            </div>
            <p className="mt-1 break-words text-xs leading-5 text-charcoal/70">{eventSummary(event)}</p>
            <MaintenanceObservationStatus event={event} />
          </div>
        </li>
      ))}
    </ol>
  );
}

// Workspace orchestration intentionally keeps query, mutation, and stream states visible together.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: top-level operations-room state coordinator.
export function AgentWorkspace() {
  const { isAdmin, isLoading } = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [composeMode, setComposeMode] = useState<"new" | "continue">("new");
  const [providerSelection, setProviderSelection] = useState({ profileId: "", model: "" });
  const [policy, setPolicy] = useState(() => ({
    preset: "maintainer" as PermissionPresetName,
    rules: copyRules("maintainer"),
    backupMode: PERMISSION_PRESETS.maintainer.backupMode,
  }));
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streamState, setStreamState] = useState<
    "idle" | "connecting" | "live" | "reconnecting" | "error" | "terminal"
  >("idle");
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const streamCursor = useRef<string | undefined>(undefined);
  const seenEvents = useRef(new Set<string>());
  const sessionStatus = useRef<PublicAgentSessionDetailDto["status"] | undefined>(undefined);

  const sessionsQuery = useQuery({ queryKey: agentQueryKeys.sessions, queryFn: fetchAgentSessions, enabled: isAdmin });
  const providersQuery = useQuery({
    queryKey: agentQueryKeys.providers,
    queryFn: fetchAgentProviderCatalog,
    enabled: isAdmin,
  });
  const sessions = sessionsQuery.data ?? [];
  useEffect(() => {
    if (!selectedId && sessions[0]) setSelectedId(sessions[0].sessionId);
  }, [selectedId, sessions]);

  const detailQuery = useQuery({
    queryKey: agentQueryKeys.session(selectedId ?? "none"),
    queryFn: () => fetchAgentSession(selectedId as string),
    enabled: isAdmin && Boolean(selectedId),
  });
  const detail = detailQuery.data;
  sessionStatus.current = detail?.status;
  useEffect(() => {
    const first = providersQuery.data?.profiles[0];
    if (!providerSelection.profileId && first) {
      setProviderSelection({ profileId: first.profileId, model: first.allowedModels[0] });
    }
  }, [providerSelection.profileId, providersQuery.data]);
  useEffect(() => {
    if (composeMode === "continue" && detail) {
      setProviderSelection({ profileId: detail.providerProfileId, model: detail.model });
    }
  }, [composeMode, detail]);

  const publishDetail = useCallback(
    (next: PublicAgentSessionDetailDto) => {
      queryClient.setQueryData(agentQueryKeys.session(next.sessionId), next);
      void queryClient.invalidateQueries({ queryKey: agentQueryKeys.sessions });
    },
    [queryClient]
  );

  const handleMutationError = useCallback(
    async (error: unknown) => {
      if (error instanceof ClientApiError && error.status === 409 && selectedId) {
        await queryClient.fetchQuery({
          queryKey: agentQueryKeys.session(selectedId),
          queryFn: () => fetchAgentSession(selectedId),
        });
        setNotice({ kind: "error", text: "The session changed elsewhere. Latest revision loaded; review and retry." });
        return;
      }
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The agent request failed." });
    },
    [queryClient, selectedId]
  );

  const createMutation = useMutation({
    mutationFn: async (input: { task: string; idempotencyKey: string }) => {
      if (composeMode === "continue") {
        if (!detail) throw new Error("Select an idle session to continue.");
        return await continueAgentSession(detail.sessionId, {
          expectedRevision: detail.revision,
          idempotencyKey: input.idempotencyKey,
          task: input.task,
          providerProfileId: providerSelection.profileId,
          model: providerSelection.model,
        });
      }
      return await createAgentSession({
        ...input,
        ...policy,
        providerProfileId: providerSelection.profileId,
        model: providerSelection.model,
      });
    },
    onSuccess: (next) => {
      publishDetail(next);
      setSelectedId(next.sessionId);
      setTask("");
      setNotice({ kind: "status", text: "Task accepted. Monitoring ordered output." });
    },
    onError: handleMutationError,
  });
  const actionMutation = useMutation({
    mutationFn: async (action: () => Promise<PublicAgentSessionDetailDto>) => action(),
    onSuccess: publishDetail,
    onError: handleMutationError,
  });

  useEffect(() => {
    seenEvents.current = new Set();
    streamCursor.current = undefined;
    setEvents([]);
    if (!selectedId || !isAdmin) return;
    const controller = new AbortController();
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const detailRefresh = createAgentDetailRefreshScheduler(() => {
      if (!stopped) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: agentQueryKeys.session(selectedId), refetchType: "active" }),
          queryClient.invalidateQueries({ queryKey: agentQueryKeys.sessions, refetchType: "active" }),
        ]);
      }
    });

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: finite SSE lifecycle handles replay, terminal, and retry outcomes.
    const connect = async () => {
      if (stopped) return;
      setStreamState(attempts === 0 ? "connecting" : "reconnecting");
      try {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive stream message reducer.
        const handleStreamMessage = (message: AgentStreamMessage) => {
          if (message.type === "event") {
            streamCursor.current = message.event.replayCursor;
            if (!seenEvents.current.has(message.event.eventId)) {
              seenEvents.current.add(message.event.eventId);
              setEvents((current) => [...current, message.event].sort((a, b) => a.sequence - b.sequence));
              if (shouldRefreshAgentSessionDetail(message.event)) detailRefresh.schedule();
            }
            if (message.event.kind === "cancellation" || message.event.kind === "error") {
              setStreamState("terminal");
            } else if (message.event.kind === "completion") {
              setStreamState("idle");
            } else setStreamState("live");
          } else if (message.type === "replay-truncated") {
            setNotice({
              kind: "error",
              text: `Earlier events were retired. Timeline resumes at sequence ${message.retainedFromSequence}.`,
            });
          } else {
            setNotice({ kind: "error", text: message.message });
          }
        };
        await readAgentEventStream(selectedId, streamCursor.current, handleStreamMessage, controller.signal);
        attempts = 0;
        if (!stopped && !TERMINAL.has(sessionStatus.current ?? "")) timer = setTimeout(connect, 250);
        else if (!stopped) setStreamState("terminal");
      } catch {
        if (controller.signal.aborted || stopped) return;
        attempts += 1;
        setStreamState(attempts >= 5 ? "error" : "reconnecting");
        const delay = Math.min(8000, 500 * 2 ** Math.min(attempts, 4));
        timer = setTimeout(connect, delay);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      detailRefresh.stop();
    };
  }, [isAdmin, queryClient, selectedId]);

  const terminalResult = useMemo(
    () =>
      [...events]
        .reverse()
        .find((event) => event.kind === "completion" || event.kind === "error" || event.kind === "cancellation"),
    [events]
  );
  const streamLabel = streamState === "live" ? "stream live" : readable(streamState);

  if (isLoading) return <AccessState kind="loading" />;
  if (!isAdmin) return <AccessState kind="denied" />;

  const mutateApproval = (approval: PublicAgentApprovalDto, decision: "approve" | "deny") => {
    if (!detail) return;
    actionMutation.mutate(() =>
      decideAgentApproval(
        detail.sessionId,
        approval.approvalId,
        detail.revision,
        decision,
        operationKey(`approval-${decision}`)
      )
    );
  };

  return (
    <main
      data-testid="agent-page"
      className="relative min-h-dvh bg-cream px-4 py-3 selection:bg-green selection:text-white sm:px-6 lg:h-dvh lg:overflow-hidden"
    >
      <ArtDecoBorder />
      <PageHeader showUtilities={false} />
      <div className="mx-auto flex max-w-[1600px] items-end justify-between gap-4 border-b border-charcoal/20 pb-3">
        <div>
          <p className="text-[9px] uppercase tracking-[0.3em] text-green">Live server operations</p>
          <h1 className="font-serif text-2xl italic sm:text-3xl">Agent control room</h1>
        </div>
        <div className="hidden items-center gap-6 text-right sm:flex">
          <div>
            <p className="text-[8px] uppercase tracking-[0.2em] text-charcoal/40">Provider</p>
            <p className="font-mono text-xs">{providerSelection.profileId || "unavailable"}</p>
          </div>
          <div>
            <p className="text-[8px] uppercase tracking-[0.2em] text-charcoal/40">Model</p>
            <p className="font-mono text-xs">{providerSelection.model || "unavailable"}</p>
          </div>
        </div>
      </div>

      <div className="mx-auto mt-3 grid max-w-[1600px] border border-charcoal/20 bg-white/20 shadow-[0_18px_60px_rgba(26,26,26,0.07)] lg:h-[calc(100dvh-10.5rem)] lg:grid-cols-[15rem_minmax(0,1fr)]">
        <SessionRail
          sessions={sessions}
          selectedId={selectedId}
          pending={sessionsQuery.isPending}
          onSelect={setSelectedId}
        />
        <div className="min-w-0 overflow-y-auto">
          <section className="border-b border-charcoal/15 p-4 sm:p-5" aria-labelledby="task-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="task-heading" className="font-serif text-xl italic">
                Task directive
              </h2>
              <p className="sm:hidden font-mono text-[9px] text-charcoal/50">
                {providerSelection.profileId || "unavailable"} / {providerSelection.model || "unavailable"}
              </p>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!task.trim()) return;
                createMutation.mutate({ task: task.trim(), idempotencyKey: operationKey(composeMode) });
              }}
            >
              <label htmlFor="agent-task" className="sr-only">
                Agent task
              </label>
              <textarea
                id="agent-task"
                value={task}
                onChange={(event) => setTask(event.target.value)}
                maxLength={8000}
                rows={3}
                placeholder="Inspect the live server and state the evidence required before proposing any change…"
                className="w-full resize-y border border-charcoal/20 bg-cream/70 px-4 py-3 text-sm leading-6 placeholder:text-charcoal/35"
              />
              <div className="mt-3 grid gap-3 border-y border-charcoal/10 py-3 lg:grid-cols-[auto_1fr]">
                <fieldset className="flex flex-wrap items-center gap-4 text-xs">
                  <legend className="sr-only">Task destination</legend>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="compose-mode"
                      checked={composeMode === "new"}
                      onChange={() => setComposeMode("new")}
                    />
                    New session
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="compose-mode"
                      checked={composeMode === "continue"}
                      disabled={!detail || detail.status !== "idle"}
                      onChange={() => setComposeMode("continue")}
                    />
                    Continue selected idle session
                  </label>
                </fieldset>
                <ProviderSelector
                  catalog={providersQuery.data}
                  {...providerSelection}
                  disabled={createMutation.isPending}
                  onChange={setProviderSelection}
                />
              </div>
              <div className="mt-3">
                <PolicyEditor {...policy} disabled={createMutation.isPending} onChange={setPolicy} />
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[9px] uppercase tracking-[0.14em] text-charcoal/45">
                  Immutable host, credential, metadata and outside-workspace boundaries remain denied.
                </p>
                <LuxuryButton
                  type="submit"
                  disabled={!task.trim() || !providerSelection.model || createMutation.isPending}
                >
                  {createMutation.isPending
                    ? "Dispatching…"
                    : composeMode === "continue"
                      ? "Continue session"
                      : "Dispatch task"}
                </LuxuryButton>
              </div>
            </form>
          </section>

          <section className="grid min-h-[28rem] xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,.8fr)]">
            <div className="min-w-0 border-b border-charcoal/15 p-4 sm:p-5 xl:border-b-0 xl:border-r">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-charcoal/10 pb-3">
                <div>
                  <p className="text-[9px] uppercase tracking-[0.22em] text-charcoal/45">Sequence register</p>
                  <h3 className="font-serif text-xl italic">Ordered output</h3>
                </div>
                <span
                  className={`text-[9px] font-bold uppercase tracking-[0.15em] ${streamState === "error" ? "text-red-800" : "text-green"}`}
                  aria-live="polite"
                >
                  {streamLabel}
                </span>
              </div>
              {detailQuery.isPending && selectedId ? (
                <p className="py-10 text-center text-xs text-charcoal/50">Loading session record…</p>
              ) : (
                <EventTimeline events={events} />
              )}
            </div>

            <div className="min-w-0 space-y-5 p-4 sm:p-5">
              <section aria-labelledby="session-status-heading">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[9px] uppercase tracking-[0.22em] text-charcoal/45">Current position</p>
                    <h3 id="session-status-heading" className="font-serif text-xl italic">
                      Session status
                    </h3>
                  </div>
                  {detail && <StatusPip status={detail.status} />}
                </div>
                {!selectedId && (
                  <p className="mt-4 border border-dashed border-charcoal/20 p-5 text-xs text-charcoal/50">
                    Select a historical run or dispatch a new task.
                  </p>
                )}
                {detailQuery.isError && (
                  <p role="alert" className="mt-4 border border-red-800/30 bg-red-50 p-3 text-xs text-red-800">
                    Could not load this session. Retry from the history rail.
                  </p>
                )}
                {detail && (
                  <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-charcoal/10 py-3 text-xs">
                    <div>
                      <dt className="text-[8px] uppercase tracking-[0.16em] text-charcoal/40">Revision</dt>
                      <dd className="mt-1 font-mono">{detail.revision}</dd>
                    </div>
                    <div>
                      <dt className="text-[8px] uppercase tracking-[0.16em] text-charcoal/40">Events</dt>
                      <dd className="mt-1 font-mono">{Math.max(detail.lastEventSequence, events.length)}</dd>
                    </div>
                    <div>
                      <dt className="text-[8px] uppercase tracking-[0.16em] text-charcoal/40">Preset</dt>
                      <dd className="mt-1 capitalize">{detail.policy.preset}</dd>
                    </div>
                    <div>
                      <dt className="text-[8px] uppercase tracking-[0.16em] text-charcoal/40">Backup</dt>
                      <dd className="mt-1">{readable(detail.policy.backupMode)}</dd>
                    </div>
                  </dl>
                )}
                {detail && !TERMINAL.has(detail.status) && (
                  <LuxuryButton
                    variant="pill"
                    className="mt-4 border-red-900/30 text-red-900"
                    disabled={actionMutation.isPending}
                    onClick={() =>
                      actionMutation.mutate(() =>
                        cancelAgentSession(detail.sessionId, detail.revision, operationKey("cancel"))
                      )
                    }
                  >
                    Cancel session
                  </LuxuryButton>
                )}
              </section>

              {detail?.approvals.map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  busy={actionMutation.isPending}
                  onDecision={(decision) => mutateApproval(approval, decision)}
                  onRevoke={() =>
                    actionMutation.mutate(() =>
                      revokeAgentApproval(
                        detail.sessionId,
                        approval.approvalId,
                        detail.revision,
                        operationKey("revoke")
                      )
                    )
                  }
                />
              ))}

              {detail && TERMINAL.has(detail.status) && (
                <section className="border border-charcoal/20 bg-white/50 p-4" aria-labelledby="final-result-heading">
                  <p className="text-[9px] uppercase tracking-[0.22em] text-green">Terminal record</p>
                  <h3 id="final-result-heading" className="mt-1 font-serif text-xl italic">
                    Final result
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-charcoal/65">
                    {terminalResult
                      ? eventSummary(terminalResult)
                      : `Session ${readable(detail.status)}. No additional result evidence was emitted.`}
                  </p>
                </section>
              )}
            </div>
          </section>
        </div>
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          aria-live={notice.kind === "error" ? "assertive" : "polite"}
          className={`fixed bottom-6 left-1/2 z-[60] max-w-[calc(100%-3rem)] -translate-x-1/2 border bg-cream px-5 py-3 text-xs shadow-xl ${notice.kind === "error" ? "border-red-800 text-red-800" : "border-green text-green"}`}
        >
          {notice.text}
          <button
            type="button"
            className="ml-4 font-bold uppercase tracking-widest"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
}
