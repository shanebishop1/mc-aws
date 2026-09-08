import type { JsonObject, ProviderConfiguration } from "@/lib/agent/contracts";
import { validateProviderEndpoint } from "@/lib/agent/providers/endpoint-security";
import { AgentProviderError } from "@/lib/agent/providers/errors";
import { DeterministicFakeProviderAdapter } from "@/lib/agent/providers/fake";
import { AgentModelGateway } from "@/lib/agent/providers/gateway";
import { OpenAiCompatibleProviderAdapter } from "@/lib/agent/providers/openai-compatible";
import { OpenRouterProviderAdapter } from "@/lib/agent/providers/openrouter";
import type { PinnedProviderFetch, ProviderRuntimeDependencies } from "@/lib/agent/providers/types";
import { describe, expect, it, vi } from "vitest";

const configuration: ProviderConfiguration = {
  schemaVersion: 1,
  profileId: "provider-profile",
  providerId: "generic",
  model: "model-1",
  credentialRef: "secret-ref:providers/generic/key",
  timeoutMs: 1_000,
};

function sse(...payloads: Array<JsonObject | "[DONE]">): Response {
  const encoder = new TextEncoder();
  const body = payloads.map(
    (payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of body) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function dependencies(pinnedFetch: PinnedProviderFetch, secret = "sk-test-super-secret"): ProviderRuntimeDependencies {
  return {
    pinnedFetch,
    resolveDns: vi.fn(async () => ["93.184.216.34"]),
    secretResolver: { resolve: vi.fn(async () => secret) },
    sleep: vi.fn(async () => undefined),
  };
}

async function collect(stream: AsyncIterable<JsonObject>): Promise<JsonObject[]> {
  const chunks: JsonObject[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("model provider adapters", () => {
  it("normalizes OpenAI-compatible SSE without exposing provider-specific envelopes", async () => {
    const fetch = vi.fn<PinnedProviderFetch>(async () =>
      sse(
        { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] },
        { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { name: "inspect", arguments: "{}" } }] },
              finish_reason: null,
            },
          ],
        },
        { usage: { prompt_tokens: 2, completion_tokens: 3 } },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]"
      )
    );
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(fetch)
    );

    await expect(collect(adapter.stream(configuration, { messages: [] }))).resolves.toEqual([
      { type: "reasoning-delta", delta: "thinking" },
      { type: "content-delta", delta: "hello" },
      {
        type: "tool-call-delta",
        toolCalls: [{ index: 0, function: { name: "inspect", arguments: "{}" } }],
      },
      { type: "usage", usage: { prompt_tokens: 2, completion_tokens: 3 } },
      { type: "completion", finishReason: "stop" },
    ]);
    const [{ url, validatedAddresses, init }] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://models.example/v1/chat/completions");
    expect(validatedAddresses).toEqual(["93.184.216.34"]);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "model-1", stream: true });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test-super-secret");
    expect(init.redirect).toBe("manual");
  });

  it("uses the documented OpenRouter endpoint behind the same adapter contract", async () => {
    const fetch = vi.fn<PinnedProviderFetch>(async () => sse("[DONE]"));
    const adapter = new OpenRouterProviderAdapter(dependencies(fetch));
    await collect(adapter.stream({ ...configuration, providerId: "openrouter" }, { messages: [] }));
    expect(String(fetch.mock.calls[0][0].url)).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("resolves only the opaque credentialRef and sanitizes resolver failures", async () => {
    const rawSecret = "sk-should-never-escape";
    const resolver = vi.fn(async () => {
      throw new Error(`vault failed for ${rawSecret}`);
    });
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      {
        ...dependencies(vi.fn()),
        secretResolver: { resolve: resolver },
      }
    );

    const error = await collect(adapter.stream(configuration, {})).catch((caught: unknown) => caught);
    expect(resolver).toHaveBeenCalledWith(configuration.credentialRef);
    expect(error).toMatchObject({ code: "credentials", providerId: "generic" });
    expect(JSON.stringify(error)).not.toContain(rawSecret);
    expect(String(error)).not.toContain(rawSecret);
  });

  it("returns sanitized status errors and does not read or include sensitive response bodies", async () => {
    const rawSecret = "provider-leaked-sk-secret";
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1", maxAttempts: 1 },
      dependencies(vi.fn(async () => new Response(`bad key ${rawSecret}`, { status: 401 })))
    );

    const error = await collect(adapter.stream(configuration, {})).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "http", status: 401, retryable: false });
    expect(JSON.stringify(error)).not.toContain(rawSecret);
    expect(String(error)).not.toContain(rawSecret);
  });

  it("redacts the resolved credential if an upstream stream reflects it", async () => {
    const rawSecret = "sk-reflected-secret";
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(
        vi.fn(async () =>
          sse({ choices: [{ delta: { content: `reflected ${rawSecret}` }, finish_reason: "stop" }] }, "[DONE]")
        ),
        rawSecret
      )
    );
    const events = await collect(adapter.stream(configuration, {}));
    expect(JSON.stringify(events)).not.toContain(rawSecret);
    expect(events[0]).toEqual({ type: "content-delta", delta: "reflected [REDACTED]" });
  });

  it("rejects malformed JSON, malformed chunks, incomplete events, and mid-stream errors", async () => {
    const cases = [
      new Response("data: {broken}\n\n", { headers: { "content-type": "text/event-stream" } }),
      sse({ unexpected: true }),
      new Response('data: {"choices":[]}', { status: 200, headers: { "content-type": "text/event-stream" } }),
      sse({ error: { message: "sensitive upstream detail" } }),
    ];
    for (const response of cases) {
      const adapter = new OpenAiCompatibleProviderAdapter(
        "generic",
        { endpoint: "https://models.example/v1" },
        dependencies(vi.fn(async () => response))
      );
      const error = await collect(adapter.stream(configuration, {})).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentProviderError);
      expect(error).toMatchObject({ providerId: "generic" });
      expect(String(error)).not.toContain("sensitive upstream detail");
    }
  });

  it("requires an event-stream content type and rejects oversized streaming data", async () => {
    const wrongContentType = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })))
    );
    await expect(collect(wrongContentType.stream(configuration, {}))).rejects.toMatchObject({
      code: "malformed-response",
      message: "Provider returned an unexpected content type.",
    });

    const cancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1_114_113)));
      },
      cancel,
    });
    const oversizedStream = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(
        vi.fn(
          async () =>
            new Response(oversizedBody, {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8" },
            })
        )
      )
    );
    await expect(collect(oversizedStream.stream(configuration, {}))).rejects.toMatchObject({
      code: "malformed-response",
      message: "Provider exceeded the streaming buffer limit.",
    });
    expect(cancel).toHaveBeenCalledOnce();

    const oversizedEvent = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(
        vi.fn(async () =>
          sse({ choices: [{ delta: { content: "x".repeat(262_144) }, finish_reason: null }] }, "[DONE]")
        )
      )
    );
    await expect(collect(oversizedEvent.stream(configuration, {}))).rejects.toMatchObject({
      code: "malformed-response",
      message: "Provider returned an oversized normalized stream event.",
    });

    const largePayload = { choices: [{ delta: { content: "x".repeat(220_000) }, finish_reason: null }] };
    const oversizedOutput = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(vi.fn(async () => sse(largePayload, largePayload, largePayload, largePayload, largePayload)))
    );
    await expect(collect(oversizedOutput.stream(configuration, {}))).rejects.toMatchObject({
      code: "malformed-response",
      message: "Provider exceeded the normalized stream output limit.",
    });
  });

  it.each([0, 300_001, Number.POSITIVE_INFINITY, 1.5])(
    "rejects unsafe provider timeout %s at the adapter boundary",
    async (timeoutMs) => {
      const fetch = vi.fn<PinnedProviderFetch>();
      const adapter = new OpenAiCompatibleProviderAdapter(
        "generic",
        { endpoint: "https://models.example/v1" },
        dependencies(fetch)
      );
      await expect(collect(adapter.stream({ ...configuration, timeoutMs }, {}))).rejects.toMatchObject({
        code: "configuration",
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("cancels an in-flight request with a consistent cancellation error", async () => {
    const fetch = vi.fn<PinnedProviderFetch>(
      async ({ init }) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        })
    );
    const controller = new AbortController();
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(fetch)
    );
    const result = collect(adapter.stream(configuration, {}, controller.signal)).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    await expect(result).resolves.toMatchObject({ code: "cancelled" });
  });

  it("times out an in-flight request", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<PinnedProviderFetch>(
        async ({ init }) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          })
      );
      const adapter = new OpenAiCompatibleProviderAdapter(
        "generic",
        { endpoint: "https://models.example/v1" },
        dependencies(fetch)
      );
      const result = collect(adapter.stream({ ...configuration, timeoutMs: 25 }, {})).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries only request-rejected statuses and honors bounded backoff", async () => {
    const fetch = vi
      .fn<PinnedProviderFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(sse("[DONE]"));
    const deps = dependencies(fetch);
    deps.resolveDns = vi
      .fn<ProviderRuntimeDependencies["resolveDns"]>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.35"])
      .mockResolvedValueOnce(["93.184.216.36"]);
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1", maxAttempts: 2 },
      deps
    );
    await collect(adapter.stream(configuration, {}));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([request]) => request.validatedAddresses)).toEqual([
      ["93.184.216.35"],
      ["93.184.216.36"],
    ]);
    expect(deps.sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));

    const serverErrorFetch = vi.fn<PinnedProviderFetch>(async () => new Response(null, { status: 503 }));
    const noUnsafeRetry = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1", maxAttempts: 3 },
      dependencies(serverErrorFetch)
    );
    await expect(collect(noUnsafeRetry.stream(configuration, {}))).rejects.toMatchObject({ status: 503 });
    expect(serverErrorFetch).toHaveBeenCalledTimes(1);
  });

  it("routes through the gateway and provides deterministic fake output", async () => {
    const expected = [{ type: "content-delta", delta: "fixture" }];
    const gateway = new AgentModelGateway([new DeterministicFakeProviderAdapter(expected)]);
    await expect(collect(gateway.stream({ ...configuration, providerId: "fake" }, {}))).resolves.toEqual(expected);
    expect(() => gateway.stream({ ...configuration, providerId: "missing" }, {})).toThrow(/not registered/);
  });
});

