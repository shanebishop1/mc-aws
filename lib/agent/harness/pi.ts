import path from "node:path";
import type { AgentHarnessAdapter, AgentToolExecutorAdapter, HarnessRunInput } from "@/lib/agent/adapters";
import {
  AGENT_SCHEMA_VERSION,
  type AgentEvent,
  type JsonObject,
  type JsonValue,
  type TargetScope,
  type ToolDefinition,
  type ToolInvocation,
  type ToolProgress,
  type ToolResult,
} from "@/lib/agent/contracts";
import { REDACTION_MARKER, StreamingSecretRedactor, redactSecretAwareJson } from "@/lib/agent/redaction";
import {
  MAX_AGENT_EVENT_PAYLOAD_BYTES,
  MAX_PI_QUEUED_EVENTS,
  MAX_PI_QUEUED_EVENT_BYTES,
  MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
  PROVIDER_RESOURCE_LIMIT_CODE,
  PROVIDER_RESOURCE_LIMIT_MESSAGE,
  boundToolResult,
  serializedUtf8Bytes,
} from "@/lib/agent/response-limits";
import { agentSchemas } from "@/lib/agent/validators";
import {
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Unsafe } from "typebox";

const PI_ADAPTER_ID = "pi-coding-agent";
const PI_ADAPTER_VERSION = "0.84.4";
const SAFE_ERROR_MESSAGE = "Pi harness execution failed.";
const CANCELLATION_REASON = "Agent run cancelled.";
const DEFAULT_CANCELLATION_TIMEOUT_MS = 120_000;
const MAX_CANCELLATION_TIMEOUT_MS = 15 * 60_000;

export interface AgentEventRedactor {
  redact(data: JsonObject): JsonObject;
  redactStreamChunk?(streamId: string, chunk: string): string;
  flushStream?(streamId: string): string;
}

export interface SecretAwareEventRedactorOptions {
  exactSecrets: readonly string[];
}

/** Creates a reusable deep event redactor. Sensitive keys are omitted rather than marked. */
export function createSecretAwareEventRedactor(options: SecretAwareEventRedactorOptions): AgentEventRedactor {
  const exactSecrets = [...new Set(options.exactSecrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length
  );
  const streams = new Map<string, StreamingSecretRedactor>();
  return {
    redact: (data) => redactSecretAwareJson(data, exactSecrets),
    redactStreamChunk(streamId, chunk) {
      const stream = streams.get(streamId) ?? new StreamingSecretRedactor(exactSecrets);
      streams.set(streamId, stream);
      return stream.push(chunk);
    },
    flushStream(streamId) {
      const stream = streams.get(streamId);
      streams.delete(streamId);
      return stream?.flush() ?? "";
    },
  };
}

export interface PiToolBridge {
  /** Pi-facing name. The executor always receives definition.toolId instead. */
  name: string;
  definition: ToolDefinition;
  resolveTargetScope(arguments_: JsonObject): TargetScope;
}

export interface PiRuntimeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: JsonObject;
}

export interface PiRuntimeTool {
  name: string;
  label: string;
  description: string;
  parameters: JsonObject;
  execute(
    toolCallId: string,
    arguments_: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: PiRuntimeToolResult) => void
  ): Promise<PiRuntimeToolResult>;
}

export interface PiRuntimeEvent {
  type: string;
  assistantMessageEvent?: unknown;
  [key: string]: unknown;
}

export interface PiRuntimeSession {
  subscribe(listener: (event: PiRuntimeEvent) => void): () => void;
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PiRuntimeCreateInput {
  sessionId: string;
  providerProfileId: string;
  model: string;
  tools: PiRuntimeTool[];
}

export interface PiRuntime {
  createSession(input: PiRuntimeCreateInput): Promise<PiRuntimeSession>;
}

export interface PiHarnessAdapterOptions {
  runtime: PiRuntime;
  toolExecutor: AgentToolExecutorAdapter;
  tools: readonly PiToolBridge[];
  eventRedactor: AgentEventRedactor;
  /** Production provider transport trips this signal on a local response-bound violation. */
  providerResponseLimitSignal?: AbortSignal;
  cancellationTimeoutMs?: number;
  now?: () => Date;
  createId?: () => string;
}

export interface PiSdkSessionConfiguration {
  /** Opaque Pi model supplied by a future provider adapter. */
  model: unknown;
  /** Opaque Pi ModelRuntime supplied by a future provider adapter. */
  modelRuntime: unknown;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}

export interface PiSdkRuntimeOptions {
  resolveSessionConfiguration(input: {
    providerProfileId: string;
    model: string;
  }): Promise<PiSdkSessionConfiguration> | PiSdkSessionConfiguration;
  cwd: string;
  agentDir: string;
  systemPrompt?: string;
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private queuedBytes = 0;
  private ended = false;
  private cancellationFenced = false;
  private resourceFenced = false;

