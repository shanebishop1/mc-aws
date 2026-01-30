#!/usr/bin/env node
/**
 * Mock Mode CLI Tool
 *
 * Provides convenient commands for managing mock mode scenarios and state.
 * Usage:
 *   pnpm mock:reset              - Reset mock state to defaults
 *   pnpm mock:scenario           - List available scenarios
 *   pnpm mock:scenario <name>    - Apply a specific scenario
 */

import { applyScenario, getAvailableScenarios, getCurrentScenario } from "@/lib/aws/mock-scenarios";
import { resetToDefaultScenario } from "@/lib/aws/mock-scenarios";
import { getMockStateStore } from "@/lib/aws/mock-state-store";

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof colors = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message: string): void {
  log(`Error: ${message}`, "red");
}

function success(message: string): void {
  log(message, "green");
}

function info(message: string): void {
  log(message, "cyan");
}

function printUsage(): void {
  log("\nMock Mode CLI - Manage mock scenarios and state\n", "bright");
  log("Usage:", "yellow");
  log("  pnpm mock:reset              Reset mock state to defaults");
  log("  pnpm mock:scenario           List available scenarios");
  log("  pnpm mock:scenario <name>    Apply a specific scenario\n");
  log("Examples:", "yellow");
  log("  pnpm mock:scenario running   Apply the 'running' scenario");
  log("  pnpm mock:scenario errors    Apply the 'errors' scenario");
  log("  pnpm mock:reset              Reset to default state\n");
}

async function listScenarios(): Promise<void> {
  log("\nAvailable Scenarios:\n", "bright");

  const scenarios = getAvailableScenarios();
  const currentScenario = await getCurrentScenario();

  for (const scenario of scenarios) {
    const isCurrent = scenario.name === currentScenario;
    const prefix = isCurrent ? "→ " : "  ";
    const color = isCurrent ? "green" : "reset";
    log(`${prefix}${scenario.name.padEnd(20)} ${scenario.description}`, color);
  }

  log("");
}

async function applyScenarioByName(name: string): Promise<void> {
  try {
    info(`Applying scenario: ${name}`);
    await applyScenario(name);
    success(`Scenario "${name}" applied successfully!`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    process.exit(1);
  }
}

async function resetState(): Promise<void> {
  try {
    info("Resetting mock state to defaults...");
    await resetToDefaultScenario();
    success("Mock state reset successfully!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    process.exit(1);
  }
}

async function showCurrentState(): Promise<void> {
  try {
    const stateStore = getMockStateStore();
    const state = await stateStore.getState();
    const currentScenario = await getCurrentScenario();

    log("\nCurrent Mock State:\n", "bright");

    // Instance state
    log("Instance:", "yellow");
    log(`  State: ${state.instance.state}`);
    log(`  Public IP: ${state.instance.publicIp || "N/A"}`);
    log(`  Has Volume: ${state.instance.hasVolume ? "Yes" : "No"}`);

    // Scenario
    log("\nScenario:", "yellow");
    log(`  Current: ${currentScenario || "None (default)"}`);

    // Backups
    log("\nBackups:", "yellow");
    if (state.backups.length === 0) {
      log("  No backups available");
    } else {
      state.backups.forEach((backup) => {
        log(`  - ${backup.name} (${backup.date})`);
      });
    }

    // SSM Parameters
    log("\nSSM Parameters:", "yellow");
    const params = Object.entries(state.ssm.parameters);
    if (params.length === 0) {
      log("  No parameters set");
    } else {
      params.forEach(([name, param]) => {
        log(`  - ${name}: ${param.value} (${param.type})`);
      });
    }

    // Faults
    log("\nFault Injection:", "yellow");
    const faults = Array.from(state.faults.operationFailures.entries());
    if (faults.length === 0) {
      log("  No faults configured");
    } else {
      faults.forEach(([operation, fault]) => {
        const status = fault.alwaysFail ? "Always Fail" : fault.failNext ? "Fail Next" : "No Fail";
        log(`  - ${operation}: ${status}`);
        if (fault.errorMessage) {
          log(`    Error: ${fault.errorMessage}`);
        }
      });
    }

    log("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case "reset":
      await resetState();
      break;

    case "scenario": {
      const scenarioName = args[1];
      if (!scenarioName) {
        await listScenarios();
      } else {
        await applyScenarioByName(scenarioName);
      }
      break;
    }

    case "state":
      await showCurrentState();
      break;

    default:
      error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
