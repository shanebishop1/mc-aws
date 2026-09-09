#!/usr/bin/env node
import { createPrivateKey } from "node:crypto";
import { access, chmod, readFile } from "node:fs/promises";
import { streamSimple as streamOpenAiCompatible } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentHarnessAdapter } from "../../lib/agent/adapters";
import type { AgentCapability, JsonObject, TargetScope, ToolDefinition } from "../../lib/agent/contracts";
import {
  PiHarnessAdapter,
  type PiToolBridge,
  createPiSdkRuntime,
  createSecretAwareEventRedactor,
} from "../../lib/agent/harness/pi";
import { DIRECT_LIVE_TOOL_DEFINITIONS } from "../../lib/agent/tool-definitions";
import { GatewayDownloadRelayServer } from "./download-relay";
import { extensionSystemPrompt, loadInstalledAgentExtensionRegistry } from "./extensions";
import { AgentRuntimeGateway, HttpRuntimeControlTransport } from "./gateway";
import { type GatewayProviderProfile, assertGatewayProfileBinding, parseGatewayConfig } from "./gateway-config";
import { PinnedHttpsTransport } from "./pinned-https";
import {
  assertProtectedConfig,
  providerSystemdCredentialPath,
  readProtectedFile,
  systemdCredentialPath,
} from "./protected-input";
import { ExecutorProtocolClient } from "./protocol";
import { ProviderResponseGuard } from "./provider-response-guard";
import { HttpRuntimeBackupAdapter } from "./runtime-backup";

function scope(kind: TargetScope["kind"], normalizedTarget: string): TargetScope {
  return { schemaVersion: 1, kind, normalizedTarget };
}

function pathArgument(args: JsonObject): string {
  return typeof args.path === "string" ? args.path : typeof args.destination === "string" ? args.destination : ".";
}

function waitForFencePoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function piToolName(toolId: string): string {
  return toolId.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

function targetScopeForCapability(capability: AgentCapability, args: JsonObject): TargetScope {
  if (capability === "shell.execute") {
    if (
      args.mode === "staged-write" &&
      typeof args.change === "object" &&
      args.change !== null &&
      !Array.isArray(args.change)
    ) {
      const pathValue = (args.change as JsonObject).path;
      if (typeof pathValue === "string") return scope("workspace", pathValue);
    }
    return scope("workspace", ".");
  }
  if (
    capability === "workspace.read" ||
    capability === "workspace.write" ||
    capability === "workspace.delete" ||
    capability === "extension.load"
  ) {
    return scope("workspace", pathArgument(args));
  }
  if (capability === "network.outbound") return scope("workspace", pathArgument(args));
  if (capability === "console.execute") return scope("console", "minecraft");
  return scope("workspace", ".");
}

/** Builds Pi bridges from validated mc-aws definitions, including extension aliases. */
export function tools(definitions: readonly ToolDefinition[]): PiToolBridge[] {
  const names = new Set<string>();
  return definitions.map((definition) => {
    const name = piToolName(definition.toolId);
    if (names.has(name)) throw new Error(`Duplicate Pi tool name ${name}.`);
    names.add(name);
    return {
      name,
      definition,
      resolveTargetScope: (args: JsonObject) => targetScopeForCapability(definition.capability, args),
    };
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Gateway accepts no command-line arguments.");
  const configPath = process.env.MC_AGENT_GATEWAY_CONFIG ?? "/etc/mc-agent/world-roots-current/gateway.json";
  await assertProtectedConfig(configPath);
  const config = parseGatewayConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const extensionRegistry = await loadInstalledAgentExtensionRegistry(config.extensions, "/opt/mc-agent/current");
  const runtimeBearer = (await readProtectedFile(systemdCredentialPath("runtime-bearer"), 8192)).trim();
  const privateKeyMaterial = (await readProtectedFile(systemdCredentialPath("gateway-private-key"), 32 * 1024)).trim();
  const privateKey = createPrivateKey(privateKeyMaterial);
  const transport = new PinnedHttpsTransport();
  const profiles = new Map(config.profiles.map((profile) => [profile.profileId, profile]));
  const boundProviderCredentials = new Map<string, string>();
  const configuredProviderCredentials = new Map<string, string>();
  for (const credentialName of config.providerCredentialNames) {
    const credentialPath = providerSystemdCredentialPath(credentialName, config.providerCredentialNames);
    const value = (await readProtectedFile(credentialPath, 32 * 1024)).trim();
    if (value.length < 16 || /\s/.test(value)) throw new Error("Provider credential is invalid.");
    configuredProviderCredentials.set(credentialName, value);
  }
  const runtimeExactSecrets = [runtimeBearer, privateKeyMaterial, ...configuredProviderCredentials.values()];
  const secret = async (profile: GatewayProviderProfile): Promise<string> => {
    const value = configuredProviderCredentials.get(profile.credentialName);
    if (!value) throw new Error("Provider credential is not configured.");
    return value;
  };
  const providers = {
    resolve: async (profileId: string, profileFingerprint: string, model: string) => {
      const profile = profiles.get(profileId);
      if (!profile) throw new Error("Provider profile is not configured for this model.");
      await assertGatewayProfileBinding(profile, profileId, profileFingerprint, model);
      const credential = await secret(profile);
      boundProviderCredentials.set(`${profileId}\0${model}`, credential);
      return {
        configuration: {
          schemaVersion: 1 as const,
          profileId,
          providerId: profile.providerId,
          model,
          credentialRef: `systemd-credential:${profile.credentialName}`,
          timeoutMs: profile.timeoutMs,
        },
        exactSecrets: runtimeExactSecrets,
      };
    },
  };
  // Workspace extension.load remains unavailable: production bundles are loaded
  // only from the fixed release source above, never from an agent path.
  const bridges = tools([
    ...DIRECT_LIVE_TOOL_DEFINITIONS.filter((definition) => definition.toolId !== "extension.load"),
    ...extensionRegistry.tools,
  ]);
  const harnesses = {
    create: ({
      toolExecutor,
      exactSecrets,
    }: Parameters<import("./gateway").RuntimeHarnessFactory["create"]>[0]): AgentHarnessAdapter => {
      const providerResponseGuard = new ProviderResponseGuard({ fetch: transport.fetch });
      const runtime = createPiSdkRuntime({
        cwd: "/var/lib/mc-agent-gateway/work",
        agentDir: "/var/lib/mc-agent-gateway/pi",
        systemPrompt: extensionSystemPrompt(extensionRegistry),
        resolveSessionConfiguration: async ({ providerProfileId, model }) => {
          const profile = profiles.get(providerProfileId);
          if (!profile || !profile.allowedModels.includes(model))
            throw new Error("Pinned Pi provider profile is unavailable.");
          const credential = boundProviderCredentials.get(`${providerProfileId}\0${model}`);
          if (!credential) throw new Error("Pinned Pi provider credential was not bound by runtime work.");
          const modelRuntime = await ModelRuntime.create({
            allowModelNetwork: false,
            refreshOnCreate: false,
            modelsPath: null,
          });
          modelRuntime.registerProvider(profile.providerId, {
            name: profile.providerId,
            baseUrl: profile.endpoint,
            api: "openai-completions",
            apiKey: credential,
            streamSimple: (selected, context, options) =>
              streamOpenAiCompatible(selected as never, context, {
                ...options,
                apiKey: credential,
                fetch: providerResponseGuard.fetch,
                transport: "sse",
                maxRetries: 0,
                timeoutMs: profile.timeoutMs,
              }),
            models: profile.allowedModels.map((id) => ({
              id,
              name: id,
              api: "openai-completions",
              baseUrl: profile.endpoint,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: profile.contextWindow,
              maxTokens: profile.maxTokens,
            })),
          });
          const selected = modelRuntime.getModel(profile.providerId, model);
          if (!selected) throw new Error("Pinned Pi model was not registered.");
          return { model: selected, modelRuntime };
        },
      });
      return new PiHarnessAdapter({
        runtime,
        toolExecutor,
        tools: bridges,
        eventRedactor: createSecretAwareEventRedactor({ exactSecrets }),
        providerResponseLimitSignal: providerResponseGuard.signal,
      });
    },
  };
  const downloadRelay = new GatewayDownloadRelayServer({
    socketPath: config.downloadSocketPath,
    gatewayPrivateKey: privateKey,
    transport,
  });
  await downloadRelay.listen();
  await chmod(config.downloadSocketPath, 0o660);
  const gateway = new AgentRuntimeGateway({
    persistentWorldRoots: config.persistentWorldRoots,
    control: new HttpRuntimeControlTransport({ baseUrl: config.controlBaseUrl, runtimeBearer, fetch: transport.fetch }),
    executor: new ExecutorProtocolClient({
      socketPath: config.socketPath,
      gatewayPrivateKey: privateKey,
      downloadRelay,
      reconciliationStatePath: "/var/lib/mc-agent-gateway/executor-reconciliations.json",
    }),
    backup: new HttpRuntimeBackupAdapter({
      baseUrl: config.controlBaseUrl,
      runtimeBearer,
      transport,
      backupPath: config.backupPath,
    }),
    providers,
    harnesses,
    extensionHooks: extensionRegistry.hooks,
    runtimeExactSecrets,
  });
  const controller = new AbortController();
  const maintenanceFence = process.env.MC_AGENT_MAINTENANCE_FENCE ?? "/run/mc-agent/maintenance-state.json";
  let drainRequested = false;
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  process.once("SIGUSR1", () => {
    drainRequested = true;
  });
  try {
    while (!controller.signal.aborted && !drainRequested) {
      const fenced = await access(maintenanceFence).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw new Error("Runtime maintenance fence could not be inspected.");
        }
      );
      if (fenced) {
        await waitForFencePoll();
        continue;
      }
      await gateway.runOnce(controller.signal);
    }
  } finally {
    await downloadRelay.close();
    await transport.close();
  }
}

main().catch(() => {
  process.stderr.write("mc-agent gateway failed closed.\n");
  process.exitCode = 1;
});
