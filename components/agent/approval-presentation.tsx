import type { AgentEvent, JsonObject, JsonValue } from "@/lib/agent/contracts";
import type { PublicAgentApprovalDto } from "@/lib/agent/control-plane/contracts";

function stringArgument(arguments_: JsonObject, key: string): string | undefined {
  const value = arguments_[key];
  return typeof value === "string" ? value : undefined;
}

function numberArgument(arguments_: JsonObject, key: string): number | undefined {
  const value = arguments_[key];
  return typeof value === "number" ? value : undefined;
}

function objectArgument(arguments_: JsonObject, key: string): JsonObject | undefined {
  const value = arguments_[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function displayBytes(value: number | undefined): string {
  return typeof value === "number" ? `${value.toLocaleString("en-US")} bytes` : "Not supplied";
}

function displayDigest(value: string | undefined): string {
  return value ?? "Not supplied";
}

function scopeText(approval: PublicAgentApprovalDto): string {
  return `${approval.scope.targetScope.kind}: ${approval.scope.targetScope.normalizedTarget}`;
}

function BackupStatus({
  approval,
  required,
  maintenance,
}: {
  approval: PublicAgentApprovalDto;
  required: boolean | "policy";
  maintenance?: boolean;
}) {
  if (!required) {
    return <span>Not required for this read-only operation.</span>;
  }
  if (approval.backupFailureStatus) {
    return (
      <span>
        Required backup status: {approval.backupFailureStatus}{" "}
        {maintenance
          ? "Maintenance remains blocked; this capability has no proceed-without-backup path."
          : "An explicit proceed-or-cancel decision is required before the mutation can commit."}
      </span>
    );
  }
  if (required === "policy") {
    return (
      <span>
        Policy-controlled for this staged mutation; a backup is required when the active policy says so. No completed
        backup evidence is attached to this approval.
      </span>
    );
  }
  return (
    <span>
      Required before the {maintenance ? "service stop and MOTD edit" : "staged mutation"}; no completed backup evidence
      is attached to this approval.
    </span>
  );
}

function ShellApprovalDetails({ approval }: { approval: PublicAgentApprovalDto }) {
  const args = approval.sanitizedArguments;
  const mode = stringArgument(args, "mode");
  const command = stringArgument(args, "command");
  const timeoutMs = numberArgument(args, "timeoutMs");
  const change = objectArgument(args, "change");
  const operation = change ? stringArgument(change, "operation") : undefined;
  const path = change ? stringArgument(change, "path") : undefined;
  const staged = mode === "staged-write" && (operation === "replace" || operation === "delete") && path;

  return (
    <>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Shell mode</dt>
      <dd className="font-mono">{mode ?? "Unavailable - review is incomplete."}</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Full exact reviewed command</dt>
      <dd className="min-w-0">
        <pre
          data-testid="reviewed-shell-command"
          className="whitespace-pre-wrap break-words border-l-2 border-green/40 pl-3 font-mono text-[10px] leading-5"
        >
          {command ?? "Unavailable - review is incomplete."}
        </pre>
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Effective read scope</dt>
      <dd>
        Mounted workspace root (.) - {scopeText(approval)}. Server-file access is limited to the ROworkspace boundary;
        production execution is unavailable until a reviewed runner is configured.
      </dd>
      {staged ? (
        <>
          <dt className="uppercase tracking-[0.12em] text-charcoal/50">Exact staged write/delete scope</dt>
          <dd className="font-mono">
            {operation} {path}
          </dd>
        </>
      ) : (
        <>
          <dt className="uppercase tracking-[0.12em] text-charcoal/50">Exact staged write/delete scope</dt>
          <dd>{mode === "read-only" ? "None - read-only shell." : "Unavailable - staged change is incomplete."}</dd>
        </>
      )}
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Command timeout</dt>
      <dd className="font-mono">
        {timeoutMs !== undefined ? `${timeoutMs.toLocaleString("en-US")} ms` : "Not supplied"}
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Backup requirement / status</dt>
      <dd>
        <BackupStatus approval={approval} required={mode === "staged-write" ? "policy" : false} />
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Downtime</dt>
      <dd>None from the shell boundary; a staged file commit does not restart Minecraft.</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Verification</dt>
      <dd>
        Reviewed runner exit status and bounded output; staged output is validated as a regular file before commit. No
        service-readiness observation is included.
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Rollback limitations</dt>
      <dd>No automatic rollback. Runner effects and a committed staged write/delete must be reconciled manually.</dd>
    </>
  );
}

function MaintenanceApprovalDetails({ approval }: { approval: PublicAgentApprovalDto }) {
  const args = approval.sanitizedArguments;
  const expectedProtocol = objectArgument(args, "expectedProtocol");
  const host = expectedProtocol ? stringArgument(expectedProtocol, "host") : undefined;
  const port = expectedProtocol ? numberArgument(expectedProtocol, "port") : undefined;
  const expectedMotd = expectedProtocol ? stringArgument(expectedProtocol, "motd") : undefined;
  const value = stringArgument(args, "value") ?? expectedMotd;

  return (
    <>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Effective maintenance scope</dt>
      <dd className="font-mono">server.properties -&gt; motd only</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Reviewed MOTD value</dt>
      <dd className="break-words">{value ?? "Unavailable - review is incomplete."}</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Pre-edit identity</dt>
      <dd className="break-all font-mono">
        SHA-256 {displayDigest(stringArgument(args, "expectedSha256"))};{" "}
        {displayBytes(numberArgument(args, "expectedBytes"))}
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Post-edit identity</dt>
      <dd className="break-all font-mono">
        SHA-256 {displayDigest(stringArgument(args, "resultSha256"))};{" "}
        {displayBytes(numberArgument(args, "resultBytes"))}
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Service intent</dt>
      <dd className="font-mono">{stringArgument(args, "serviceIntent") ?? "restore-prior"}</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Backup requirement / status</dt>
      <dd>
        <BackupStatus approval={approval} maintenance required />
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Downtime</dt>
      <dd>Required - the same minecraft.service is stopped for the edit, then the prior service intent is restored.</dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Verification</dt>
      <dd>
        Independent Minecraft protocol observation at {host ?? "127.0.0.1"}:{port ?? 25565} must report the exact
        approved MOTD. A successful observation is not inferred from the file write alone.
      </dd>
      <dt className="uppercase tracking-[0.12em] text-charcoal/50">Rollback limitations</dt>
      <dd>
        restore-prior restores service intent, not the prior file value. A committed edit with unknown protocol
        observation remains indeterminate and fenced; do not retry blindly or assume automatic rollback.
      </dd>
    </>
  );
}

export function ApprovalOperationalDetails({ approval }: { approval: PublicAgentApprovalDto }) {
  if (approval.scope.capability === "shell.execute") return <ShellApprovalDetails approval={approval} />;
  if (approval.scope.capability === "maintenance.apply") return <MaintenanceApprovalDetails approval={approval} />;
  return null;
}

type MaintenanceObservationStatus = "success" | "unknown";

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * Reads only already-published tool-result evidence. It never treats a file
 * commit, service restart, or elapsed time as proof of protocol readiness.
 */
export function maintenanceObservationStatus(event: AgentEvent): MaintenanceObservationStatus | undefined {
  if (event.kind !== "tool-result") return undefined;
  const data = event.payload.data;
  const output = record(data.output);
  const commit = record(data.mutationCommit);
  const protocol = output ? record(output.protocol) : undefined;
  const verification = output ? stringArgument(output, "verification") : undefined;
  const commitPoint = commit
    ? stringArgument(commit, "point")
    : output
      ? stringArgument(output, "commitPoint")
      : undefined;
  const knownMotdProtocol =
    protocol !== undefined &&
    stringArgument(protocol, "protocol") === "minecraft-status" &&
    stringArgument(protocol, "host") === "127.0.0.1" &&
    numberArgument(protocol, "port") === 25565 &&
    typeof protocol.motd === "string" &&
    protocol.independentlyObserved === true;
  const knownMaintenanceResult =
    knownMotdProtocol &&
    output?.committed === true &&
    typeof output.configSha256 === "string" &&
    typeof output.configBytes === "number";
  const maintenanceEvidence = commitPoint === "maintenance-edit" || knownMaintenanceResult;
  if (!maintenanceEvidence) return undefined;
  if (data.status === "succeeded" && verification === "observed" && knownMaintenanceResult) return "success";
  return "unknown";
}

export function MaintenanceObservationStatus({ event }: { event: AgentEvent }) {
  const status = maintenanceObservationStatus(event);
  if (!status) return null;
  return (
    <p
      data-testid="motd-observation-status"
      className={`mt-2 border-l-2 pl-3 text-[10px] font-semibold uppercase tracking-[0.12em] ${
        status === "success" ? "border-green text-green" : "border-red-800 text-red-800"
      }`}
    >
      MOTD observation status:{" "}
      {status === "success" ? "success - independently observed" : "unknown - reconciliation required"}
    </p>
  );
}
