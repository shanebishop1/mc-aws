import { canonicalJson } from "@/lib/agent/canonical-json";
import {
  AGENT_SCHEMA_VERSION,
  type AgentCapability,
  type JsonObject,
  type SideEffectClass,
  type ToolDefinition,
} from "@/lib/agent/contracts";

const OBJECT_SCHEMA = { type: "object", additionalProperties: true } as JsonObject;

/**
 * The only capabilities which a live executor exposes to a harness.  Extension
 * tools may alias one of these definitions, but they cannot invent a new input
 * contract or side-effect class.
 */
export const DIRECT_LIVE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "workspace.read",
    displayName: "Read workspace file",
    description: "Read one bounded regular file from the mounted Minecraft workspace.",
    capability: "workspace.read",
    sideEffect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" }, maxBytes: { type: "integer", minimum: 1 } },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "workspace.write",
    displayName: "Write workspace file",
    description: "Write bounded text atomically inside the mounted Minecraft workspace.",
    capability: "workspace.write",
    sideEffect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "workspace.delete",
    displayName: "Delete workspace entry",
    description: "Delete one workspace entry, with recursive deletion explicitly requested for directories.",
    capability: "workspace.delete",
    sideEffect: "delete",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "shell.execute",
    displayName: "Execute workspace command",
    description: "Run the reviewed workspace command boundary with bounded arguments and output.",
    capability: "shell.execute",
    sideEffect: "execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "command", "timeoutMs"],
      properties: {
        mode: { type: "string", enum: ["read-only", "staged-write"] },
        command: { type: "string", minLength: 1, maxLength: 16384 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
        change: {
          type: "object",
          additionalProperties: false,
          required: ["operation", "path"],
          properties: {
            operation: { type: "string", enum: ["replace", "delete"] },
            path: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "console.execute",
    displayName: "Execute Minecraft console command",
    description: "Send one bounded command through the credential-less Minecraft console bridge.",
    capability: "console.execute",
    sideEffect: "execute",
    inputSchema: OBJECT_SCHEMA,
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "network.download",
    displayName: "Download verified resource",
    description: "Download one operator-identified HTTPS resource into the workspace.",
    capability: "network.outbound",
    sideEffect: "network",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url", "destination", "timeoutMs", "maxBytes", "expectedSha256", "expectedBytes"],
      properties: {
        url: { type: "string", pattern: "^https://" },
        destination: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
        maxBytes: { type: "integer", minimum: 1 },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expectedBytes: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "backup.request",
    displayName: "Request backup",
    description: "Request the gateway-coordinated backup gate for the current invocation.",
    capability: "backup.create",
    sideEffect: "backup",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" } },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "extension.load",
    displayName: "Load reviewed extension bundle",
    description: "Load one explicitly enabled reviewed data-only bundle from the installed runtime.",
    capability: "extension.load",
    sideEffect: "extension",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
  },
  {
    schemaVersion: AGENT_SCHEMA_VERSION,
    toolId: "maintenance.apply",
    displayName: "Apply restart-required Minecraft setting",
    description:
      "Stop the same installation, take the required backup, apply one approved server.properties setting, restart it, and independently observe protocol readiness.",
    capability: "maintenance.apply",
    sideEffect: "execute",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "path",
        "key",
        "value",
        "expectedSha256",
        "expectedBytes",
        "resultSha256",
        "resultBytes",
        "serviceIntent",
        "expectedProtocol",
      ],
      properties: {
        path: { type: "string", const: "server.properties" },
        key: { type: "string", enum: ["motd"] },
        value: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\u0000-\\u001f\\u007f]+$" },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        expectedBytes: { type: "integer", minimum: 1, maximum: 1048576 },
        resultSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        resultBytes: { type: "integer", minimum: 1, maximum: 1048576 },
        serviceIntent: { type: "string", const: "restore-prior" },
        expectedProtocol: {
          type: "object",
          additionalProperties: false,
          required: ["schemaVersion", "host", "port", "motd"],
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            host: { type: "string", const: "127.0.0.1" },
            port: { type: "integer", const: 25565 },
            motd: { type: "string" },
          },
        },
      },
    },
  },
] as ToolDefinition[]);

const BY_CAPABILITY = new Map<AgentCapability, ToolDefinition>(
  DIRECT_LIVE_TOOL_DEFINITIONS.map((definition) => [definition.capability, definition])
);

export function existingToolDefinitionForCapability(capability: AgentCapability): ToolDefinition {
  const definition = BY_CAPABILITY.get(capability);
  if (!definition) throw new Error(`No live tool definition exists for capability ${capability}.`);
  return definition;
}

export function extensionToolMatchesExistingCapability(definition: ToolDefinition): boolean {
  const existing = existingToolDefinitionForCapability(definition.capability);
  return (
    definition.sideEffect === existing.sideEffect &&
    canonicalJson(definition.inputSchema) === canonicalJson(existing.inputSchema)
  );
}

export function sideEffectForCapability(capability: AgentCapability): SideEffectClass {
  return existingToolDefinitionForCapability(capability).sideEffect;
}
