import type { AgentProviderAdapter } from "@/lib/agent/adapters";
import type { JsonObject, ProviderConfiguration } from "@/lib/agent/contracts";
import { validateProviderEndpoint } from "@/lib/agent/providers/endpoint-security";
import { AgentProviderError } from "@/lib/agent/providers/errors";
import type {
  ProviderEndpointOptions,
  ProviderRuntimeDependencies,
  ProviderStreamEvent,
} from "@/lib/agent/providers/types";
import { StreamingSecretRedactor } from "@/lib/agent/redaction";

const RETRYABLE_STATUSES = new Set([408, 429]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_PROVIDER_TIMEOUT_MS = 300_000;
const MAX_SSE_FRAME_BYTES = 1_048_576;
const MAX_SSE_BUFFER_BYTES = MAX_SSE_FRAME_BYTES + 65_536;
const MAX_NORMALIZED_EVENT_BYTES = 262_144;
const MAX_NORMALIZED_STREAM_BYTES = 1_048_576;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  return Object.values(value).every((child) => {
    if (child === null || typeof child === "string" || typeof child === "boolean") return true;
    if (typeof child === "number") return Number.isFinite(child);
    if (Array.isArray(child))
      return child.every((item) => item === null || typeof item !== "undefined") && isJsonValue(child);
    return isJsonObject(child);
  });
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function redactCredential(value: JsonObject, credential: string): JsonObject {
  const redact = (item: JsonObject[string]): JsonObject[string] => {
    if (typeof item === "string") return item.includes(credential) ? item.split(credential).join("[REDACTED]") : item;
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, redact(child)]));
    }
    return item;
  };
  return redact(value) as JsonObject;
}

