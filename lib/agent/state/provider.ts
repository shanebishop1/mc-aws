import { InMemoryAgentStateRepository } from "@/lib/agent/state/in-memory-repository";
import { RepositoryAgentSessionStore } from "@/lib/agent/state/store";

const localRepository = new InMemoryAgentStateRepository();
const localStore = new RepositoryAgentSessionStore(localRepository);

export function resetMockAgentState(): void | Promise<void> {
  localRepository.clear();
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const backendMode = process.env.MC_BACKEND_MODE?.trim().toLowerCase();
  if (backendMode === "mock" && nodeEnv !== "test" && nodeEnv !== "production") {
    return import("@/lib/agent/state/mock-repository").then(({ resetPersistedMockAgentState }) =>
      resetPersistedMockAgentState()
    );
  }
}

export async function getAgentSessionStore(): Promise<RepositoryAgentSessionStore> {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const backendMode = process.env.MC_BACKEND_MODE?.trim().toLowerCase();
  if (nodeEnv === "test") return localStore;
  if (backendMode === "mock" && nodeEnv !== "production") {
    const { MockAgentStateRepository } = await import("@/lib/agent/state/mock-repository");
    return new RepositoryAgentSessionStore(new MockAgentStateRepository());
  }
  if (nodeEnv !== "production") return localStore;

  try {
    const [
      { getCloudflareContext },
      { AgentStateConfigurationError, CloudflareAgentStateRepository, isDurableObjectNamespace },
    ] = await Promise.all([import("@opennextjs/cloudflare"), import("@/lib/agent/state/cloudflare-repository")]);
    const context = await getCloudflareContext({ async: true });
    const environment = context.env as Record<string, unknown>;
    const legacyBinding = environment.AGENT_SESSION_DURABLE_OBJECT;
    const indexBinding = environment.AGENT_SESSION_INDEX_DURABLE_OBJECT;
    const shardBinding = environment.AGENT_SESSION_SHARD_DURABLE_OBJECT;
    if (
      !isDurableObjectNamespace(legacyBinding) ||
      !isDurableObjectNamespace(indexBinding) ||
      !isDurableObjectNamespace(shardBinding)
    ) {
      throw new AgentStateConfigurationError();
    }
    return new RepositoryAgentSessionStore(
      new CloudflareAgentStateRepository(legacyBinding, indexBinding, shardBinding)
    );
  } catch {
    const { AgentStateConfigurationError } = await import("@/lib/agent/state/cloudflare-repository");
    throw new AgentStateConfigurationError();
  }
}
