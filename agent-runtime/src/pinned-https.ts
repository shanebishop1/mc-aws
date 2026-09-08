import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { normalizeNetworkDownloadUrl } from "../../lib/agent/network-download";
import { validateProviderEndpoint } from "../../lib/agent/providers/endpoint-security";
import type { RelayFetchResult } from "./download-relay";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_AGENTS = 32;
const MAX_VALIDATED_ADDRESSES = 16;

type UndiciFetch = typeof undiciFetch;

export interface PinnedHttpsTransportOptions {
  resolveDns?: (hostname: string) => Promise<readonly string[]>;
  request?: UndiciFetch;
  createAgent?: (options: ConstructorParameters<typeof Agent>[0]) => Agent;
}

export class PinnedHttpsTransport {
  private readonly agents = new Map<string, Agent>();
  private readonly pendingClosures = new Set<Promise<void>>();
  private readonly request: UndiciFetch;
  private readonly createAgent: (options: ConstructorParameters<typeof Agent>[0]) => Agent;
  readonly resolveDns: (hostname: string) => Promise<readonly string[]>;

  constructor(options: PinnedHttpsTransportOptions = {}) {
    this.resolveDns =
      options.resolveDns ??
      (async (hostname: string): Promise<readonly string[]> => {
        const answers = await lookup(hostname, { all: true, verbatim: true });
        return answers.map(({ address }) => address);
      });
    this.request = options.request ?? undiciFetch;
    this.createAgent = options.createAgent ?? ((agentOptions) => new Agent(agentOptions));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (input instanceof Request)
      throw new TypeError("Pinned transport requires an explicit URL and bounded request init.");
    return (await this.fetchWithMetadata(input instanceof URL ? input : String(input), init ?? {})).response;
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Redirect handling keeps URL, DNS, pinning, and response disposal in one fail-closed loop.
  async fetchWithMetadata(input: string | URL, init: RequestInit): Promise<RelayFetchResult> {
    let url = normalizeNetworkDownloadUrl(String(input));
    const initialResource = url.toString();
    const initialOrigin = url.origin;
    const method = (init?.method ?? "GET").toUpperCase();

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const validated = await validateProviderEndpoint(url, this.resolveDns, { providerId: "production-https" });
      if (validated.addresses.length > MAX_VALIDATED_ADDRESSES) {
        throw new Error("Pinned HTTPS address bound exceeded.");
      }
      const dispatcher = this.agent(url.hostname, validated.addresses);
      const response = (await this.request(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        method,
        redirect: "manual",
        dispatcher,
      })) as unknown as Response;
      if (!REDIRECTS.has(response.status)) {
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error("Pinned HTTPS transport rejected an unsafe redirect.");
        }
        return { response, finalUrl: url };
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Pinned HTTPS redirect limit exceeded.");
      const next = new URL(location, url);
      if (next.origin !== initialOrigin || next.username || next.password || next.protocol !== "https:") {
        throw new Error("Pinned HTTPS transport rejected a cross-origin redirect.");
      }
      const normalizedNext = normalizeNetworkDownloadUrl(next.toString());
      if (normalizedNext.toString() !== initialResource) {
        throw new Error("Pinned HTTPS transport rejected a different-resource redirect.");
      }
      url = normalizedNext;
    }
    throw new Error("Pinned HTTPS transport failed closed.");
  }

  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map(async (agent) => await agent.close()));
    this.agents.clear();
    await Promise.all(this.pendingClosures);
  }

  private agent(hostname: string, addresses: readonly [string, ...string[]]): Agent {
    const key = `${hostname}|${addresses.join(",")}`;
    const existing = this.agents.get(key);
    if (existing) {
      this.agents.delete(key);
      this.agents.set(key, existing);
      return existing;
    }
    if (this.agents.size >= MAX_AGENTS) {
      const oldestKey = this.agents.keys().next().value as string | undefined;
      const oldest = oldestKey === undefined ? undefined : this.agents.get(oldestKey);
      if (oldestKey !== undefined) this.agents.delete(oldestKey);
      if (oldest) {
        const closing = oldest
          .close()
          .catch(() => undefined)
          .finally(() => this.pendingClosures.delete(closing));
        this.pendingClosures.add(closing);
      }
    }
    let next = 0;
    const agent = this.createAgent({
      connect: {
        servername: hostname,
        lookup: (_hostname, options, callback) => {
          const compatible = addresses.filter((address) => !options.family || isIP(address) === options.family);
          if (compatible.length === 0)
            return callback(new Error("No validated address matches the requested family."), "");
          if (options.all) {
            callback(
              null,
              compatible.map((address) => ({ address, family: isIP(address) }))
            );
            return;
          }
          const address = compatible[next++ % compatible.length];
          callback(null, address, isIP(address));
        },
      },
    });
    this.agents.set(key, agent);
    return agent;
  }
}
