import type {
  AgentEvent,
  AgentSession,
  BackupEvaluation,
  JsonObject,
  ProviderConfiguration,
  ToolCancellation,
  ToolInvocation,
  ToolProgress,
  ToolResult,
} from "@/lib/agent/contracts";

export interface HarnessRunInput {
  session: AgentSession;
  provider: ProviderConfiguration;
  prompt: string;
  signal?: AbortSignal;
}

export interface AgentHarnessAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  run(input: HarnessRunInput): AsyncIterable<AgentEvent>;
}

export interface AgentToolExecutorAdapter {
  /** Finite upper bound during which an exact durable executor result may still be recovered. */
  readonly reconciliationTimeoutMs?: number;
  invoke(
    invocation: ToolInvocation,
    onProgress: (progress: ToolProgress) => void,
    signal: AbortSignal
  ): Promise<ToolResult>;
  cancel(cancellation: ToolCancellation): Promise<void>;
}

export interface AgentProviderAdapter {
  readonly providerId: string;
  stream(configuration: ProviderConfiguration, request: JsonObject, signal?: AbortSignal): AsyncIterable<JsonObject>;
}

export interface AgentBackupAdapter {
  create(sessionId: string, invocationId: string): Promise<{ backupId: string; createdAt: string }>;
  evaluateAvailability(): Promise<"available" | "unavailable">;
}

export interface AgentPolicyAdapter {
  evaluateBackup(sessionId: string, invocationId: string): Promise<BackupEvaluation>;
}
