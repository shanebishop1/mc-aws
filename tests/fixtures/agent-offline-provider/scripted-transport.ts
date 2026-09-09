import type { JsonObject } from "@/lib/agent/contracts";

export const OFFLINE_PROVIDER_ENDPOINT = "https://offline-scripted.invalid/v1";
export const OFFLINE_PROVIDER_CREDENTIAL = "offline-provider-credential-canary";
export const SAMPLE_TOOL_NAME = "example_status-report_read";
export const WRITE_TOOL_NAME = "workspace_write";

type ScriptStep = "inspect" | "write" | "complete";

function sse(...payloads: Array<JsonObject | "[DONE]">): Response {
  const encoder = new TextEncoder();
  const frames = payloads.map((payload) => `data: ${payload === "[DONE]" ? payload : JSON.stringify(payload)}\n\n`);
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
          await Promise.resolve();
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function inspectResponse(): Response {
  return sse(
    { choices: [{ delta: { content: "Inspecting the status file before changing it." }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-inspect",
                type: "function",
                function: { name: SAMPLE_TOOL_NAME, arguments: '{"path":"status.txt",' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '"maxBytes":4096}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    "[DONE]"
  );
}

function writeResponse(): Response {
  return sse(
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-write",
                type: "function",
                function: {
                  name: WRITE_TOOL_NAME,
                  arguments: '{"path":"status.txt","content":"status=updated\\n"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "[DONE]"
  );
}

function completionResponse(): Response {
  return sse(
    { choices: [{ delta: { content: "The status file was updated after approval." }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]"
  );
}

/**
 * A test-local transport for the production Pi/OpenAI-compatible registration.
 * It accepts only the fixed scripted endpoint and never delegates to global fetch,
 * so an accidental external request is observable and fails closed.
 */
export class ScriptedOfflineProviderTransport {
  readonly requests: Array<{ url: string; body: JsonObject; authorization: string | null }> = [];
  externalNetworkAttempts = 0;

  private step: ScriptStep = "inspect";

  private validateRequest(
    input: RequestInfo | URL,
    init: RequestInit
  ): {
    url: string;
    authorization: string | null;
    body: JsonObject;
  } {
    const url = String(input);
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    if (url !== `${OFFLINE_PROVIDER_ENDPOINT}/chat/completions` || init.method !== "POST") {
      this.externalNetworkAttempts += 1;
      throw new Error("offline scripted provider rejected a non-local transport request");
    }
    if (authorization !== `Bearer ${OFFLINE_PROVIDER_CREDENTIAL}`) {
      throw new Error("offline scripted provider received an unexpected credential");
    }
    const rawBody = typeof init.body === "string" ? init.body : "";
    return { url, authorization, body: JSON.parse(rawBody) as JsonObject };
  }

  private responseForStep(): Response {
    if (this.step === "inspect") return inspectResponse();
    if (this.step === "write") return writeResponse();
    return completionResponse();
  }

  private advanceStep(): void {
    if (this.step === "inspect") this.step = "write";
    else if (this.step === "write") this.step = "complete";
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const { url, authorization, body } = this.validateRequest(input, init);
    this.requests.push({ url, body, authorization });
    const response = this.responseForStep();
    this.advanceStep();
    return response;
  };
}
