import {
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_PROVIDER_SSE_EVENTS,
  MAX_PROVIDER_SSE_EVENT_BYTES,
  MAX_PROVIDER_SSE_LINE_BYTES,
  MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
  PROVIDER_RESOURCE_LIMIT_CODE,
} from "../../lib/agent/response-limits";

type ProviderResponseLimit = {
  responseBytes: number;
  sseLineBytes: number;
  sseEventBytes: number;
  sseEvents: number;
  toolArgumentBytes: number;
};

const HARD_LIMITS: Readonly<ProviderResponseLimit> = Object.freeze({
  responseBytes: MAX_PROVIDER_RESPONSE_BYTES,
  sseLineBytes: MAX_PROVIDER_SSE_LINE_BYTES,
  sseEventBytes: MAX_PROVIDER_SSE_EVENT_BYTES,
  sseEvents: MAX_PROVIDER_SSE_EVENTS,
  toolArgumentBytes: MAX_PROVIDER_TOOL_ARGUMENT_BYTES,
});

export class ProviderResponseLimitError extends Error {
  readonly code = PROVIDER_RESOURCE_LIMIT_CODE;

  constructor() {
    super("Provider response failed a local resource limit.");
    this.name = "ProviderResponseLimitError";
  }
}

export interface ProviderResponseGuardOptions {
  fetch: typeof fetch;
  /** Test seam: values may only lower, never raise, production hard ceilings. */
  limits?: Partial<ProviderResponseLimit>;
}

function boundedLimits(overrides: Partial<ProviderResponseLimit> = {}): ProviderResponseLimit {
  const limits = { ...HARD_LIMITS, ...overrides };
  for (const key of Object.keys(HARD_LIMITS) as Array<keyof ProviderResponseLimit>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > HARD_LIMITS[key]) {
      throw new TypeError("Provider response limits may only lower production hard ceilings.");
    }
  }
  if (limits.sseLineBytes > limits.sseEventBytes || limits.sseEventBytes > limits.responseBytes) {
    throw new TypeError("Provider response limit ordering is invalid.");
  }
  return limits;
}

