import type { JsonObject } from "@/lib/agent/contracts";

export interface AgentSecretResolver {
  resolve(credentialRef: string): Promise<string>;
}

export type AgentDnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface PinnedProviderFetchRequest {
  /** Keep the validated hostname in this URL for the HTTP Host header and TLS SNI. */
  readonly url: URL;
  /** The transport must connect only to one of these validated addresses and must not resolve the hostname again. */
  readonly validatedAddresses: readonly [string, ...string[]];
  readonly init: RequestInit;
}

/** A security-aware transport that pins each request to its validation-time DNS result. */
export type PinnedProviderFetch = (request: PinnedProviderFetchRequest) => Promise<Response>;

export interface ValidatedProviderEndpoint {
  readonly url: URL;
  readonly addresses: readonly [string, ...string[]];
}

export type ProviderStreamEvent =
  | { type: "content-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-delta"; toolCalls: JsonObject[] }
  | { type: "usage"; usage: JsonObject }
  | { type: "completion"; finishReason: string | null };

export interface ProviderRuntimeDependencies {
  pinnedFetch: PinnedProviderFetch;
  resolveDns: AgentDnsResolver;
  secretResolver: AgentSecretResolver;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ProviderEndpointOptions {
  endpoint: string;
  /** Never enable this for an operator-configured or production provider. */
  testOnlyAllowLocalhost?: boolean;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}
