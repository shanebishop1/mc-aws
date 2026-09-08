import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CredentiallessHttpsRelayTransport,
  GatewayDownloadRelayClient,
  GatewayDownloadRelayServer,
} from "./download-relay";
import { PinnedHttpsTransport } from "./pinned-https";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-download-relay-"));
  roots.push(root);
  return path.join(root, "download.sock");
}

function response(body: BodyInit, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/octet-stream", ...headers },
  });
}

async function relay(transport: CredentiallessHttpsRelayTransport) {
  const socket = await socketPath();
  const keys = generateKeyPairSync("ed25519");
  const server = new GatewayDownloadRelayServer({
    socketPath: socket,
    gatewayPrivateKey: keys.privateKey,
    transport,
  });
  await server.listen();
  const client = new GatewayDownloadRelayClient({ socketPath: socket, gatewayPublicKey: keys.publicKey });
  return { server, client };
}

function grant(
  server: GatewayDownloadRelayServer,
  overrides: Partial<{ maxBytes: number; timeoutMs: number; expectedSha256: string; expectedBytes: number }> = {}
) {
  return server.authorize({
    invocationId: "invocation-download",
    sessionId: "session-download",
    invocationDigest: "d".repeat(64),
    requestFingerprint: "f".repeat(64),
    url: "https://downloads.example.invalid/mod.jar",
    expectedSha256: overrides.expectedSha256 ?? "a4b18d49756f30511502218d997b05e7e883fa40bb5837bcc1a8324d3fcf0693",
    expectedBytes: overrides.expectedBytes ?? 10,
    maxBytes: overrides.maxBytes ?? 1024,
    timeoutMs: overrides.timeoutMs ?? 5_000,
  });
}

describe("credential-segregated gateway download relay", () => {
  it("streams only bounded credential-less content and fences authorization replay", async () => {
    const runtimeCanary = "runtime-bearer-canary";
    const providerCanary = "provider-key-canary";
    process.env.MC_AGENT_RUNTIME_TOKEN = runtimeCanary;
    process.env.OPENROUTER_API_KEY = providerCanary;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const test = await relay({
      async fetchWithMetadata(input, init) {
        calls.push({ url: String(input), init });
        return {
          response: response("safe bytes", { "content-length": "10" }),
          finalUrl: new URL(String(input)),
        };
      },
    });
    try {
      const authorization = grant(test.server);
      expect(grant(test.server)).toStrictEqual(authorization);
      const chunks: Uint8Array[] = [];
      const result = await test.client.download(
        authorization,
        new AbortController().signal,
        async (chunk) => void chunks.push(chunk)
      );
      expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("safe bytes");
      expect(result).toMatchObject({
        bytes: 10,
        contentType: "application/octet-stream",
        contentDigest: "a4b18d49756f30511502218d997b05e7e883fa40bb5837bcc1a8324d3fcf0693",
      });
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0])).not.toContain(runtimeCanary);
      expect(JSON.stringify(calls[0])).not.toContain(providerCanary);
      expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
      await expect(
        test.client.download(authorization, new AbortController().signal, async () => undefined)
      ).rejects.toThrow(/failed closed/i);
    } finally {
      process.env.MC_AGENT_RUNTIME_TOKEN = undefined;
      process.env.OPENROUTER_API_KEY = undefined;
      await test.server.close();
    }
  });

  it.each([
    ["oversized declaration", response("small", { "content-length": "2048" })],
    [
      "oversized stream",
      response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2048));
            controller.close();
          },
        })
      ),
    ],
    ["disallowed HTML", response("<html></html>", { "content-type": "text/html" })],
    ["encoded body", response("encoded", { "content-encoding": "gzip" })],
  ])("rejects %s before accepting a completed destination stream", async (_label, rejected) => {
    const test = await relay({
      async fetchWithMetadata(input) {
        return { response: rejected, finalUrl: new URL(String(input)) };
      },
    });
    try {
      let accepted = 0;
      await expect(
        test.client.download(grant(test.server, { maxBytes: 1024 }), new AbortController().signal, async (chunk) => {
          accepted += chunk.byteLength;
        })
      ).rejects.toThrow();
      expect(accepted).toBe(0);
    } finally {
      await test.server.close();
    }
  });

  it("aborts an in-flight upstream transfer when the executor cancels", async () => {
    let upstreamAborted = false;
    const test = await relay({
      async fetchWithMetadata(input, init) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            init.signal?.addEventListener(
              "abort",
              () => {
                upstreamAborted = true;
                controller.error(new DOMException("cancelled", "AbortError"));
              },
              { once: true }
            );
          },
        });
        return { response: response(body), finalUrl: new URL(String(input)) };
      },
    });
    try {
      const controller = new AbortController();
      const download = test.client.download(grant(test.server), controller.signal, async () => controller.abort());
      await expect(download).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(upstreamAborted).toBe(true));
    } finally {
      await test.server.close();
    }
  });

  it("rejects a tampered signed capability before any upstream request", async () => {
    let requests = 0;
    const test = await relay({
      async fetchWithMetadata(input) {
        requests++;
        return { response: response("unexpected"), finalUrl: new URL(String(input)) };
      },
    });
    try {
      const authorization = grant(test.server);
      authorization.url = "https://downloads.example.invalid/other.jar";
      await expect(
        test.client.download(authorization, new AbortController().signal, async () => undefined)
      ).rejects.toThrow(/failed closed/i);
      expect(requests).toBe(0);
    } finally {
      await test.server.close();
    }
  });

  it("rejects changed content at the same URL and never reports a verified stream", async () => {
    const test = await relay({
      async fetchWithMetadata(input) {
        return { response: response("changed bytes"), finalUrl: new URL(String(input)) };
      },
    });
    try {
      const chunks: Uint8Array[] = [];
      await expect(
        test.client.download(grant(test.server), new AbortController().signal, async (chunk) => void chunks.push(chunk))
      ).rejects.toThrow(/content identity|truncated|truncated-message|failed closed/i);
      expect(Buffer.concat(chunks).toString()).toBe("changed bytes");
    } finally {
      await test.server.close();
    }
  });

  it("rejects a redirect/final URL swap even when the origin is unchanged", async () => {
    let chunks = 0;
    const test = await relay({
      async fetchWithMetadata(_input) {
        return { response: response("safe bytes"), finalUrl: new URL("https://downloads.example.invalid/other.jar") };
      },
    });
    try {
      await expect(
        test.client.download(grant(test.server), new AbortController().signal, async (chunk) => {
          chunks += chunk.byteLength;
        })
      ).rejects.toThrow(/final URL|failed closed/i);
      expect(chunks).toBe(0);
    } finally {
      await test.server.close();
    }
  });

  it("rejects an exact-size mismatch before a successful relay trailer", async () => {
    const test = await relay({
      async fetchWithMetadata(input) {
        return { response: response("safe bytes"), finalUrl: new URL(String(input)) };
      },
    });
    try {
      await expect(
        test.client.download(
          grant(test.server, { expectedBytes: 11 }),
          new AbortController().signal,
          async () => undefined
        )
      ).rejects.toThrow(/content identity|truncated|truncated-message|failed closed/i);
    } finally {
      await test.server.close();
    }
  });
});

