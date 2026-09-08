export type AgentProviderErrorCode =
  | "configuration"
  | "credentials"
  | "security"
  | "timeout"
  | "cancelled"
  | "network"
  | "http"
  | "malformed-response";

export class AgentProviderError extends Error {
  readonly code: AgentProviderErrorCode;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(options: {
    code: AgentProviderErrorCode;
    providerId: string;
    message: string;
    retryable?: boolean;
    status?: number;
  }) {
    super(options.message);
    this.name = "AgentProviderError";
    this.code = options.code;
    this.providerId = options.providerId;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
