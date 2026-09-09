#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDirectLiveExecutor } from "../../lib/agent/executor/executor";
import type { DirectLiveExecutor } from "../../lib/agent/executor/types";
import { canonicalPersistentWorldRoots } from "../../lib/agent/minecraft-security";
import { GatewayDownloadRelayClient } from "./download-relay";
import { loadInstalledAgentExtensionRegistry } from "./extensions";
import { parseGatewayConfig } from "./gateway-config";
import { ProductionDirectLiveHostEffects } from "./live-host-effects";
import { assertProtectedConfig, readExecutorProtectedCredentials } from "./protected-input";
import { ExecutorProtocolServer, systemdSocketActivationFd } from "./protocol";

interface ExecutorConfig {
  schemaVersion: 1;
  socketPath: string;
  downloadSocketPath: string;
  gatewayPublicKeyPath: string;
  backupFencePublicKeyPath: string;
  journalCredentialName: "executor-journal-hmac";
  receiptCredentialName: "executor-receipt-private";
  cleanStartEpochCredentialName: "executor-clean-start-epoch";
  receiptKeyIdPath: "/config/executor-receipt-key-id";
  receiptKeyEpochPath: "/config/executor-receipt-key-epoch";
  statePath: "/scratch/executor-effect-journal.json";
  workspaceRoot: "/workspace";
  scratchRoot: "/scratch";
  persistentWorldRoots: string[];
  shellReadSocketPath: "/run/mc-agent/shell-read.sock";
  shellWriteSocketPath: "/run/mc-agent/shell-write.sock";
  hostBrokerSocketPath: "/run/mc-agent/host-broker.sock";
}

