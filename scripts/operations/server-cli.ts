/**
 * CLI Script for Minecraft Server Management
 * Calls API endpoints to manage the server state
 */

import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import type {
  ApiResponse,
  BackupResponse,
  HibernateResponse,
  ListBackupsResponse,
  RestoreResponse,
  ResumeResponse,
  ServerStatusResponse,
  StartServerResponse,
  StopServerResponse,
} from "../../lib/types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
type Environment = Record<string, string | undefined>;

export function loadServerCliEnvironment(environment: Environment = process.env): void {
  for (const file of [".env.production", ".env.local"]) {
    loadDotenv({
      path: path.resolve(file),
      override: false,
      quiet: true,
      processEnv: environment as Record<string, string>,
    });
  }
}

export function resolveApiBase(environment: Environment = process.env): URL {
  const configured = environment.API_BASE?.trim();
  const appUrl = environment.NEXT_PUBLIC_APP_URL?.trim();
  const candidate = configured || (appUrl ? `${appUrl.replace(/\/$/, "")}/api` : "http://localhost:3000/api");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("API_BASE or NEXT_PUBLIC_APP_URL is not a valid absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Server CLI API URL must not contain credentials, a query, or a fragment");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && url.protocol !== "https:") {
    throw new Error("Remote server CLI requests require HTTPS");
  }
  return url;
}

function remoteSessionCookie(apiBase: URL, environment: Environment = process.env): string | undefined {
  if (LOOPBACK_HOSTS.has(apiBase.hostname)) return undefined;
  const configuredPath = environment.MC_SERVER_CLI_SESSION_COOKIE_FILE?.trim();
  if (!configuredPath) {
    throw new Error(
      "Remote API calls require MC_SERVER_CLI_SESSION_COOKIE_FILE pointing to a current-user-owned 0600 file containing the mc_session token"
    );
  }
  const cookiePath = path.resolve(configuredPath);
  const linkStatus = lstatSync(cookiePath);
  const status = statSync(cookiePath);
  if (
    linkStatus.isSymbolicLink() ||
    !linkStatus.isFile() ||
    status.nlink !== 1 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    (status.mode & 0o777) !== 0o600
  ) {
    throw new Error("Server CLI session token file must be one current-user-owned 0600 regular file");
  }
  const raw = readFileSync(cookiePath, "utf8").trim();
  const token = raw.startsWith("mc_session=") ? raw.slice("mc_session=".length) : raw;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Server CLI session token file does not contain one valid mc_session token");
  }
  return `mc_session=${token}`;
}

export async function callApi<T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
  environment: Environment = process.env
): Promise<ApiResponse<T>> {
  const apiBase = resolveApiBase(environment);
  const url = new URL(`${apiBase.pathname.replace(/\/$/, "")}${endpoint}`, apiBase);
  const cookie = remoteSessionCookie(apiBase, environment);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as ApiResponse<T>;

    if (!response.ok) {
      throw new Error(data.error || `API returned HTTP ${response.status}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "fetch failed") {
        throw new Error(`Could not reach server API at ${url.origin}; verify the configured panel URL and network`);
      }
      throw error;
    }
    throw new Error("An unknown error occurred");
  }
}

function logSuccess(message: string, data?: unknown) {
  console.log(`✅ ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function logError(message: string) {
  console.error(`❌ Error: ${message}`);
}

async function handleStatus() {
  const res = await callApi<ServerStatusResponse>("/status");
  if (res.success && res.data) {
    console.log("\n--- Server Status ---");
    console.log(`State:      ${res.data.state}`);
    console.log(`Instance:   ${res.data.instanceId}`);
    console.log(`Domain:     ${res.data.domain || "N/A"}`);
    console.log(`Volume:     ${res.data.hasVolume ? "Attached" : "Detached"}`);
    console.log(`Updated:    ${res.data.lastUpdated}`);
    console.log("---------------------\n");
  }
}

async function handleStart() {
  console.log("🚀 Starting server...");
  const res = await callApi<StartServerResponse>("/start", "POST");
  logSuccess(res.data?.message || "Server start initiated", res.data);
}

async function handleStop() {
  console.log("🛑 Stopping server...");
  const res = await callApi<StopServerResponse>("/stop", "POST");
  logSuccess(res.data?.message || "Server stop initiated", res.data);
}

async function handleHibernate() {
  console.log("😴 Hibernating server (backup + stop + delete volume)...");
  const res = await callApi<HibernateResponse>("/hibernate", "POST");
  logSuccess(res.data?.message || "Hibernation initiated", res.data);
}

async function handleResume(param?: string) {
  console.log("🌅 Resuming server...");
  const res = await callApi<ResumeResponse>("/resume", "POST", param ? { backupName: param } : {});
  logSuccess(res.data?.message || "Resume initiated", res.data);
}

async function handleBackup() {
  console.log("💾 Creating backup...");
  const res = await callApi<BackupResponse>("/backup", "POST");
  logSuccess(res.data?.message || "Backup completed", res.data);
}

async function handleRestore(param?: string) {
  if (!param) {
    logError("Backup name is required for restore. Use 'backups' to see available backups.");
    process.exit(1);
  }
  console.log(`🔄 Restoring from backup: ${param}...`);
  const res = await callApi<RestoreResponse>("/restore", "POST", { name: param });
  logSuccess(res.data?.message || "Restore completed", res.data);
}

async function handleBackups() {
  const res = await callApi<ListBackupsResponse>("/backups");
  if (res.success && res.data) {
    console.log(`\nAvailable Backups (${res.data.count}):`);
    for (const b of res.data.backups) {
      const dateStr = b.date ? ` (${b.date})` : "";
      const sizeStr = b.size ? ` [${b.size}]` : "";
      console.log(`- ${b.name}${dateStr}${sizeStr}`);
    }
    console.log("");
  }
}

async function main() {
  loadServerCliEnvironment();
  const args = process.argv.slice(2);
  const command = args[0];
  const param = args[1];

  if (!command) {
    console.log("Usage: server-cli <command> [param]");
    console.log("Commands: status, start, stop, hibernate, resume, backup, restore, backups");
    process.exit(1);
  }

  try {
    switch (command) {
      case "status":
        await handleStatus();
        break;
      case "start":
        await handleStart();
        break;
      case "stop":
        await handleStop();
        break;
      case "hibernate":
        await handleHibernate();
        break;
      case "resume":
        await handleResume(param);
        break;
      case "backup":
        await handleBackup();
        break;
      case "restore":
        await handleRestore(param);
        break;
      case "backups":
        await handleBackups();
        break;
      default:
        logError(`Unknown command: ${command}`);
        console.log("Available commands: status, start, stop, hibernate, resume, backup, restore, backups");
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      logError(error.message);
    } else {
      logError("An unknown error occurred");
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
