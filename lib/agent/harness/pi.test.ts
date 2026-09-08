import type { AgentToolExecutorAdapter } from "@/lib/agent/adapters";
import { AGENT_SCHEMA_VERSION, type ToolInvocation, type ToolProgress, type ToolResult } from "@/lib/agent/contracts";
import { canonicalAgentFixtures } from "@/lib/agent/fixtures";
import {
  PiHarnessAdapter,
  type PiRuntime,
  type PiRuntimeEvent,
  type PiRuntimeSession,
  type PiRuntimeTool,
  createPiSdkRuntime,
  createSecretAwareEventRedactor,
} from "@/lib/agent/harness/pi";
import {
  MAX_PI_QUEUED_EVENTS,
  MAX_PI_QUEUED_EVENT_BYTES,
  MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
} from "@/lib/agent/response-limits";
import { describe, expect, it, vi } from "vitest";

const piSdkMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  resourceLoaderOptions: vi.fn(),
  reload: vi.fn(async () => undefined),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      piSdkMocks.resourceLoaderOptions(options);
    }
    reload = piSdkMocks.reload;
  },
  SessionManager: { inMemory: vi.fn(() => ({ kind: "session-manager" })) },
  SettingsManager: { inMemory: vi.fn(() => ({ kind: "settings-manager" })) },
  createAgentSession: piSdkMocks.createAgentSession,
  defineTool: vi.fn((definition: unknown) => definition),
}));

function createIds(): () => string {
  let next = 0;
  return () => `generated-${++next}`;
}

function createSession(overrides: Partial<PiRuntimeSession> = {}): PiRuntimeSession {
  return {
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
    ...overrides,
  };
}

function createAdapter(runtime: PiRuntime, toolExecutor: AgentToolExecutorAdapter): PiHarnessAdapter {
  return new PiHarnessAdapter({
    runtime,
    toolExecutor,
    tools: [
      {
        name: "workspace_patch",
        definition: canonicalAgentFixtures.toolDefinition,
        resolveTargetScope: () => canonicalAgentFixtures.targetScope,
      },
    ],
    eventRedactor: createSecretAwareEventRedactor({ exactSecrets: ["configured-exact-secret"] }),
    cancellationTimeoutMs: 10,
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    createId: createIds(),
  });
}

async function collect(adapter: PiHarnessAdapter, signal?: AbortSignal) {
  const events = [];
  for await (const event of adapter.run({
    session: canonicalAgentFixtures.agentSession,
    provider: canonicalAgentFixtures.providerConfiguration,
    prompt: "Update the MOTD.",
    signal,
  })) {
    events.push(event);
  }
  return events;
}