function parseConfig(value: unknown): ExecutorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Executor configuration is invalid.");
  const item = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "socketPath",
    "downloadSocketPath",
    "gatewayPublicKeyPath",
    "backupFencePublicKeyPath",
    "journalCredentialName",
    "receiptCredentialName",
    "cleanStartEpochCredentialName",
    "receiptKeyIdPath",
    "receiptKeyEpochPath",
    "statePath",
    "workspaceRoot",
    "scratchRoot",
    "persistentWorldRoots",
    "shellReadSocketPath",
    "shellWriteSocketPath",
    "hostBrokerSocketPath",
  ];
  if (
    Object.keys(item).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in item)) ||
    item.schemaVersion !== 1
  ) {
    throw new Error("Executor configuration schema is invalid.");
  }
  if (
    typeof item.socketPath !== "string" ||
    item.socketPath !== "/run/mc-agent/executor.sock" ||
    item.downloadSocketPath !== "/run/mc-agent-download/download.sock" ||
    item.gatewayPublicKeyPath !== "/config/gateway-public.pem" ||
    item.backupFencePublicKeyPath !== "/config/backup-fence-public.pem" ||
    item.journalCredentialName !== "executor-journal-hmac" ||
    item.receiptCredentialName !== "executor-receipt-private" ||
    item.cleanStartEpochCredentialName !== "executor-clean-start-epoch" ||
    item.receiptKeyIdPath !== "/config/executor-receipt-key-id" ||
    item.receiptKeyEpochPath !== "/config/executor-receipt-key-epoch" ||
    item.statePath !== "/scratch/executor-effect-journal.json" ||
    item.workspaceRoot !== "/workspace" ||
    item.scratchRoot !== "/scratch" ||
    !Array.isArray(item.persistentWorldRoots) ||
    item.shellReadSocketPath !== "/run/mc-agent/shell-read.sock" ||
    item.shellWriteSocketPath !== "/run/mc-agent/shell-write.sock" ||
    item.hostBrokerSocketPath !== "/run/mc-agent/host-broker.sock"
  ) {
    throw new Error("Executor configuration paths are invalid.");
  }
  return {
    ...item,
    persistentWorldRoots: [...canonicalPersistentWorldRoots(item.persistentWorldRoots as string[])],
  } as unknown as ExecutorConfig;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Executor accepts no command-line arguments.");
  const configPath = process.env.MC_AGENT_EXECUTOR_CONFIG ?? "/config/executor.json";
  await assertProtectedConfig(configPath);
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const gatewayConfig = parseGatewayConfig(JSON.parse(await readFile("/config/gateway.json", "utf8")) as unknown);
  const extensionRegistry = await loadInstalledAgentExtensionRegistry(gatewayConfig.extensions, "/runtime/current");
  const publicKey = createPublicKey(await readFile(config.gatewayPublicKeyPath));
  const backupFencePublicKey = createPublicKey(await readFile(config.backupFencePublicKeyPath));
  // LoadCredential is visible until the executor sandbox is asserted. Read and validate the exact
  // journal, receipt-signing, and epoch credentials first; no other credential is permitted.
  const credentials = await readExecutorProtectedCredentials();
  const receiptPrivateKey = createPrivateKey(credentials.receiptPrivateKey.value);
  credentials.receiptPrivateKey.value.fill(0);
  const publicDer = createPublicKey(receiptPrivateKey).export({ type: "spki", format: "der" });
  const derivedKeyId = `executor-receipt-${createHash("sha256").update(publicDer).digest("hex")}`;
  const configuredKeyId = (await readFile(config.receiptKeyIdPath, "utf8")).trim();
  if (configuredKeyId !== derivedKeyId) throw new Error("Executor receipt key ID does not match its private key.");
  const configuredKeyEpoch = Number((await readFile(config.receiptKeyEpochPath, "utf8")).trim());
  if (!Number.isSafeInteger(configuredKeyEpoch) || configuredKeyEpoch < 1) {
    throw new Error("Executor receipt key epoch is invalid.");
  }
  const executorEpoch = `epoch-${credentials.cleanStartEpoch.value.toString("base64url")}`;
  credentials.cleanStartEpoch.value.fill(0);
  const effects = await ProductionDirectLiveHostEffects.create(
    new GatewayDownloadRelayClient({ socketPath: config.downloadSocketPath, gatewayPublicKey: publicKey }),
    {
      journalCredentialPath: credentials.journal.path,
      worldRootTransactionAuthenticationKey: credentials.journal.value,
      shellReadSocketPath: config.shellReadSocketPath,
      shellWriteSocketPath: config.shellWriteSocketPath,
      hostBrokerSocketPath: config.hostBrokerSocketPath,
    }
  );
  const executor = createDirectLiveExecutor(effects, {
    workspaceRoot: config.workspaceRoot,
    scratchRoot: config.scratchRoot,
    persistentWorldRoots: config.persistentWorldRoots,
    acceptGatewayAuthorizations: true,
    requireDownloadAuthorization: true,
    externalBackupCoordinator: true,
    extensionTools: extensionRegistry.tools,
  });
  const scratchAware: DirectLiveExecutor = {
    execute: async (request) => {
      await effects.ensureSessionScratch(request.invocation.sessionId);
      return await executor.execute(request);
    },
  };
  const server = new ExecutorProtocolServer({
    socketPath: config.socketPath,
    listenFd: systemdSocketActivationFd("executor"),
    gatewayPublicKey: publicKey,
    backupFencePublicKey,
    executor: scratchAware,
    statePath: config.statePath,
    journalAuthenticationKey: credentials.journal.value,
    executorReceiptPrivateKey: receiptPrivateKey,
    executorReceiptKeyId: configuredKeyId,
    executorReceiptKeyEpoch: configuredKeyEpoch,
    executorEpoch,
  });
  credentials.journal.value.fill(0);
  process.umask(0o007);
  await server.listen();
  const stop = async () => {
    await server.close();
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

main().catch(() => {
  process.stderr.write("mc-agent executor failed closed.\n");
  process.exitCode = 1;
});
