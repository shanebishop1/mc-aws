import type { AgentProviderAdapter } from "@/lib/agent/adapters";
import type { JsonObject, ProviderConfiguration } from "@/lib/agent/contracts";
import { AgentProviderError } from "@/lib/agent/providers/errors";

export class DeterministicFakeProviderAdapter implements AgentProviderAdapter {
  readonly providerId: string;
  private readonly chunks: readonly JsonObject[];

  constructor(chunks: readonly JsonObject[], providerId = "fake") {
    this.providerId = providerId;
    this.chunks = structuredClone(chunks);
  }

  async *stream(
    configuration: ProviderConfiguration,
    _request: JsonObject,
    signal?: AbortSignal
  ): AsyncIterable<JsonObject> {
    if (configuration.providerId !== this.providerId) {
      throw new AgentProviderError({
        code: "configuration",
        providerId: this.providerId,
        message: "Provider configuration does not match the selected adapter.",
      });
    }
    for (const chunk of this.chunks) {
      if (signal?.aborted) {
        throw new AgentProviderError({
          code: "cancelled",
          providerId: this.providerId,
          message: "Provider request was cancelled.",
        });
      }
      await Promise.resolve();
      yield structuredClone(chunk);
    }
  }
}