describe("PiHarnessAdapter", () => {
  it("translates Pi deltas and routes the only exposed custom tool through the executor", async () => {
    let listener: ((event: PiRuntimeEvent) => void) | undefined;
    let exposedTools: PiRuntimeTool[] = [];
    let piToolResult: Awaited<ReturnType<PiRuntimeTool["execute"]>> | undefined;
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(
        async (invocation: ToolInvocation, onProgress: (progress: ToolProgress) => void): Promise<ToolResult> => {
          onProgress({
            schemaVersion: AGENT_SCHEMA_VERSION,
            invocationId: invocation.invocationId,
            sequence: 1,
            timestamp: "2026-09-02T12:00:00.000Z",
            message: "Applying patch",
            percent: 50,
          });
          return {
            ...canonicalAgentFixtures.toolResult,
            invocationId: invocation.invocationId,
          };
        }
      ),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        exposedTools = input.tools;
        return createSession({
          subscribe: (nextListener) => {
            listener = nextListener;
            return unsubscribe;
          },
          prompt: async () => {
            listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } });
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", delta: "Checked policy" },
            });
            piToolResult = await exposedTools[0].execute("pi-call-1", {
              path: "config/server.properties",
              patch: "motd=Welcome",
            });
          },
          dispose,
        });
      }),
    };

    const events = await collect(createAdapter(runtime, executor));

    expect(exposedTools.map((tool) => tool.name)).toEqual(["workspace_patch"]);
    expect(events.map((event) => event.kind)).toEqual([
      "model",
      "tool-proposal",
      "tool-progress",
      "tool-result",
      "completion",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events[1].payload.data).toMatchObject({
      toolId: "workspace.patch",
      capability: "workspace.write",
      arguments: { path: "config/server.properties", patch: "motd=Welcome" },
    });
    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        toolId: "workspace.patch",
        capability: "workspace.write",
      }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(piToolResult).toEqual({
      content: [{ type: "text", text: "Updated one configuration property." }],
      details: { status: "succeeded", output: { changed: true } },
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("redacts model, write, progress, summary, output, and evidence content before exposure", async () => {
    let listener: ((event: PiRuntimeEvent) => void) | undefined;
    let exposedTool: PiRuntimeTool | undefined;
    let piToolResult: Awaited<ReturnType<PiRuntimeTool["execute"]>> | undefined;
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(
        async (invocation: ToolInvocation, onProgress: (progress: ToolProgress) => void): Promise<ToolResult> => {
          onProgress({
            schemaVersion: AGENT_SCHEMA_VERSION,
            invocationId: invocation.invocationId,
            sequence: 1,
            timestamp: "2026-09-02T12:00:00.000Z",
            message: "Command said Bearer reflected-credential",
          });
          return {
            schemaVersion: AGENT_SCHEMA_VERSION,
            invocationId: invocation.invocationId,
            status: "succeeded",
            completedAt: "2026-09-02T12:00:00.000Z",
            summary: "Wrote configured-exact-secret",
            output: { stdout: "api_abcdefghijklmnop", token: "must-be-removed" },
            evidence: [
              {
                ...canonicalAgentFixtures.evidenceReference,
                description: "Contains configured-exact-secret",
              },
            ],
          };
        }
      ),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => undefined;
          },
          prompt: async () => {
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "configured-exact-secret" },
            });
            piToolResult = await exposedTool?.execute("pi-call-1", {
              path: "config/server.properties",
              patch: "motd=configured-exact-secret",
            });
          },
        });
      }),
    };

    const events = await collect(createAdapter(runtime, executor));
    const serializedExposure = JSON.stringify({ events, piToolResult });

    expect(serializedExposure).not.toContain("configured-exact-secret");
    expect(serializedExposure).not.toContain("reflected-credential");
    expect(serializedExposure).not.toContain("api_abcdefghijklmnop");
    expect(serializedExposure).not.toContain("must-be-removed");
    expect(events.every((event) => event.payload.redacted)).toBe(true);
    expect(piToolResult).toMatchObject({
      content: [{ text: "Wrote [REDACTED]" }],
      details: { output: { stdout: "[REDACTED]" } },
    });
  });

  it("rejects credential-shaped tool arguments before emitting a proposal", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          prompt: async () => {
            await exposedTool?.execute("pi-call-1", {
              path: "config/server.properties",
              token: "must-not-be-emitted",
            });
          },
        });
      }),
    };

    const events = await collect(createAdapter(runtime, executor));

    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ data: { message: "Pi harness execution failed." } }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("must-not-be-emitted");
    expect(executor.invoke).not.toHaveBeenCalled();
  });

  it("cancels active executor work, aborts Pi, and disposes the session", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    let resolveInvocation: ((result: ToolResult) => void) | undefined;
    let markInvocationStarted: (() => void) | undefined;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    const abort = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const unsubscribe = vi.fn();
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(async (_invocation: ToolInvocation) => {
        markInvocationStarted?.();
        return new Promise<ToolResult>((resolve) => {
          resolveInvocation = resolve;
        });
      }),
      cancel: vi.fn(async (cancellation) => {
        resolveInvocation?.({
          schemaVersion: AGENT_SCHEMA_VERSION,
          invocationId: cancellation.invocationId,
          status: "cancelled",
          completedAt: "2026-09-02T12:00:00.000Z",
          summary: "Cancelled.",
          output: null,
          evidence: [],
        });
      }),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          subscribe: () => unsubscribe,
          prompt: async () => {
            await exposedTool?.execute("pi-call-1", { path: "config/server.properties", patch: "motd=Stop" });
          },
          abort,
          dispose,
        });
      }),
    };
    const controller = new AbortController();
    const eventsPromise = collect(createAdapter(runtime, executor), controller.signal);

    await invocationStarted;
    controller.abort();
    const events = await eventsPromise;

    expect(events.map((event) => event.kind)).toEqual(["tool-proposal", "cancellation", "tool-result"]);
    expect(executor.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Agent run cancelled.", invocationId: expect.any(String) })
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("coerces a late uncommitted executor success after cancellation to cancelled", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    let resolveInvocation: ((result: ToolResult) => void) | undefined;
    let markInvocationStarted: (() => void) | undefined;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(async (_invocation: ToolInvocation, _onProgress, signal) => {
        markInvocationStarted?.();
        expect(signal).toBeInstanceOf(AbortSignal);
        return new Promise<ToolResult>((resolve) => {
          resolveInvocation = resolve;
        });
      }),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          prompt: async () => {
            await exposedTool?.execute("pi-call-1", { path: "config/server.properties", patch: "motd=Stop" });
          },
        });
      }),
    };
    const controller = new AbortController();
    const eventsPromise = collect(createAdapter(runtime, executor), controller.signal);

    await invocationStarted;
    controller.abort();
    resolveInvocation?.({
      ...canonicalAgentFixtures.toolResult,
      invocationId: "generated-1",
      status: "succeeded",
    });
    const events = await eventsPromise;

    expect(events.find((event) => event.kind === "tool-result")?.payload.data.status).toBe("cancelled");
  });

  it("preserves a committed executor success when cancellation races after the mutation commit", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    let resolveInvocation: ((result: ToolResult) => void) | undefined;
    let markInvocationStarted: (() => void) | undefined;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    let piResult: Awaited<ReturnType<PiRuntimeTool["execute"]>> | undefined;
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(async () => {
        markInvocationStarted?.();
        return new Promise<ToolResult>((resolve) => {
          resolveInvocation = resolve;
        });
      }),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          prompt: async () => {
            piResult = await exposedTool?.execute("pi-call-1", {
              path: "config/server.properties",
              patch: "motd=Committed",
            });
          },
        });
      }),
    };
    const controller = new AbortController();
    const eventsPromise = collect(createAdapter(runtime, executor), controller.signal);

    await invocationStarted;
    controller.abort();
    resolveInvocation?.({
      ...canonicalAgentFixtures.toolResult,
      invocationId: "generated-1",
      status: "succeeded",
      mutationCommit: { committed: true, point: "atomic-rename" },
    });
    const events = await eventsPromise;

    expect(events.find((event) => event.kind === "tool-result")?.payload.data).toMatchObject({
      status: "succeeded",
      mutationCommit: { committed: true, point: "atomic-rename" },
    });
    expect(piResult?.details).toMatchObject({
      status: "succeeded",
      mutationCommit: { committed: true, point: "atomic-rename" },
    });
  });

  it("bounds cancellation when the executor ignores abort and never settles", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    let markInvocationStarted: (() => void) | undefined;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(async () => {
        markInvocationStarted?.();
        return new Promise<ToolResult>(() => undefined);
      }),
      cancel: vi.fn(async () => new Promise<void>(() => undefined)),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          prompt: async () => {
            await exposedTool?.execute("pi-call-1", { path: "config/server.properties", patch: "motd=Stop" });
          },
          abort: async () => new Promise<void>(() => undefined),
          dispose: async () => new Promise<void>(() => undefined),
        });
      }),
    };
    const controller = new AbortController();
    const eventsPromise = collect(createAdapter(runtime, executor), controller.signal);

    await invocationStarted;
    controller.abort();
    const events = await Promise.race([
      eventsPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancellation hung")), 250)),
    ]);

    expect(events.find((event) => event.kind === "tool-result")?.payload.data.status).toBe("indeterminate");
    expect(events.map((event) => event.kind)).not.toContain("error");
  });

  it("fences Pi from creating another invocation after an indeterminate effect", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(
        async (invocation): Promise<ToolResult> => ({
          schemaVersion: 1,
          invocationId: invocation.invocationId,
          status: "indeterminate",
          completedAt: "2026-09-02T12:00:00.000Z",
          summary: "Effect outcome is unknown.",
          output: { code: "indeterminate-effect" },
          evidence: [],
        })
      ),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          prompt: async () => {
            await exposedTool?.execute("pi-call-1", {
              path: "config/server.properties",
              patch: "motd=Unknown",
            });
            await expect(
              exposedTool?.execute("pi-call-2", {
                path: "config/server.properties",
                patch: "motd=Must not run",
              })
            ).rejects.toThrow(/fenced/);
          },
        });
      }),
    };

    const events = await collect(createAdapter(runtime, executor));

    expect(executor.invoke).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.kind)).toEqual(["tool-proposal", "tool-result", "error"]);
  });

  it("fails closed with a bounded queue when publication is slow and fences every later tool", async () => {
    let listener: ((event: PiRuntimeEvent) => void) | undefined;
    let exposedTool: PiRuntimeTool | undefined;
    let produced: (() => void) | undefined;
    const productionFinished = new Promise<void>((resolve) => {
      produced = resolve;
    });
    const abort = vi.fn(async () => undefined);
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => undefined;
          },
          prompt: async () => {
            for (let index = 0; index < MAX_PI_QUEUED_EVENTS + 8; index++) {
              listener?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: `safe-${index}` },
              });
            }
            await expect(exposedTool?.execute("after-overflow", { path: "server.properties" })).rejects.toThrow(
              /fenced/
            );
            produced?.();
          },
          abort,
        });
      }),
    };
    const adapter = createAdapter(runtime, executor);
    const iterator = adapter
      .run({
        session: canonicalAgentFixtures.agentSession,
        provider: canonicalAgentFixtures.providerConfiguration,
        prompt: "Flood while publication is blocked.",
      })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await productionFinished;
    const events = [(await first).value];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(["model", "error"]);
    expect(events[1].payload.data).toEqual({
      code: "provider-response-limit",
      message: "Provider response exceeded a local resource limit; the run was cancelled.",
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(executor.invoke).not.toHaveBeenCalled();
  });

  it("rejects one event larger than the queue byte ceiling before retaining it", async () => {
    let listener: ((event: PiRuntimeEvent) => void) | undefined;
    const abort = vi.fn(async () => undefined);
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async () =>
        createSession({
          subscribe: (nextListener) => {
            listener = nextListener;
            return () => undefined;
          },
          prompt: async () => {
            listener?.({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "x".repeat(MAX_PI_QUEUED_EVENT_BYTES) },
            });
          },
          abort,
        })
      ),
    };

    const events = await collect(createAdapter(runtime, executor));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "error",
      payload: { data: { code: "provider-response-limit" } },
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(executor.invoke).not.toHaveBeenCalled();
  });

  it("audits oversized finalized tool arguments and invokes zero executor tools", async () => {
    let exposedTool: PiRuntimeTool | undefined;
    const executor: AgentToolExecutorAdapter = {
      invoke: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const runtime: PiRuntime = {
      createSession: vi.fn(async (input) => {
        [exposedTool] = input.tools;
        return createSession({
          prompt: async () => {
            await exposedTool?.execute("oversized-arguments", {
              path: "server.properties",
              content: "x".repeat(MAX_PROVIDER_TOOL_ARGUMENT_BYTES),
            });
          },
        });
      }),
    };

    const events = await collect(createAdapter(runtime, executor));
    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ data: expect.objectContaining({ code: "provider-response-limit" }) }),
      }),
    ]);
    expect(executor.invoke).not.toHaveBeenCalled();
  });
});

