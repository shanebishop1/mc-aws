export const productionRuntimeStateBindingErrorMessage =
  "[RUNTIME-STATE] Missing or invalid Cloudflare runtime-state binding in production. Ensure RUNTIME_STATE_DURABLE_OBJECT is configured; production cannot fall back to in-memory runtime-state.";

export class RuntimeStateConfigurationError extends Error {
  readonly code = "RUNTIME_STATE_CONFIGURATION_ERROR";

  constructor(message = productionRuntimeStateBindingErrorMessage) {
    super(message);
    this.name = "RuntimeStateConfigurationError";
  }
}
