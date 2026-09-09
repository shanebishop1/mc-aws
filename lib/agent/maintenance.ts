import type { BackupFenceAuthorization, JsonObject } from "@/lib/agent/contracts";

export const MAINTENANCE_CONFIG_PATH = "server.properties" as const;
export const MAINTENANCE_SERVICE_INTENT = "restore-prior" as const;
export const MAINTENANCE_PROTOCOL_HOST = "127.0.0.1" as const;
export const MAINTENANCE_PROTOCOL_PORT = 25565 as const;

/** The first supported operation has a command-specific loopback observer. */
export const MAINTENANCE_CONFIG_KEYS = ["motd"] as const;
export type MaintenanceConfigKey = (typeof MAINTENANCE_CONFIG_KEYS)[number];

export interface MaintenanceInvocationIdentity {
  schemaVersion: 1;
  runtimeId: string;
  leaseId: string;
  leaseGeneration: number;
  taskId: string;
  sessionId: string;
  invocationId: string;
  invocationDigest: string;
}

export interface ExpectedProtocolObservable {
  schemaVersion: 1;
  host: typeof MAINTENANCE_PROTOCOL_HOST;
  port: typeof MAINTENANCE_PROTOCOL_PORT;
  motd: string;
}

export interface MaintenanceApplyRequest {
  schemaVersion: 1;
  operation: "maintenance.apply";
  invocation: MaintenanceInvocationIdentity;
  /** The root broker re-verifies this current signed authorization at commit. */
  backup: BackupFenceAuthorization;
  config: {
    schemaVersion: 1;
    path: typeof MAINTENANCE_CONFIG_PATH;
    key: MaintenanceConfigKey;
    value: string;
    expectedSha256: string;
    expectedBytes: number;
    resultSha256: string;
    resultBytes: number;
  };
  serviceIntent: typeof MAINTENANCE_SERVICE_INTENT;
  expectedProtocol: ExpectedProtocolObservable;
}

export interface ConsoleBridgeRequest {
  schemaVersion: 1;
  operation: "console.execute";
  invocation: MaintenanceInvocationIdentity;
  command: string;
  timeoutMs: number;
}

export type HostBrokerRequest = MaintenanceApplyRequest | ConsoleBridgeRequest;

export function parseMaintenanceApplyArguments(
  value: JsonObject
): Omit<MaintenanceApplyRequest, "schemaVersion" | "operation" | "invocation" | "backup"> {
  const allowed = new Set([
    "path",
    "key",
    "value",
    "expectedSha256",
    "expectedBytes",
    "resultSha256",
    "resultBytes",
    "serviceIntent",
    "expectedProtocol",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown maintenance.apply argument: ${key}`);
  const expectedSha256 = value.expectedSha256;
  const expectedBytes = value.expectedBytes;
  const resultSha256 = value.resultSha256;
  const resultBytes = value.resultBytes;
  if (
    value.path !== MAINTENANCE_CONFIG_PATH ||
    typeof value.key !== "string" ||
    !MAINTENANCE_CONFIG_KEYS.includes(value.key as MaintenanceConfigKey) ||
    typeof value.value !== "string" ||
    value.value.length === 0 ||
    value.value.length > 1024 ||
    value.value.trim() !== value.value ||
    [...value.value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    }) ||
    typeof expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    typeof expectedBytes !== "number" ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > 1024 * 1024 ||
    typeof resultSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(resultSha256) ||
    typeof resultBytes !== "number" ||
    !Number.isSafeInteger(resultBytes) ||
    resultBytes < 1 ||
    resultBytes > 1024 * 1024 ||
    value.serviceIntent !== MAINTENANCE_SERVICE_INTENT
  )
    throw new Error("maintenance.apply arguments are invalid.");
  const expectedProtocol = value.expectedProtocol;
  if (
    expectedProtocol === null ||
    typeof expectedProtocol !== "object" ||
    Array.isArray(expectedProtocol) ||
    Object.keys(expectedProtocol as JsonObject)
      .sort()
      .join(",") !== "host,motd,port,schemaVersion" ||
    (expectedProtocol as JsonObject).schemaVersion !== 1 ||
    (expectedProtocol as JsonObject).host !== MAINTENANCE_PROTOCOL_HOST ||
    (expectedProtocol as JsonObject).port !== MAINTENANCE_PROTOCOL_PORT ||
    (expectedProtocol as JsonObject).motd !== value.value
  )
    throw new Error("maintenance.apply expectedProtocol is invalid.");
  return {
    config: {
      schemaVersion: 1,
      path: MAINTENANCE_CONFIG_PATH,
      key: value.key as MaintenanceConfigKey,
      value: value.value,
      expectedSha256,
      expectedBytes,
      resultSha256,
      resultBytes,
    },
    serviceIntent: MAINTENANCE_SERVICE_INTENT,
    expectedProtocol: expectedProtocol as unknown as ExpectedProtocolObservable,
  };
}
