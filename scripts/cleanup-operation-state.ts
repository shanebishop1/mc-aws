import {
  cleanupExpiredDurableOperationStates,
  getDurableOperationStateRetentionMs,
} from "@/lib/durable-operation-state";

const oneDayMs = 24 * 60 * 60 * 1000;

interface CliOptions {
  dryRun: boolean;
  retentionDays?: number;
  maxDeletions?: number;
}

function parsePositiveIntegerFlag(flag: string, value: string | undefined): number {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer. Received: ${value}`);
  }

  return parsed;
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith("--retention-days=")) {
      options.retentionDays = parsePositiveIntegerFlag("--retention-days", arg.split("=", 2)[1]);
      continue;
    }

    if (arg.startsWith("--max-deletions=")) {
      options.maxDeletions = parsePositiveIntegerFlag("--max-deletions", arg.split("=", 2)[1]);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage(): void {
  console.log(
    "Usage: tsx scripts/cleanup-operation-state.ts [--dry-run] [--retention-days=<days>] [--max-deletions=<count>]"
  );
  console.log("Defaults:");
  console.log("  --retention-days: uses MC_OPERATION_STATE_RETENTION_DAYS or 30 days");
  console.log("  --max-deletions: no limit");
}

async function main(): Promise<void> {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    const retentionMs = options.retentionDays
      ? options.retentionDays * oneDayMs
      : getDurableOperationStateRetentionMs();

    const result = await cleanupExpiredDurableOperationStates({
      dryRun: options.dryRun,
      retentionMs,
      maxDeletions: options.maxDeletions,
    });

    console.log(
      `[OPERATIONS] Cleanup complete. scanned=${result.scannedCount} expired=${result.expiredCount} selected=${result.selectedParameterNames.length} deleted=${result.deletedCount} cutoff=${result.cutoffAt}`
    );

    if (result.selectedParameterNames.length > 0) {
      const actionLabel = result.dryRun ? "Would delete" : "Deleted";
      console.log(`[OPERATIONS] ${actionLabel} operation parameters:`);
      for (const parameterName of result.selectedParameterNames) {
        console.log(`  - ${parameterName}`);
      }
    }
  } catch (error) {
    console.error("[OPERATIONS] Failed to run operation-state cleanup:", error);
    printUsage();
    process.exit(1);
  }
}

void main();
