import { OpenAiCompatibleProviderAdapter } from "@/lib/agent/providers/openai-compatible";
import type { ProviderEndpointOptions, ProviderRuntimeDependencies } from "@/lib/agent/providers/types";

export class OpenRouterProviderAdapter extends OpenAiCompatibleProviderAdapter {
  constructor(dependencies: ProviderRuntimeDependencies, options: Partial<ProviderEndpointOptions> = {}) {
    super(
      "openrouter",
      {
        endpoint: "https://openrouter.ai/api/v1",
        ...options,
      },
      dependencies
    );
  }
}