function exactContentLength(response: Response, maximum: number): void {
  const declared = response.headers.get("content-length");
  if (declared === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum) {
    throw new ProviderResponseLimitError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function streamedToolCalls(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return [];
  const calls: unknown[] = [];
  for (const choice of payload.choices) {
    if (isRecord(choice) && isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls)) {
      calls.push(...choice.delta.tool_calls);
    }
  }
  return calls;
}

function streamedToolArgumentBytes(toolCall: unknown): number {
  if (!isRecord(toolCall)) return 0;
  const functionArguments =
    isRecord(toolCall.function) && typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "";
  const customInput =
    isRecord(toolCall.custom) && typeof toolCall.custom.input === "string" ? toolCall.custom.input : "";
  return Buffer.byteLength(functionArguments) + Buffer.byteLength(customInput);
}

/**
 * Performs bounded framing and tool-argument accounting before Pi/OpenAI sees
 * an SSE event. Bytes are forwarded unchanged only after the complete incoming
 * chunk passes every local check.
 */
class SseResponseBudget {
  private readonly line: Uint8Array;
  private lineLength = 0;
  private eventBytes = 0;
  private responseBytes = 0;
  private eventCount = 0;
  private toolArgumentBytes = 0;
  private pendingCarriageReturn = false;
  private readonly dataLines: string[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly limits: ProviderResponseLimit) {
    this.line = new Uint8Array(limits.sseLineBytes);
  }

  accept(chunk: Uint8Array): void {
    this.responseBytes += chunk.byteLength;
    if (this.responseBytes > this.limits.responseBytes) throw new ProviderResponseLimitError();
    for (const byte of chunk) this.acceptByte(byte);
  }

  finish(): void {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.completeLine();
    }
    if (this.lineLength > 0 || this.eventBytes > 0 || this.dataLines.length > 0) {
      throw new ProviderResponseLimitError();
    }
  }

  private acceptByte(byte: number): void {
    this.eventBytes++;
    if (this.eventBytes > this.limits.sseEventBytes) throw new ProviderResponseLimitError();

    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.completeLine();
      if (byte === 0x0a) return;
    }
    if (byte === 0x0d) {
      this.pendingCarriageReturn = true;
      return;
    }
    if (byte === 0x0a) {
      this.completeLine();
      return;
    }
    if (this.lineLength >= this.limits.sseLineBytes) throw new ProviderResponseLimitError();
    this.line[this.lineLength++] = byte;
  }

  private completeLine(): void {
    if (this.lineLength === 0) {
      this.completeEvent();
      this.eventBytes = 0;
      return;
    }
    let value: string;
    try {
      value = this.decoder.decode(this.line.subarray(0, this.lineLength));
    } catch {
      throw new ProviderResponseLimitError();
    } finally {
      this.lineLength = 0;
    }
    if (value === "data") this.dataLines.push("");
    else if (value.startsWith("data:")) this.dataLines.push(value.slice(5).replace(/^ /, ""));
  }

  private completeEvent(): void {
    if (this.dataLines.length === 0) return;
    this.eventCount++;
    if (this.eventCount > this.limits.sseEvents) throw new ProviderResponseLimitError();
    const data = this.dataLines.join("\n");
    this.dataLines.length = 0;
    if (data.startsWith("[DONE]")) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      // Reject here so the OpenAI SDK cannot log unredacted malformed data.
      throw new ProviderResponseLimitError();
    }
    this.accountToolArguments(payload);
  }

  private accountToolArguments(payload: unknown): void {
    for (const toolCall of streamedToolCalls(payload)) {
      this.toolArgumentBytes += streamedToolArgumentBytes(toolCall);
      if (this.toolArgumentBytes > this.limits.toolArgumentBytes) throw new ProviderResponseLimitError();
    }
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

export class ProviderResponseGuard {
  private readonly upstream: typeof fetch;
  private readonly limits: ProviderResponseLimit;
  private readonly overflow = new AbortController();
  private readonly active = new Set<AbortController>();

  readonly signal = this.overflow.signal;

  constructor(options: ProviderResponseGuardOptions) {
    this.upstream = options.fetch;
    this.limits = boundedLimits(options.limits);
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    if (this.signal.aborted) throw new ProviderResponseLimitError();
    const requestController = new AbortController();
    this.active.add(requestController);
    const onCallerAbort = () => requestController.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (init.signal?.aborted) onCallerAbort();
    const headers = new Headers(init.headers);
    headers.set("accept-encoding", "identity");

    let response: Response;
    try {
      response = await this.upstream(input, { ...init, headers, signal: requestController.signal });
    } catch (error) {
      this.release(requestController, init.signal, onCallerAbort);
      throw error;
    }
    try {
      exactContentLength(response, this.limits.responseBytes);
    } catch {
      this.trip(requestController);
      await response.body?.cancel(new ProviderResponseLimitError()).catch(() => undefined);
      this.release(requestController, init.signal, onCallerAbort);
      throw new ProviderResponseLimitError();
    }
    if (!response.body) {
      this.release(requestController, init.signal, onCallerAbort);
      return response;
    }

    const reader = response.body.getReader();
    const budget = isEventStream(response) ? new SseResponseBudget(this.limits) : undefined;
    let responseBytes = 0;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      reader.releaseLock();
      this.release(requestController, init.signal, onCallerAbort);
    };
    const terminate = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      this.trip(requestController);
      await reader.cancel(new ProviderResponseLimitError()).catch(() => undefined);
      cleanup();
      controller.error(new ProviderResponseLimitError());
    };
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const next = await reader.read();
            if (next.done) {
              budget?.finish();
              cleanup();
              controller.close();
              return;
            }
            // Count raw delivered body bytes before framing or JSON parsing.
            responseBytes += next.value.byteLength;
            if (responseBytes > this.limits.responseBytes) throw new ProviderResponseLimitError();
            budget?.accept(next.value);
            controller.enqueue(next.value);
          } catch (error) {
            if (error instanceof ProviderResponseLimitError) {
              await terminate(controller);
              return;
            }
            await reader.cancel().catch(() => undefined);
            cleanup();
            controller.error(error);
          }
        },
        cancel: async (reason) => {
          requestController.abort(reason);
          await reader.cancel(reason).catch(() => undefined);
          cleanup();
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  private trip(current: AbortController): void {
    if (!this.overflow.signal.aborted) this.overflow.abort(new ProviderResponseLimitError());
    current.abort(new ProviderResponseLimitError());
    for (const controller of this.active) controller.abort(new ProviderResponseLimitError());
  }

  private release(
    controller: AbortController,
    callerSignal: AbortSignal | null | undefined,
    listener: () => void
  ): void {
    callerSignal?.removeEventListener("abort", listener);
    this.active.delete(controller);
  }
}