describe("createPiSdkRuntime", () => {
  it("requires absolute, distinct cwd and agentDir paths", () => {
    const resolveSessionConfiguration = vi.fn(() => ({ model: {}, modelRuntime: {} }));

    expect(() => createPiSdkRuntime({ cwd: "relative", agentDir: "/agent", resolveSessionConfiguration })).toThrow(
      /absolute/
    );
    expect(() => createPiSdkRuntime({ cwd: "/workspace", agentDir: "relative", resolveSessionConfiguration })).toThrow(
      /absolute/
    );
    expect(() =>
      createPiSdkRuntime({ cwd: "/workspace", agentDir: "/workspace", resolveSessionConfiguration })
    ).toThrow(/distinct/);
  });

  it("disables built-ins and resource discovery while exposing only supplied custom tools", async () => {
    piSdkMocks.createAgentSession.mockResolvedValue({ session: createSession() });
    const runtime = createPiSdkRuntime({
      cwd: "/dedicated/workspace",
      agentDir: "/dedicated/agent-config",
      resolveSessionConfiguration: () => ({ model: { id: "mock" }, modelRuntime: { kind: "mock" } }),
    });
    const tool: PiRuntimeTool = {
      name: "workspace_patch",
      label: "Patch",
      description: "Patch a file",
      parameters: { type: "object" },
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };

    await runtime.createSession({
      sessionId: "session-1",
      providerProfileId: "profile-1",
      model: "mock-model",
      tools: [tool],
    });

    expect(piSdkMocks.resourceLoaderOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/dedicated/workspace",
        agentDir: "/dedicated/agent-config",
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      })
    );
    expect(piSdkMocks.reload).toHaveBeenCalledOnce();
    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/dedicated/workspace",
        agentDir: "/dedicated/agent-config",
        noTools: "builtin",
        tools: ["workspace_patch"],
        customTools: [expect.objectContaining({ name: "workspace_patch" })],
      })
    );
  });
});
