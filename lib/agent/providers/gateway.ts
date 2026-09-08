import type { AgentProviderAdapter } from "@/lib/agent/adapters";
import type { JsonObject, ProviderConfiguration } from "@/lib/agent/contracts";
import { AgentProviderError } from "@/lib/agent/providers/errors";

export class AgentModelGateway implements AgentProviderAdapter {
  readonly providerId = "gateway";
  private readonly providers: ReadonlyMap<string, AgentProviderAdapter>;

  constructor(providers: readonly AgentProviderAdapter[]) {
    const entries = providers.map((provider) => [provider.providerId, provider] as const);
    if (new Set(entries.map(([providerId]) => providerId)).size !== entries.length) {
      throw new AgentProviderError({
        code: "configuration",
        providerId: this.providerId,
        message: "Provider IDs must be unique.",
      });
    }
    this.providers = new Map(entries);
  }

  stream(configuration: ProviderConfiguration, request: JsonObject, signal?: AbortSignal): AsyncIterable<JsonObject> {
    const provider = this.providers.get(configuration.providerId);
    if (!provider) {
      throw new AgentProviderError({
        code: "configuration",
        providerId: configuration.providerId,
        message: "Provider is not registered.",
      });
    }
    return provider.stream(configuration, request, signal);
  }
}
