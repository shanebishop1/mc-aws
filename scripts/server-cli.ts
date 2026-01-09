/**
 * CLI Script for Minecraft Server Management
 * Calls API endpoints to manage the server state
 */

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
} from "../lib/types";

const API_BASE = process.env.API_BASE || "http://localhost:3000/api";

async function callApi<T>(endpoint: string, method = "GET", body?: unknown): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${endpoint}`;
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP error! status: ${response.status}`);
    }

    return data;
  } catch (error) {
    if (error instanceof Error) {
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
    console.log(`IP:         ${res.data.publicIp || "N/A"}`);
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

main();