describe("provider endpoint SSRF protection", () => {
  it("returns the normalized URL and immutable validated address set", async () => {
    const validated = await validateProviderEndpoint(
      "HTTPS://MODELS.EXAMPLE:443/v1",
      async () => ["93.184.216.34", "93.184.216.34"],
      { providerId: "generic" }
    );
    expect(validated.url.href).toBe("https://models.example/v1");
    expect(validated.addresses).toEqual(["93.184.216.34"]);
    expect(Object.isFrozen(validated.addresses)).toBe(true);
  });

  it.each([
    ["metadata IPv4", "https://169.254.169.254/latest/meta-data", ["169.254.169.254"]],
    ["loopback", "https://127.0.0.1/v1", ["127.0.0.1"]],
    ["private IPv4", "https://internal.example/v1", ["10.0.0.8"]],
    ["reserved IPv4", "https://reserved.example/v1", ["192.0.2.1"]],
    ["IPv6 loopback", "https://[::1]/v1", ["::1"]],
    ["IPv6 link-local", "https://internal.example/v1", ["fe80::1"]],
    ["IPv6 private", "https://internal.example/v1", ["fd00::1"]],
    ["public and private mixed DNS", "https://mixed.example/v1", ["93.184.216.34", "172.16.0.2"]],
  ])("rejects %s endpoints", async (_name, endpoint, addresses) => {
    await expect(
      validateProviderEndpoint(endpoint, async () => addresses, { providerId: "generic" })
    ).rejects.toMatchObject({ code: "security" });
  });

  it("fails closed for empty and failed DNS resolution", async () => {
    await expect(
      validateProviderEndpoint("https://empty.example/v1", async () => [], { providerId: "generic" })
    ).rejects.toMatchObject({ code: "security" });
    await expect(
      validateProviderEndpoint(
        "https://failed.example/v1",
        async () => {
          throw new Error("DNS unavailable");
        },
        { providerId: "generic" }
      )
    ).rejects.toMatchObject({ code: "security" });
  });

  it("requires HTTPS and allows localhost only with the explicit test-only switch", async () => {
    await expect(
      validateProviderEndpoint("http://models.example/v1", async () => ["93.184.216.34"], {
        providerId: "generic",
      })
    ).rejects.toMatchObject({ code: "security" });
    await expect(
      validateProviderEndpoint("http://localhost:8080/v1", async () => ["127.0.0.1"], {
        providerId: "fake-local",
        testOnlyAllowLocalhost: true,
      })
    ).resolves.toMatchObject({ url: { hostname: "localhost" }, addresses: ["127.0.0.1"] });
    await expect(
      validateProviderEndpoint("http://private.example/v1", async () => ["10.0.0.2"], {
        providerId: "fake-local",
        testOnlyAllowLocalhost: true,
      })
    ).rejects.toMatchObject({ code: "security" });
    await expect(
      validateProviderEndpoint("http://localhost:8080/v1", async () => ["169.254.169.254"], {
        providerId: "fake-local",
        testOnlyAllowLocalhost: true,
      })
    ).rejects.toMatchObject({ code: "security" });
  });

  it("rejects redirects before credentials can be sent to another origin or forbidden address", async () => {
    const fetch = vi.fn<PinnedProviderFetch>(
      async () => new Response(null, { status: 307, headers: { location: "https://169.254.169.254/latest/meta-data" } })
    );
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(fetch)
    );
    await expect(collect(adapter.stream(configuration, {}))).rejects.toMatchObject({ code: "security" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates and repins an allowed same-origin redirect", async () => {
    const resolveDns = vi
      .fn<ProviderRuntimeDependencies["resolveDns"]>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.35"])
      .mockResolvedValueOnce(["93.184.216.36"]);
    const pinnedFetch = vi
      .fn<PinnedProviderFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/v1/redirected" } }))
      .mockResolvedValueOnce(sse("[DONE]"));
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      { ...dependencies(pinnedFetch), resolveDns }
    );

    await collect(adapter.stream(configuration, {}));
    expect(pinnedFetch.mock.calls.map(([request]) => [request.url.pathname, request.validatedAddresses])).toEqual([
      ["/v1/chat/completions", ["93.184.216.35"]],
      ["/v1/redirected", ["93.184.216.36"]],
    ]);
  });

  it("re-resolves DNS immediately before each network request", async () => {
    const resolveDns = vi
      .fn<ProviderRuntimeDependencies["resolveDns"]>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["10.0.0.3"]);
    const fetch = vi.fn<PinnedProviderFetch>();
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      { ...dependencies(fetch), resolveDns }
    );
    await expect(collect(adapter.stream(configuration, {}))).rejects.toMatchObject({ code: "security" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned transport detects simulated DNS rebinding", async () => {
    const pinnedFetch = vi.fn<PinnedProviderFetch>(async ({ url, validatedAddresses }) => {
      expect(url.hostname).toBe("models.example");
      expect(validatedAddresses).toEqual(["93.184.216.34"]);
      const reboundAddress = "10.0.0.3";
      if (!validatedAddresses.includes(reboundAddress)) throw new Error("Pinned address rejected");
      return sse("[DONE]");
    });
    const adapter = new OpenAiCompatibleProviderAdapter(
      "generic",
      { endpoint: "https://models.example/v1" },
      dependencies(pinnedFetch)
    );

    await expect(collect(adapter.stream(configuration, {}))).rejects.toMatchObject({
      code: "network",
      message: "Provider network request failed.",
    });
    expect(pinnedFetch).toHaveBeenCalledOnce();
  });
});