function abortError(providerId: string, timedOut: boolean): AgentProviderError {
  return new AgentProviderError({
    code: timedOut ? "timeout" : "cancelled",
    providerId,
    message: timedOut ? "Provider request timed out." : "Provider request was cancelled.",
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function responseLimitError(providerId: string, message: string): AgentProviderError {
  return new AgentProviderError({ code: "malformed-response", providerId, message });
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // Cleanup failures must not replace the sanitized provider error.
  }
}

function hasEventStreamContentType(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

function retryDelay(response: Response, fallback: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), 30_000);
  const dateDelay = Date.parse(value) - Date.now();
  return Number.isFinite(dateDelay) ? Math.min(Math.max(dateDelay, 0), 30_000) : fallback;
}

// Provider chunks have several independently optional fields; keeping their validation together prevents partial trust.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit validation is intentional at this trust boundary
function normalizedEvents(payload: unknown, providerId: string): ProviderStreamEvent[] {
  if (!isRecord(payload)) {
    throw new AgentProviderError({
      code: "malformed-response",
      providerId,
      message: "Provider returned a malformed stream payload.",
    });
  }
  if ("error" in payload || payload.type === "error") {
    throw new AgentProviderError({
      code: "http",
      providerId,
      message: "Provider reported an error while streaming.",
    });
  }

  const events: ProviderStreamEvent[] = [];
  if (payload.usage !== undefined) {
    if (!isJsonObject(payload.usage)) {
      throw new AgentProviderError({
        code: "malformed-response",
        providerId,
        message: "Provider returned malformed usage data.",
      });
    }
    events.push({ type: "usage", usage: payload.usage });
  }
  if (payload.choices === undefined && events.length > 0) return events;
  if (!Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
    throw new AgentProviderError({
      code: "malformed-response",
      providerId,
      message: "Provider returned a malformed completion chunk.",
    });
  }
  const choice = payload.choices[0];
  if (!isRecord(choice.delta)) {
    throw new AgentProviderError({
      code: "malformed-response",
      providerId,
      message: "Provider returned a malformed completion delta.",
    });
  }
  if (choice.delta.content !== undefined) {
    if (choice.delta.content !== null && typeof choice.delta.content !== "string") {
      throw new AgentProviderError({
        code: "malformed-response",
        providerId,
        message: "Provider returned non-text completion content.",
      });
    }
    if (typeof choice.delta.content === "string" && choice.delta.content) {
      events.push({ type: "content-delta", delta: choice.delta.content });
    }
  }
  const reasoning = choice.delta.reasoning ?? choice.delta.reasoning_content;
  if (reasoning !== undefined) {
    if (reasoning !== null && typeof reasoning !== "string") {
      throw new AgentProviderError({
        code: "malformed-response",
        providerId,
        message: "Provider returned malformed reasoning content.",
      });
    }
    if (typeof reasoning === "string" && reasoning) events.push({ type: "reasoning-delta", delta: reasoning });
  }
  if (choice.delta.tool_calls !== undefined) {
    if (!Array.isArray(choice.delta.tool_calls) || !choice.delta.tool_calls.every(isJsonObject)) {
      throw new AgentProviderError({
        code: "malformed-response",
        providerId,
        message: "Provider returned malformed tool call data.",
      });
    }
    events.push({ type: "tool-call-delta", toolCalls: choice.delta.tool_calls });
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
    throw new AgentProviderError({
      code: "malformed-response",
      providerId,
      message: "Provider returned a malformed finish reason.",
    });
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    events.push({ type: "completion", finishReason: (choice.finish_reason as string | null) ?? null });
  }
  return events;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: incremental SSE framing is intentionally linear and fail-closed
async function* readServerSentEvents(
  response: Response,
  providerId: string,
  signal: AbortSignal
): AsyncGenerator<JsonObject> {
  if (!response.body) {
    throw new AgentProviderError({
      code: "malformed-response",
      providerId,
      message: "Provider returned an empty stream.",
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (value && byteLength(buffer) + value.byteLength > MAX_SSE_BUFFER_BYTES) {
        throw responseLimitError(providerId, "Provider exceeded the streaming buffer limit.");
      }
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        if (byteLength(block) > MAX_SSE_FRAME_BYTES) {
          throw responseLimitError(providerId, "Provider returned an oversized streaming frame.");
        }
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "[DONE]") return;
        if (data) {
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            throw new AgentProviderError({
              code: "malformed-response",
              providerId,
              message: "Provider returned invalid streaming JSON.",
            });
          }
          if (!isJsonObject(payload)) {
            throw new AgentProviderError({
              code: "malformed-response",
              providerId,
              message: "Provider returned a non-JSON stream payload.",
            });
          }
          yield payload;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
        throw responseLimitError(providerId, "Provider exceeded the streaming buffer limit.");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      throw new AgentProviderError({
        code: "malformed-response",
        providerId,
        message: "Provider stream ended with an incomplete event.",
      });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original sanitized stream error when cancellation itself fails.
    }
    reader.releaseLock();
  }
}

export class OpenAiCompatibleProviderAdapter implements AgentProviderAdapter {
  readonly providerId: string;
  private readonly dependencies: ProviderRuntimeDependencies;
  private readonly options: Required<Pick<ProviderEndpointOptions, "maxAttempts" | "retryBaseDelayMs">> &
    Omit<ProviderEndpointOptions, "maxAttempts" | "retryBaseDelayMs">;

  constructor(providerId: string, options: ProviderEndpointOptions, dependencies: ProviderRuntimeDependencies) {
    this.providerId = providerId;
    this.dependencies = dependencies;
    this.options = {
      ...options,
      maxAttempts: options.maxAttempts ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 250,
    };
    if (!Number.isInteger(this.options.maxAttempts) || this.options.maxAttempts < 1 || this.options.maxAttempts > 5) {
      throw new AgentProviderError({
        code: "configuration",
        providerId,
        message: "Provider maxAttempts must be between 1 and 5.",
      });
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one generator owns cleanup and error normalization lifecycle
  async *stream(
    configuration: ProviderConfiguration,
    request: JsonObject,
    signal?: AbortSignal
  ): AsyncIterable<JsonObject> {
    if (configuration.providerId !== this.providerId) {
      throw new AgentProviderError({
        code: "configuration",
        providerId: this.providerId,
        message: "Provider configuration does not match the selected adapter.",
      });
    }
    if (
      !Number.isInteger(configuration.timeoutMs) ||
      configuration.timeoutMs < 1 ||
      configuration.timeoutMs > MAX_PROVIDER_TIMEOUT_MS
    ) {
      throw new AgentProviderError({
        code: "configuration",
        providerId: this.providerId,
        message: `Provider timeoutMs must be between 1 and ${MAX_PROVIDER_TIMEOUT_MS}.`,
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, configuration.timeoutMs);

    try {
      if (controller.signal.aborted) throw abortError(this.providerId, timedOut);
      const validatedBase = await raceWithAbort(
        validateProviderEndpoint(this.options.endpoint, this.dependencies.resolveDns, {
          providerId: this.providerId,
          testOnlyAllowLocalhost: this.options.testOnlyAllowLocalhost,
        }),
        controller.signal
      );
      const base = validatedBase.url;
      let credential: string;
      try {
        credential = await raceWithAbort(
          this.dependencies.secretResolver.resolve(configuration.credentialRef),
          controller.signal
        );
      } catch {
        if (controller.signal.aborted) throw abortError(this.providerId, timedOut);
        throw new AgentProviderError({
          code: "credentials",
          providerId: this.providerId,
          message: "Provider credential could not be resolved.",
        });
      }
      if (!credential) {
        throw new AgentProviderError({
          code: "credentials",
          providerId: this.providerId,
          message: "Provider credential could not be resolved.",
        });
      }

      const endpoint = base.pathname.endsWith("/chat/completions")
        ? base
        : new URL(`${base.pathname.replace(/\/$/, "")}/chat/completions${base.search}`, base.origin);
      let response: Response | undefined;
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        if (controller.signal.aborted) throw abortError(this.providerId, timedOut);
        response = await this.fetchWithSafeRedirects(endpoint, credential, configuration, request, controller.signal);
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.options.maxAttempts) break;
        await cancelResponseBody(response);
        const delay = retryDelay(response, this.options.retryBaseDelayMs * 2 ** (attempt - 1));
        try {
          await (this.dependencies.sleep ?? defaultSleep)(delay, controller.signal);
        } catch {
          throw abortError(this.providerId, timedOut);
        }
      }
      if (!response?.ok) {
        await cancelResponseBody(response);
        throw new AgentProviderError({
          code: "http",
          providerId: this.providerId,
          message: `Provider request failed with HTTP status ${response?.status ?? "unknown"}.`,
          status: response?.status,
          retryable: response ? RETRYABLE_STATUSES.has(response.status) : false,
        });
      }
      if (!hasEventStreamContentType(response)) {
        await cancelResponseBody(response);
        throw new AgentProviderError({
          code: "malformed-response",
          providerId: this.providerId,
          message: "Provider returned an unexpected content type.",
        });
      }
      let normalizedStreamBytes = 0;
      const contentRedactor = new StreamingSecretRedactor([credential]);
      const reasoningRedactor = new StreamingSecretRedactor([credential]);
      const boundRedactedEvent = (event: ProviderStreamEvent): JsonObject => {
        const redactedEvent = redactCredential(event as unknown as JsonObject, credential);
        const eventBytes = byteLength(JSON.stringify(redactedEvent));
        if (eventBytes > MAX_NORMALIZED_EVENT_BYTES) {
          throw responseLimitError(this.providerId, "Provider returned an oversized normalized stream event.");
        }
        normalizedStreamBytes += eventBytes;
        if (normalizedStreamBytes > MAX_NORMALIZED_STREAM_BYTES) {
          throw responseLimitError(this.providerId, "Provider exceeded the normalized stream output limit.");
        }
        return redactedEvent;
      };
      const emit = (event: ProviderStreamEvent): JsonObject | undefined => {
        if (event.type === "content-delta") {
          const delta = contentRedactor.push(event.delta);
          if (!delta) return undefined;
          return boundRedactedEvent({ ...event, delta });
        }
        if (event.type === "reasoning-delta") {
          const delta = reasoningRedactor.push(event.delta);
          if (!delta) return undefined;
          return boundRedactedEvent({ ...event, delta });
        }
        return boundRedactedEvent(event);
      };
      for await (const payload of readServerSentEvents(response, this.providerId, controller.signal)) {
        for (const event of normalizedEvents(payload, this.providerId)) {
          if (event.type === "completion") {
            const content = contentRedactor.flush();
            if (content) yield boundRedactedEvent({ type: "content-delta", delta: content });
            const reasoning = reasoningRedactor.flush();
            if (reasoning) yield boundRedactedEvent({ type: "reasoning-delta", delta: reasoning });
          }
          const redactedEvent = emit(event);
          if (redactedEvent) yield redactedEvent;
        }
      }
      const content = contentRedactor.flush();
      if (content) yield boundRedactedEvent({ type: "content-delta", delta: content });
      const reasoning = reasoningRedactor.flush();
      if (reasoning) yield boundRedactedEvent({ type: "reasoning-delta", delta: reasoning });
    } catch (error) {
      if (controller.signal.aborted) throw abortError(this.providerId, timedOut);
      if (error instanceof AgentProviderError) throw error;
      throw new AgentProviderError({
        code: "network",
        providerId: this.providerId,
        message: "Provider network request failed.",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: redirect validation remains linear at the transport boundary
  private async fetchWithSafeRedirects(
    initialUrl: URL,
    credential: string,
    configuration: ProviderConfiguration,
    request: JsonObject,
    signal: AbortSignal
  ): Promise<Response> {
    let url = initialUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const validatedEndpoint = await raceWithAbort(
        validateProviderEndpoint(url, this.dependencies.resolveDns, {
          providerId: this.providerId,
          testOnlyAllowLocalhost: this.options.testOnlyAllowLocalhost,
        }),
        signal
      );
      let response: Response;
      try {
        response = await this.dependencies.pinnedFetch({
          url: validatedEndpoint.url,
          validatedAddresses: validatedEndpoint.addresses,
          init: {
            method: "POST",
            redirect: "manual",
            signal,
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${credential}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...request, model: configuration.model, stream: true }),
          },
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new AgentProviderError({
          code: "network",
          providerId: this.providerId,
          message: "Provider network request failed.",
          retryable: true,
        });
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (!location || (response.status !== 307 && response.status !== 308) || redirect === 3) {
        throw new AgentProviderError({
          code: "security",
          providerId: this.providerId,
          message: "Provider returned an unsafe redirect.",
        });
      }
      let redirected: URL;
      try {
        redirected = new URL(location, validatedEndpoint.url);
      } catch {
        throw new AgentProviderError({
          code: "security",
          providerId: this.providerId,
          message: "Provider returned an unsafe redirect.",
        });
      }
      if (redirected.origin !== initialUrl.origin) {
        throw new AgentProviderError({
          code: "security",
          providerId: this.providerId,
          message: "Provider redirect cannot change origin.",
        });
      }
      url = redirected;
    }
    throw new AgentProviderError({
      code: "security",
      providerId: this.providerId,
      message: "Provider returned too many redirects.",
    });
  }
}

export function createOpenAiCompatibleProviderAdapter(
  providerId: string,
  options: ProviderEndpointOptions,
  dependencies: ProviderRuntimeDependencies
): AgentProviderAdapter {
  return new OpenAiCompatibleProviderAdapter(providerId, options, dependencies);
}

export {
  OpenAiCompatibleProviderAdapter as OpenAICompatibleProviderAdapter,
  createOpenAiCompatibleProviderAdapter as createOpenAICompatibleProviderAdapter,
};
