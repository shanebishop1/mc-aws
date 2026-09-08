import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCloudflareContext: vi.fn(), cloudflareModuleLoaded: vi.fn() }));

vi.mock("@opennextjs/cloudflare", () => {
  mocks.cloudflareModuleLoaded();
  return { getCloudflareContext: mocks.getCloudflareContext };
});

import { AgentStateConfigurationError } from "@/lib/agent/state/cloudflare-repository";
import { getAgentSessionStore } from "@/lib/agent/state/provider";

describe("agent state provider selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses deterministic local state outside production without probing Cloudflare", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    const first = await getAgentSessionStore();
    const second = await getAgentSessionStore();
    expect(first).toBe(second);
    expect(mocks.getCloudflareContext).not.toHaveBeenCalled();
  });

  it("selects shared mock state without probing cloud bindings", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_BACKEND_MODE", "mock");

    await expect(getAgentSessionStore()).resolves.toBeDefined();

    expect(mocks.cloudflareModuleLoaded).not.toHaveBeenCalled();
    expect(mocks.getCloudflareContext).not.toHaveBeenCalled();
  });

  it("fails closed in production when the binding is absent or malformed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    mocks.getCloudflareContext.mockResolvedValue({ env: {} });
    await expect(getAgentSessionStore()).rejects.toBeInstanceOf(AgentStateConfigurationError);
    mocks.getCloudflareContext.mockRejectedValueOnce(new Error("context unavailable"));
    await expect(getAgentSessionStore()).rejects.toBeInstanceOf(AgentStateConfigurationError);
  });

  it("selects the bound Durable Object repository in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    const fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/index/migration-state") {
        return Promise.resolve(
          Response.json({
            ok: true,
            migration: {
              schemaVersion: 1,
              sourceEpoch: 2,
              scanEpoch: 1,
              cursor: 0,
              complete: true,
              nextRescanAt: "2099-01-01T00:00:00.000Z",
            },
          })
        );
      }
      if (path === "/index/list") return Promise.resolve(Response.json({ ok: true, summaries: [] }));
      return Promise.resolve(Response.json({ ok: true }));
    });
    const idFromName = vi.fn((name: string) => name);
    const namespace = { idFromName, get: vi.fn().mockReturnValue({ fetch }) };
    mocks.getCloudflareContext.mockResolvedValue({
      env: {
        AGENT_SESSION_DURABLE_OBJECT: namespace,
        AGENT_SESSION_INDEX_DURABLE_OBJECT: namespace,
        AGENT_SESSION_SHARD_DURABLE_OBJECT: namespace,
      },
    });

    const store = await getAgentSessionStore();
    expect(await store.listSessions()).toEqual([]);
    expect(idFromName).toHaveBeenCalledWith("mc-aws-agent-control-plane-v1");
    expect(idFromName).toHaveBeenCalledWith("mc-aws-agent-session-index-v2");
    expect(fetch).toHaveBeenCalledWith(
      "https://agent-session.internal/index/list",
      expect.objectContaining({ method: "POST" })
    );
  });
});