  private allowedAfterCancellation(value: AgentEvent): boolean {
    if (value.kind === "cancellation") return true;
    return value.kind === "tool-result";
  }

  push(value: AgentEvent): "accepted" | "overflow" | "ignored" {
    if (this.ended) return "ignored";
    if ((this.cancellationFenced || this.resourceFenced) && !this.allowedAfterCancellation(value)) return "ignored";
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (
      bytes > MAX_PI_QUEUED_EVENT_BYTES ||
      (!this.waiters.length &&
        (this.values.length + 1 > MAX_PI_QUEUED_EVENTS || this.queuedBytes + bytes > MAX_PI_QUEUED_EVENT_BYTES))
    ) {
      return "overflow";
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      this.values.push(value);
      this.queuedBytes += bytes;
    }
    return "accepted";
  }

  fenceForCancellation(): void {
    if (this.cancellationFenced) return;
    this.cancellationFenced = true;
    const retained = this.values.filter((value) => this.allowedAfterCancellation(value));
    this.values.splice(0, this.values.length, ...retained);
    this.queuedBytes = retained.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0);
  }

  failClosed(value: AgentEvent): void {
    if (this.ended || this.resourceFenced) return;
    this.resourceFenced = true;
    this.values.splice(0);
    this.queuedBytes = 0;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      this.values.push(value);
      this.queuedBytes = Buffer.byteLength(JSON.stringify(value));
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) {
          this.queuedBytes -= Buffer.byteLength(JSON.stringify(value));
          return Promise.resolve({ done: false, value });
        }
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function assertJsonValue(value: unknown, path = "arguments"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be plain JSON.`);
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${path} contains an unsafe key.`);
      }
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} must be JSON-serializable.`);
}

function asJsonObject(value: unknown): JsonObject {
  assertJsonValue(value);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Tool arguments must be a JSON object.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toolResultForPi(result: ToolResult): PiRuntimeToolResult {
  return {
    content: [{ type: "text", text: result.summary }],
    details: {
      status: result.status,
      output: result.output,
      ...(result.mutationCommit ? { mutationCommit: result.mutationCommit as unknown as JsonObject } : {}),
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function waitWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<
  { settled: false } | { settled: true; outcome: { type: "value"; value: T } | { type: "error"; error: unknown } }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ settled: true as const, outcome: { type: "value" as const, value } }),
      (error: unknown) => ({ settled: true as const, outcome: { type: "error" as const, error } })
    ),
    new Promise<{ settled: false }>((resolve) => {
      timeout = setTimeout(() => resolve({ settled: false }), timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return outcome;
}

async function completeBeforeCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cancellationTimeoutMs: number
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
  const outcome = await Promise.race([
    operation.then(
      (value) => ({ type: "value" as const, value }),
      (error: unknown) => ({ type: "error" as const, error })
    ),
    waitForAbort(signal).then(() => ({ type: "cancelled" as const })),
  ]);
  if (outcome.type === "error") throw outcome.error;
  if (outcome.type === "value" && !signal.aborted) return { cancelled: false, value: outcome.value };
  await waitWithin(operation, cancellationTimeoutMs);
  return { cancelled: true };
}

async function invokeToolExecutor(
  executor: AgentToolExecutorAdapter,
  invocation: ToolInvocation,
  onProgress: (progress: ToolProgress) => void,
  signal: AbortSignal,
  cancellationTimeoutMs: number,
  now: () => Date
): Promise<ToolResult> {
  const cancelledResult = (): ToolResult => ({
    schemaVersion: AGENT_SCHEMA_VERSION,
    invocationId: invocation.invocationId,
    status: "cancelled",
    completedAt: now().toISOString(),
    summary: "Tool execution cancelled.",
    output: null,
    evidence: [],
  });
  const indeterminateResult = (): ToolResult => ({
    schemaVersion: AGENT_SCHEMA_VERSION,
    invocationId: invocation.invocationId,
    status: "indeterminate",
    completedAt: now().toISOString(),
    summary: "Tool effect completion is indeterminate; automatic retry is fenced.",
    output: { code: "indeterminate-effect", reconciliation: "required" },
    evidence: [],
  });
  const resultAfterCancellation = (result: ToolResult): ToolResult => {
    if (result.status === "indeterminate" || result.mutationCommit?.committed === true) return result;
    return cancelledResult();
  };
  if (signal.aborted) return cancelledResult();
  const execution = Promise.resolve().then(() => executor.invoke(invocation, onProgress, signal));
  try {
    const outcome = await Promise.race([
      execution.then((result) => ({ type: "result" as const, result })),
      waitForAbort(signal).then(() => ({ type: "cancelled" as const })),
    ]);
    if (outcome.type === "cancelled") {
      const settled = await settleWithin(execution, cancellationTimeoutMs);
      if (!settled.settled) return indeterminateResult();
      if (settled.outcome.type === "error") return cancelledResult();
      return resultAfterCancellation(settled.outcome.value);
    }
    if (signal.aborted) return resultAfterCancellation(outcome.result);
    return outcome.result;
  } catch {
    if (signal.aborted) return cancelledResult();
    return {
      schemaVersion: AGENT_SCHEMA_VERSION,
      invocationId: invocation.invocationId,
      status: "failed",
      completedAt: now().toISOString(),
      summary: "Tool execution failed.",
      output: null,
      evidence: [],
    };
  }
}

function validateToolBridges(tools: readonly PiToolBridge[]): void {
  const names = new Set<string>();
  const toolIds = new Set<string>();
  for (const tool of tools) {
    agentSchemas.toolDefinition.parse(tool.definition);
    if (!/^[A-Za-z0-9_-]+$/.test(tool.name)) throw new TypeError(`Invalid Pi tool name: ${tool.name}`);
    if (names.has(tool.name)) throw new TypeError(`Duplicate Pi tool name: ${tool.name}`);
    if (toolIds.has(tool.definition.toolId)) throw new TypeError(`Duplicate mc-aws tool ID: ${tool.definition.toolId}`);
    names.add(tool.name);
    toolIds.add(tool.definition.toolId);
  }
}

/**
 * Creates the real Pi SDK runtime without selecting or contacting a model provider.
 * Built-in tools and resource discovery are disabled; only supplied custom tools are enabled.
 */
export function createPiSdkRuntime(options: PiSdkRuntimeOptions): PiRuntime {
  if (!path.isAbsolute(options.cwd)) throw new TypeError("Pi SDK cwd must be an absolute path.");
  if (!path.isAbsolute(options.agentDir)) throw new TypeError("Pi SDK agentDir must be an absolute path.");
  if (path.resolve(options.cwd) === path.resolve(options.agentDir)) {
    throw new TypeError("Pi SDK cwd and agentDir must be dedicated, distinct paths.");
  }
  return {
    async createSession(input) {
      const { cwd, agentDir } = options;
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: options.systemPrompt ?? "Use only the explicitly provided mc-aws tools.",
      });
      await resourceLoader.reload();

      const configuration = await options.resolveSessionConfiguration({
        providerProfileId: input.providerProfileId,
        model: input.model,
      });
      const customTools = input.tools.map((tool) =>
        defineTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: Unsafe<JsonObject>(tool.parameters),
          execute: async (toolCallId, arguments_, signal, onUpdate) =>
            tool.execute(toolCallId, arguments_, signal, onUpdate),
        })
      );
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model: configuration.model as CreateAgentSessionOptions["model"],
        modelRuntime: configuration.modelRuntime as CreateAgentSessionOptions["modelRuntime"],
        thinkingLevel: configuration.thinkingLevel,
        noTools: "builtin",
        tools: input.tools.map((tool) => tool.name),
        customTools,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      });

      return {
        subscribe(listener) {
          return session.subscribe((event) => listener(event as PiRuntimeEvent));
        },
        prompt(prompt) {
          return session.prompt(prompt, { expandPromptTemplates: false });
        },
        abort() {
          return session.abort();
        },
        dispose() {
          return session.dispose();
        },
      };
    },
  };
}

export class PiHarnessAdapter implements AgentHarnessAdapter {
  readonly adapterId = PI_ADAPTER_ID;
  readonly adapterVersion = PI_ADAPTER_VERSION;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly cancellationTimeoutMs: number;

  constructor(private readonly options: PiHarnessAdapterOptions) {
    validateToolBridges(options.tools);
    if (
      options.cancellationTimeoutMs !== undefined &&
      (!Number.isFinite(options.cancellationTimeoutMs) ||
        options.cancellationTimeoutMs <= 0 ||
        options.cancellationTimeoutMs > MAX_CANCELLATION_TIMEOUT_MS)
    ) {
      throw new TypeError("Pi harness cancellationTimeoutMs must be a positive finite number.");
    }
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.cancellationTimeoutMs =
      options.cancellationTimeoutMs ?? options.toolExecutor.reconciliationTimeoutMs ?? DEFAULT_CANCELLATION_TIMEOUT_MS;
  }

  async *run(input: HarnessRunInput): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue();
    type ActiveInvocation = {
      invocation: ToolInvocation;
      controller: AbortController;
      settled: Promise<void>;
      resolveSettled: () => void;
    };
    const activeInvocations = new Map<string, ActiveInvocation>();
    const cancelledInvocations = new Set<string>();
    const runController = new AbortController();
    let sequence = 0;
    let session: PiRuntimeSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    let indeterminate = false;
    let resourceLimited = false;
    let resourceLimitCleanup: Promise<void> = Promise.resolve();
    let settled = false;

    const redactData = (data: JsonObject): JsonObject => {
      const redacted = this.options.eventRedactor.redact(data);
      assertJsonValue(redacted, "redacted event data");
      if (redacted === null || Array.isArray(redacted) || typeof redacted !== "object") {
        throw new TypeError("The event redactor must return a JSON object.");
      }
      return redacted;
    };
    const event = (kind: AgentEvent["kind"], data: JsonObject): AgentEvent => {
      const nextSequence = sequence + 1;
      const timestamp = this.now().toISOString();
      const redactedData = redactData(data);
      const payload = { schemaVersion: AGENT_SCHEMA_VERSION, redacted: true, data: redactedData };
      if (serializedUtf8Bytes(payload) > MAX_AGENT_EVENT_PAYLOAD_BYTES) {
        throw new Error(PROVIDER_RESOURCE_LIMIT_CODE);
      }
      return agentSchemas.agentEvent.parse({
        schemaVersion: AGENT_SCHEMA_VERSION,
        eventId: this.createId(),
        sessionId: input.session.sessionId,
        sequence: nextSequence,
        timestamp,
        kind,
        payload,
        replayCursor: `${input.session.sessionId}:${nextSequence}`,
      });
    };

    const failForResourceLimit = (): void => {
      if (resourceLimited || cancelled || indeterminate) return;
      resourceLimited = true;
      runController.abort(new Error(PROVIDER_RESOURCE_LIMIT_CODE));
      const failure = event("error", {
        code: PROVIDER_RESOURCE_LIMIT_CODE,
        message: PROVIDER_RESOURCE_LIMIT_MESSAGE,
      });
      sequence = failure.sequence;
      queue.failClosed(failure);
      const cancellations: Array<Promise<unknown>> = [...activeInvocations.values()].map((active) =>
        cancelInvocation(active)
      );
      if (session) {
        cancellations.push(
          waitWithin(
            Promise.resolve().then(() => session?.abort()),
            this.cancellationTimeoutMs
          )
        );
      }
      resourceLimitCleanup = waitWithin(Promise.allSettled(cancellations), this.cancellationTimeoutMs);
    };

    const emit = (kind: AgentEvent["kind"], data: JsonObject): void => {
      if (resourceLimited && kind !== "tool-result") return;
      let next: AgentEvent;
      try {
        next = event(kind, data);
      } catch (error) {
        if (error instanceof Error && error.message === PROVIDER_RESOURCE_LIMIT_CODE) {
          failForResourceLimit();
          return;
        }
        throw error;
      }
      const result = queue.push(next);
      if (result === "overflow") {
        failForResourceLimit();
        return;
      }
      if (result === "accepted") sequence = next.sequence;
    };

    const cancelInvocation = async (active: ActiveInvocation): Promise<void> => {
      const { invocation, controller } = active;
      controller.abort();
      if (cancelledInvocations.has(invocation.invocationId)) return;
      cancelledInvocations.add(invocation.invocationId);
      await waitWithin(
        Promise.resolve().then(() =>
          this.options.toolExecutor.cancel({
            schemaVersion: AGENT_SCHEMA_VERSION,
            invocationId: invocation.invocationId,
            requestedAt: this.now().toISOString(),
            reason: CANCELLATION_REASON,
          })
        ),
        this.cancellationTimeoutMs
      );
    };

    const cancel = async (): Promise<void> => {
      if (cancelled) return;
      cancelled = true;
      queue.fenceForCancellation();
      emit("cancellation", { reason: CANCELLATION_REASON });
      runController.abort();
      const cancellations: Array<Promise<unknown>> = [...activeInvocations.values()].map(cancelInvocation);
      if (session) {
        cancellations.push(
          waitWithin(
            Promise.resolve().then(() => session?.abort()),
            this.cancellationTimeoutMs
          )
        );
      }
      await waitWithin(Promise.allSettled(cancellations), this.cancellationTimeoutMs);
    };

    const terminalizeIndeterminate = async (invocationId: string): Promise<void> => {
      indeterminate = true;
      runController.abort();
      const cancellations = [...activeInvocations.values()]
        .filter((active) => active.invocation.invocationId !== invocationId)
        .map(cancelInvocation);
      if (session) {
        cancellations.push(
          waitWithin(
            Promise.resolve().then(() => session?.abort()),
            this.cancellationTimeoutMs
          )
        );
      }
      await waitWithin(Promise.allSettled(cancellations), this.cancellationTimeoutMs);
    };

    const runtimeTools: PiRuntimeTool[] = this.options.tools.map((bridge) => ({
      name: bridge.name,
      label: bridge.definition.displayName,
      description: bridge.definition.description,
      parameters: bridge.definition.inputSchema,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Proposal publication, cancellation reconciliation, redaction, and terminal effect fencing share one Pi tool lifecycle.
      execute: async (_toolCallId, rawArguments, toolSignal, onUpdate) => {
        if (resourceLimited) throw new Error("Harness is fenced after a provider response limit.");
        if (indeterminate) throw new Error("Harness is fenced after an indeterminate tool effect.");
        if (activeInvocations.size > 0) throw new Error("Only one tool invocation may execute at a time.");
        let serializedArguments: string;
        try {
          serializedArguments = JSON.stringify(rawArguments) ?? "";
        } catch {
          serializedArguments = "";
        }
        if (Buffer.byteLength(serializedArguments) > MAX_PROVIDER_TOOL_ARGUMENT_BYTES) {
          failForResourceLimit();
          throw new Error("Tool arguments exceeded a local resource limit.");
        }
        const arguments_ = asJsonObject(rawArguments);
        const invocation = agentSchemas.toolInvocation.parse({
          schemaVersion: AGENT_SCHEMA_VERSION,
          invocationId: this.createId(),
          sessionId: input.session.sessionId,
          toolId: bridge.definition.toolId,
          capability: bridge.definition.capability,
          targetScope: bridge.resolveTargetScope(arguments_),
          arguments: arguments_,
          requestedAt: this.now().toISOString(),
        });
        const invocationController = new AbortController();
        let resolveSettled: (() => void) | undefined;
        const active: ActiveInvocation = {
          invocation,
          controller: invocationController,
          settled: new Promise<void>((resolve) => {
            resolveSettled = resolve;
          }),
          resolveSettled: () => resolveSettled?.(),
        };
        activeInvocations.set(invocation.invocationId, active);
        const onToolAbort = () => void cancelInvocation(active).catch(() => undefined);
        toolSignal?.addEventListener("abort", onToolAbort, { once: true });
        try {
          emit("tool-proposal", {
            invocationId: invocation.invocationId,
            toolId: invocation.toolId,
            capability: invocation.capability,
            targetScope: invocation.targetScope as unknown as JsonObject,
            arguments: invocation.arguments,
            requestedAt: invocation.requestedAt,
          });
          if (cancelled || toolSignal?.aborted) {
            await cancelInvocation(active);
          }
          const result = await invokeToolExecutor(
            this.options.toolExecutor,
            invocation,
            (progress: ToolProgress) => {
              if (invocationController.signal.aborted) return;
              const validatedProgress = agentSchemas.toolProgress.parse(progress);
              const progressData: JsonObject = {
                invocationId: validatedProgress.invocationId,
                sequence: validatedProgress.sequence,
                timestamp: validatedProgress.timestamp,
                message: validatedProgress.message,
              };
              if (validatedProgress.percent !== undefined) progressData.percent = validatedProgress.percent;
              emit("tool-progress", progressData);
              const redactedProgressData = redactData(progressData);
              onUpdate?.({
                content: [{ type: "text", text: String(redactedProgressData.message ?? REDACTION_MARKER) }],
                details: redactedProgressData,
              });
            },
            invocationController.signal,
            this.cancellationTimeoutMs,
            this.now
          );
          const redactedResult = agentSchemas.toolResult.parse(
            await boundToolResult(
              redactData((await boundToolResult(result)) as unknown as JsonObject) as unknown as ToolResult
            )
          );
          if (redactedResult.status === "indeterminate") {
            indeterminate = true;
            runController.abort();
          }
          emit("tool-result", {
            schemaVersion: redactedResult.schemaVersion,
            invocationId: redactedResult.invocationId,
            status: redactedResult.status,
            completedAt: redactedResult.completedAt,
            summary: redactedResult.summary,
            output: redactedResult.output,
            evidence: redactedResult.evidence as unknown as JsonValue,
            ...(redactedResult.mutationCommit
              ? { mutationCommit: redactedResult.mutationCommit as unknown as JsonObject }
              : {}),
          });
          if (redactedResult.status === "indeterminate") {
            emit("error", {
              code: "indeterminate-effect",
              message: "Tool effect completion is indeterminate; the run is fenced for reconciliation.",
              invocationId: redactedResult.invocationId,
            });
            await terminalizeIndeterminate(redactedResult.invocationId);
          }
          return toolResultForPi(redactedResult);
        } finally {
          toolSignal?.removeEventListener("abort", onToolAbort);
          active.resolveSettled();
          activeInvocations.delete(invocation.invocationId);
        }
      },
    }));

    const onAbort = () => void cancel();
    const onProviderResponseLimit = () => failForResourceLimit();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    this.options.providerResponseLimitSignal?.addEventListener("abort", onProviderResponseLimit, { once: true });
    if (this.options.providerResponseLimitSignal?.aborted) onProviderResponseLimit();

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Session creation, stream flushing, cancellation, and cleanup intentionally share one lifecycle.
    const execution = (async () => {
      try {
        if (input.signal?.aborted) await cancel();
        if (resourceLimited) return;
        const sessionCreation = this.options.runtime.createSession({
          sessionId: input.session.sessionId,
          providerProfileId: input.provider.profileId,
          model: input.provider.model,
          tools: runtimeTools,
        });
        const created = await completeBeforeCancellation(
          sessionCreation,
          runController.signal,
          this.cancellationTimeoutMs
        );
        if (created.cancelled) {
          void sessionCreation
            .then(async (lateSession) => {
              await waitWithin(
                Promise.resolve().then(() => lateSession.abort()),
                this.cancellationTimeoutMs
              );
              await waitWithin(
                Promise.resolve().then(() => lateSession.dispose()),
                this.cancellationTimeoutMs
              );
            })
            .catch(() => undefined);
          return;
        }
        session = created.value;
        unsubscribe = session.subscribe((event) => {
          if (event.type !== "message_update") return;
          const update = event.assistantMessageEvent;
          if (!isRecord(update) || typeof update.delta !== "string") return;
          if (update.type === "text_delta") {
            const delta =
              this.options.eventRedactor.redactStreamChunk?.(`model:${input.session.sessionId}`, update.delta) ??
              update.delta;
            if (delta) emit("model", { delta });
          }
        });
        if (resourceLimited) await resourceLimitCleanup;
        else if (cancelled) await waitWithin(session.abort(), this.cancellationTimeoutMs);
        else {
          await completeBeforeCancellation(
            session.prompt(input.prompt),
            runController.signal,
            this.cancellationTimeoutMs
          );
        }
        if (!cancelled && !indeterminate && !resourceLimited) {
          const remainder = this.options.eventRedactor.flushStream?.(`model:${input.session.sessionId}`) ?? "";
          if (remainder) emit("model", { delta: remainder });
          emit("completion", { status: "completed" });
        }
      } catch {
        if (!cancelled && !indeterminate && !resourceLimited) emit("error", { message: SAFE_ERROR_MESSAGE });
      } finally {
        settled = true;
        unsubscribe?.();
        try {
          await waitWithin(
            Promise.allSettled([...activeInvocations.values()].map((active) => active.settled)),
            Math.min(100, this.cancellationTimeoutMs)
          );
          if (session) {
            await waitWithin(
              Promise.resolve().then(() => session?.dispose()),
              this.cancellationTimeoutMs
            );
          }
          await resourceLimitCleanup;
        } finally {
          queue.end();
        }
      }
    })();

    try {
      yield* queue;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.options.providerResponseLimitSignal?.removeEventListener("abort", onProviderResponseLimit);
      if (!settled) await cancel();
      await execution;
    }
  }
}
