import { parseAgentSseBlock, readAgentEventStream } from "@/lib/agent/client";
import { describe, expect, it, vi } from "vitest";

describe("agent finite SSE client", () => {
  it("parses typed finite stream events and replay truncation notices", () => {
    const event = parseAgentSseBlock(
      'id: session-1:2\nevent: agent\ndata: {"schemaVersion":1,"eventId":"event-2","sessionId":"session-1","sequence":2,"timestamp":"2026-09-02T12:00:00.000Z","kind":"model","payload":{"schemaVersion":1,"redacted":true,"data":{}},"replayCursor":"session-1:2"}'
    );
    expect(event?.type).toBe("event");
    if (event?.type === "event") expect(event.event.sequence).toBe(2);

    expect(parseAgentSseBlock('event: replay-truncated\ndata: {"schemaVersion":1,"retainedFromSequence":8}')).toEqual({
      type: "replay-truncated",
      retainedFromSequence: 8,
    });
  });

  it("reconnects from the supplied cursor using Last-Event-ID semantics", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          ': heartbeat\n\nid: session-1:3\nevent: agent\ndata: {"schemaVersion":1,"eventId":"event-3","sessionId":"session-1","sequence":3,"timestamp":"2026-09-02T12:00:00.000Z","kind":"model","payload":{"schemaVersion":1,"redacted":true,"data":{}},"replayCursor":"session-1:3"}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
      );
    const received: number[] = [];

    await readAgentEventStream("session-1", "session-1:2", (message) => {
      if (message.type === "event") received.push(message.event.sequence);
    });

    expect(received).toEqual([3]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/sessions/session-1/events",
      expect.objectContaining({ headers: { "Last-Event-ID": "session-1:2" } })
    );
  });
});
