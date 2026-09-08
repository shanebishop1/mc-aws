import { describe, expect, it, vi } from "vitest";
import { ProviderResponseGuard, ProviderResponseLimitError } from "./provider-response-guard";

const encoder = new TextEncoder();

function streamResponse(
  chunks: readonly string[],
  options: { close?: boolean; contentType?: string; onCancel?: () => void; onPull?: () => void } = {}
): Response {
  let next = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        options.onPull?.();
        const chunk = chunks[next++];
        if (chunk === undefined) {
          if (options.close !== false) controller.close();
        } else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    { status: 200, headers: { "content-type": options.contentType ?? "text/event-stream" } }
  );
}

async function read(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return output;
    output += decoder.decode(next.value, { stream: true });
  }
}

function guarded(response: Response, limits: ConstructorParameters<typeof ProviderResponseGuard>[0]["limits"] = {}) {
  let requestSignal: AbortSignal | undefined;
  const upstream = vi.fn<typeof fetch>(async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return response;
  });
  const guard = new ProviderResponseGuard({ fetch: upstream, limits });
  return { guard, upstream, requestSignal: () => requestSignal };
}

describe("production provider response guard", () => {
  it("forwards valid split SSE bytes unchanged with pull backpressure and identity encoding", async () => {
    let pulls = 0;
    const chunks = [
      'data: {"choices":[{"delta":{"content":"safe"},"finish_reason":null}]}\r\n',
      "\r\ndata: [DONE]\n\n",
    ];
    const test = guarded(
      streamResponse(chunks, {
        onPull: () => pulls++,
      }),
      { responseBytes: 512, sseLineBytes: 128, sseEventBytes: 256 }
    );
    const response = await test.guard.fetch("https://models.example.invalid/v1", {
      headers: { accept: "text/event-stream" },
    });
    await Promise.resolve();
    expect(pulls).toBeLessThanOrEqual(1);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await Promise.resolve();
    expect(pulls).toBeLessThanOrEqual(2);
    const rest: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      rest.push(next.value);
    }
    const received = [first.value!, ...rest].map((value) => new TextDecoder().decode(value)).join("");
    expect(received).toBe(chunks.join(""));
    expect(new Headers(test.upstream.mock.calls[0][1]?.headers).get("accept-encoding")).toBe("identity");
    expect(test.guard.signal.aborted).toBe(false);
  });

  it.each([
    {
      name: "raw response bytes before JSON parsing",
      chunks: ["x".repeat(65)],
      limits: { responseBytes: 64, sseLineBytes: 16, sseEventBytes: 32 },
    },
    {
      name: "one SSE line",
      chunks: [`data: ${"x".repeat(20)}\n\n`],
      limits: { responseBytes: 64, sseLineBytes: 16, sseEventBytes: 48 },
    },
    {
      name: "one SSE event",
      chunks: [":123456789\n:123456789\n:123456789\n\n"],
      limits: { responseBytes: 64, sseLineBytes: 16, sseEventBytes: 24 },
    },
    {
      name: "SSE event count",
      chunks: ["data: {}\n\n", "data: {}\n\n", "data: {}\n\n"],
      limits: { responseBytes: 64, sseLineBytes: 16, sseEventBytes: 24, sseEvents: 2 },
    },
    {
      name: "streamed tool arguments across events",
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"12345"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"67890"}}]}}]}\n\n',
      ],
      limits: { responseBytes: 512, sseLineBytes: 128, sseEventBytes: 192, toolArgumentBytes: 8 },
    },
  ])("aborts and cancels immediately when $name exceeds its local ceiling", async ({ chunks, limits }) => {
    const cancel = vi.fn();
    const test = guarded(streamResponse(chunks, { close: false, onCancel: cancel }), limits);
    const response = await test.guard.fetch("https://models.example.invalid/v1");
    const failure = await read(response).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderResponseLimitError);
    expect(failure).toMatchObject({ code: "provider-response-limit" });
    expect(test.guard.signal.aborted).toBe(true);
    expect(test.requestSignal()?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a never-ending chunk flood and exposes no reflected secret in its failure", async () => {
    const secret = "configured-provider-secret-canary";
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(encoder.encode(`:${secret}\n`));
        },
        cancel,
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const test = guarded(response, { responseBytes: 256, sseLineBytes: 64, sseEventBytes: 128 });
    const guardedResponse = await test.guard.fetch("https://models.example.invalid/v1");
    const failure = await read(guardedResponse).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderResponseLimitError);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(secret);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared body without reading it", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(encoder.encode("must-not-be-read"));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json", "content-length": "65" } }
    );
    const test = guarded(response, { responseBytes: 64, sseLineBytes: 16, sseEventBytes: 32 });
    await expect(test.guard.fetch("https://models.example.invalid/v1")).rejects.toBeInstanceOf(
      ProviderResponseLimitError
    );
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(test.guard.signal.aborted).toBe(true);
  });

  it("does not permit test seams to raise production hard ceilings", () => {
    expect(() => new ProviderResponseGuard({ fetch: vi.fn(), limits: { responseBytes: 4 * 1024 * 1024 + 1 } })).toThrow(
      /only lower/
    );
  });
});