describe("pinned HTTPS redirect and DNS boundary", () => {
  it.each(["169.254.169.254", "127.0.0.1", "10.0.0.7", "::1", "fd00:ec2::254", "2002:7f00:1::", "::ffff:127.0.0.1"])(
    "rejects private DNS answer %s before dispatch",
    async (address) => {
      const request = vi.fn();
      const transport = new PinnedHttpsTransport({
        resolveDns: async () => [address],
        request: request as never,
      });
      await expect(transport.fetchWithMetadata("https://downloads.example.invalid/file", {})).rejects.toThrow(
        /forbidden network range/i
      );
      expect(request).not.toHaveBeenCalled();
      await transport.close();
    }
  );

  it("revalidates an exact-resource redirect and rejects a rebinding answer", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    const resolveDns = vi.fn(async () => answers.shift() ?? ["127.0.0.1"]);
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/file" } }));
    const transport = new PinnedHttpsTransport({ resolveDns, request: request as never });
    await expect(transport.fetchWithMetadata("https://downloads.example.invalid/file", {})).rejects.toThrow(
      /forbidden network range/i
    );
    expect(resolveDns).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
    await transport.close();
  });

  it("rejects a same-origin redirect to a different exact pathname before contacting it", async () => {
    const resolveDns = vi.fn(async () => ["93.184.216.34"]);
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/other.jar" } }));
    const transport = new PinnedHttpsTransport({ resolveDns, request: request as never });
    await expect(transport.fetchWithMetadata("https://downloads.example.invalid/file", {})).rejects.toThrow(
      /different-resource/i
    );
    expect(resolveDns).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    await transport.close();
  });

  it("rejects cross-origin redirects without resolving or contacting the redirected host", async () => {
    const resolveDns = vi.fn(async () => ["93.184.216.34"]);
    const request = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://attacker.example.invalid/file" } })
    );
    const transport = new PinnedHttpsTransport({ resolveDns, request: request as never });
    await expect(transport.fetchWithMetadata("https://downloads.example.invalid/file", {})).rejects.toThrow(
      /cross-origin/i
    );
    expect(resolveDns).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String((request.mock.calls as unknown[][])[0]?.[0])).toContain("downloads.example.invalid");
    await transport.close();
  });

  it("enforces a finite redirect bound", async () => {
    const request = vi.fn(async () => new Response(null, { status: 307, headers: { location: "/file" } }));
    const transport = new PinnedHttpsTransport({
      resolveDns: async () => ["93.184.216.34"],
      request: request as never,
    });
    await expect(transport.fetchWithMetadata("https://downloads.example.invalid/file", {})).rejects.toThrow(
      /redirect limit/i
    );
    expect(request).toHaveBeenCalledTimes(4);
    await transport.close();
  });

  it("keeps a bounded LRU of pinned agents and closes the least-recently-used agent on eviction", async () => {
    const agents: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const request = vi.fn(async () => new Response("ok"));
    const transport = new PinnedHttpsTransport({
      resolveDns: async () => ["93.184.216.34"],
      request: request as never,
      createAgent: () => {
        const agent = { close: vi.fn(async () => undefined) };
        agents.push(agent);
        return agent as never;
      },
    });
    for (let index = 0; index < 32; index++) {
      const fetched = await transport.fetchWithMetadata(`https://host-${index}.example.invalid/file`, {});
      await fetched.response.body?.cancel();
    }
    const touched = await transport.fetchWithMetadata("https://host-0.example.invalid/file", {});
    await touched.response.body?.cancel();
    const added = await transport.fetchWithMetadata("https://host-32.example.invalid/file", {});
    await added.response.body?.cancel();

    expect(agents).toHaveLength(33);
    expect(agents[0].close).not.toHaveBeenCalled();
    expect(agents[1].close).toHaveBeenCalledOnce();
    await transport.close();
  });
});
