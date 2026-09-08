import { agentErrorResponse, authenticateAgentAdmin, enforceAgentRateLimit } from "@/lib/agent/control-plane/http";
import { AgentControlPlaneService } from "@/lib/agent/control-plane/service";
import { AgentApiValidationError, parseAgentId } from "@/lib/agent/control-plane/validation";
import type { AgentEventWait } from "@/lib/agent/state";
import { getAgentSessionStore } from "@/lib/agent/state";
import { type NextRequest, NextResponse } from "next/server";

interface Context {
  params: Promise<{ sessionId: string }>;
}

const encoder = new TextEncoder();
const WAIT_MS = 10_000;
const EVENT_LIMIT = 100;

function cursor(request: NextRequest): string | undefined {
  if ([...request.nextUrl.searchParams.keys()].some((key) => key !== "after")) {
    throw new AgentApiValidationError();
  }
  if (request.nextUrl.searchParams.getAll("after").length > 1) throw new AgentApiValidationError();
  const fromHeader = request.headers.get("last-event-id")?.trim() || undefined;
  const fromQuery = request.nextUrl.searchParams.get("after")?.trim() || undefined;
  if ((fromHeader && fromHeader.length > 256) || (fromQuery && fromQuery.length > 256)) {
    throw new AgentApiValidationError();
  }
  if (fromHeader && fromQuery && fromHeader !== fromQuery) throw new AgentApiValidationError();
  return fromHeader ?? fromQuery;
}

function encodeReplay(result: AgentEventWait): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  if (result.truncated) {
    chunks.push(
      encoder.encode(
        `event: replay-truncated\ndata: ${JSON.stringify({ schemaVersion: 1, retainedFromSequence: result.retainedFromSequence })}\n\n`
      )
    );
  }
  for (const event of result.events) {
    chunks.push(encoder.encode(`id: ${event.replayCursor}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`));
  }
  return chunks;
}

function eventStreamResponse(stream: ReadableStream<Uint8Array>): NextResponse {
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: NextRequest, context: Context): Promise<NextResponse> {
  const auth = await authenticateAgentAdmin(request);
  if (auth instanceof Response) return auth as NextResponse;
  const throttled = await enforceAgentRateLimit(request, auth.actorId, "/api/agent/sessions/[sessionId]/events", false);
  if (throttled) return throttled;
  try {
    const { sessionId: rawSessionId } = await context.params;
    const sessionId = parseAgentId(rawSessionId);
    const after = cursor(request);
    const service = new AgentControlPlaneService(await getAgentSessionStore());
    const immediate = await service.waitForEvents(auth.actorId, sessionId, after, EVENT_LIMIT, 0, request.signal);
    if (immediate.events.length > 0 || immediate.truncated || immediate.terminal) {
      return eventStreamResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            for (const chunk of encodeReplay(immediate)) controller.enqueue(chunk);
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            controller.close();
          },
        })
      );
    }
    const waitController = new AbortController();
    const abortWait = () => waitController.abort();
    request.signal.addEventListener("abort", abortWait, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
        try {
          const result = await service.waitForEvents(
            auth.actorId,
            sessionId,
            after,
            EVENT_LIMIT,
            WAIT_MS,
            waitController.signal
          );
          if (!request.signal.aborted) {
            for (const chunk of encodeReplay(result)) controller.enqueue(chunk);
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        } catch {
          if (!request.signal.aborted) {
            controller.enqueue(
              encoder.encode('event: stream-error\ndata: {"schemaVersion":1,"error":"stream unavailable"}\n\n')
            );
          }
        } finally {
          request.signal.removeEventListener("abort", abortWait);
          controller.close();
        }
      },
      cancel() {
        waitController.abort();
        request.signal.removeEventListener("abort", abortWait);
      },
    });
    return eventStreamResponse(stream);
  } catch (error) {
    return agentErrorResponse(error);
  }
}
