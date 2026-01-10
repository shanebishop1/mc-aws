import { ServerState } from "@/lib/types";
import type {
  ApiResponse,
  BackupInfo,
  BackupResponse,
  CostsResponse,
  DeployResponse,
  DestroyResponse,
  EmailsResponse,
  GDriveStatusResponse,
  HibernateResponse,
  ListBackupsResponse,
  PlayerCountData,
  PlayersResponse,
  RestoreResponse,
  ResumeResponse,
  ServerStatusResponse,
  StackStatusResponse,
  StartServerResponse,
  StopServerResponse,
} from "@/lib/types";
import type { Page, Route } from "@playwright/test";

// Mock scenarios
export type MockScenario =
  | "no-stack" // Stack doesn't exist
  | "stack-stopped" // Stack exists, server stopped
  | "stack-running" // Stack exists, server running
  | "stack-hibernating" // Stack exists, server hibernating
  | "aws-error" // AWS connection error
  | "gdrive-configured" // Google Drive is set up
  | "gdrive-not-configured"; // Google Drive not set up

/**
 * Helper to create standard API response
 */
function createResponse<T>(data: T, success = true): ApiResponse<T> {
  return {
    success,
    data,
    timestamp: new Date().toISOString(),
  };
}

function createErrorResponse(message: string): ApiResponse {
  return {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Mock data helpers
 */
const mockInstanceId = "i-1234567890abcdef0";
const mockPublicIp = "192.0.2.1";
const mockDomain = "mc.example.com";

function getServerStatus(scenario: MockScenario): ServerStatusResponse {
  const state =
    scenario === "stack-running"
      ? ServerState.Running
      : scenario === "stack-hibernating"
        ? ServerState.Hibernating
        : ServerState.Stopped;

  return {
    state,
    instanceId: mockInstanceId,
    publicIp: state === ServerState.Running ? mockPublicIp : undefined,
    hasVolume: true,
    lastUpdated: new Date().toISOString(),
  };
}

function getStackStatus(scenario: MockScenario): StackStatusResponse {
  if (scenario === "aws-error") {
    return {
      exists: false,
      error: "AWS connection failed",
    };
  }

  if (scenario === "no-stack") {
    return {
      exists: false,
    };
  }

  return {
    exists: true,
    status: "CREATE_COMPLETE",
    stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft/12345678-1234-1234-1234-123456789012",
  };
}

function getGDriveStatus(scenario: MockScenario): GDriveStatusResponse {
  return {
    configured: scenario === "gdrive-configured",
  };
}

/**
 * Setup mocks for all API endpoints based on scenario
 */
export async function setupMocks(page: Page, scenarios: MockScenario[]) {
  // Determine active scenarios
  const hasNoStack = scenarios.includes("no-stack");
  const hasStackStopped = scenarios.includes("stack-stopped");
  const hasStackRunning = scenarios.includes("stack-running");
  const hasStackHibernating = scenarios.includes("stack-hibernating");
  const hasAwsError = scenarios.includes("aws-error");
  const hasGDriveConfigured = scenarios.includes("gdrive-configured");
  const hasGDriveNotConfigured = scenarios.includes("gdrive-not-configured");

  // Determine the server state scenario
  const serverScenario = hasStackRunning
    ? "stack-running"
    : hasStackHibernating
      ? "stack-hibernating"
      : hasStackStopped
        ? "stack-stopped"
        : "stack-stopped";

  // Determine GDrive scenario
  const gdriveScenario = hasGDriveConfigured
    ? "gdrive-configured"
    : hasGDriveNotConfigured
      ? "gdrive-not-configured"
      : "gdrive-configured";

  const stackScenario = hasAwsError ? "aws-error" : hasNoStack ? "no-stack" : "stack-stopped";

  // Mock /api/stack-status
  await page.route("**/api/stack-status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(getStackStatus(stackScenario))),
    });
  });

  // Mock /api/status
  await page.route("**/api/status", async (route) => {
    if (hasNoStack || hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Stack does not exist")),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(getServerStatus(serverScenario))),
      });
    }
  });

  // Mock GET /api/start
  await page.route("**/api/start", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to start instance: AWS connection error")),
      });
    } else {
      const data: StartServerResponse = {
        instanceId: mockInstanceId,
        publicIp: mockPublicIp,
        domain: mockDomain,
        message: "Starting Minecraft server",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock POST /api/start (should match both GET and POST)
  await page.route("**/api/start", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to start instance: AWS connection error")),
      });
    } else {
      const data: StartServerResponse = {
        instanceId: mockInstanceId,
        publicIp: mockPublicIp,
        domain: mockDomain,
        message: "Starting Minecraft server",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock /api/stop
  await page.route("**/api/stop", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to stop instance: AWS connection error")),
      });
    } else {
      const data: StopServerResponse = {
        instanceId: mockInstanceId,
        message: "Stopping Minecraft server",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock /api/hibernate
  await page.route("**/api/hibernate", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to hibernate: AWS connection error")),
      });
    } else {
      const data: HibernateResponse = {
        message: "Server hibernated successfully",
        backupOutput: "Backup created: backup-2025-01-09.tar.gz",
        instanceId: mockInstanceId,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock /api/resume
  await page.route("**/api/resume", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to resume: AWS connection error")),
      });
    } else {
      const data: ResumeResponse = {
        instanceId: mockInstanceId,
        publicIp: mockPublicIp,
        domain: mockDomain,
        message: "Resuming server from hibernation",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock /api/gdrive/status
  await page.route("**/api/gdrive/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(getGDriveStatus(gdriveScenario))),
    });
  });

  // Mock /api/costs
  await page.route("**/api/costs", async (route) => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const costData = {
      period: {
        start: monthStart.toISOString(),
        end: monthEnd.toISOString(),
      },
      totalCost: "12.50",
      currency: "USD",
      breakdown: [
        { service: "Amazon EC2", cost: "8.50" },
        { service: "Amazon EBS", cost: "2.50" },
        { service: "AWS Lambda", cost: "1.50" },
      ],
      fetchedAt: new Date().toISOString(),
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(costData)),
    });
  });

  // Mock /api/players
  await page.route("**/api/players", async (route) => {
    const playerData: PlayerCountData = {
      count: 3,
      lastUpdated: new Date().toISOString(),
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(playerData)),
    });
  });

  // Mock /api/backup
  await page.route("**/api/backup", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to create backup: AWS connection error")),
      });
    } else {
      const data: BackupResponse = {
        backupName: "backup-2025-01-09-14-30-00.tar.gz",
        message: "Backup created successfully",
        output: "Backing up Minecraft world data...",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock GET /api/backups
  await page.route("**/api/backups", async (route) => {
    const backups: BackupInfo[] = [
      {
        name: "backup-2025-01-09.tar.gz",
        date: "2025-01-09T14:30:00Z",
        size: "125.4 MB",
      },
      {
        name: "backup-2025-01-08.tar.gz",
        date: "2025-01-08T20:15:00Z",
        size: "124.8 MB",
      },
      {
        name: "backup-2025-01-07.tar.gz",
        date: "2025-01-07T18:00:00Z",
        size: "123.2 MB",
      },
    ];

    const data: ListBackupsResponse = {
      backups,
      count: backups.length,
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(data)),
    });
  });

  // Mock POST /api/restore
  await page.route("**/api/restore", async (route) => {
    if (hasAwsError) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createErrorResponse("Failed to restore: AWS connection error")),
      });
    } else {
      const data: RestoreResponse = {
        backupName: "backup-2025-01-09.tar.gz",
        message: "Restore completed successfully",
        output: "Restoring from backup...",
        publicIp: mockPublicIp,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createResponse(data)),
      });
    }
  });

  // Mock /api/emails
  await page.route("**/api/emails", async (route) => {
    const data = {
      adminEmail: "admin@example.com",
      allowlist: ["player1@example.com", "player2@example.com"],
      cachedAt: Date.now(),
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(data)),
    });
  });

  // Mock PATCH /api/emails
  await page.route("**/api/emails", async (route) => {
    const data = {
      adminEmail: "admin@example.com",
      allowlist: ["player1@example.com", "player2@example.com"],
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(data)),
    });
  });

  // Mock /api/deploy
  await page.route("**/api/deploy", async (route) => {
    const data: DeployResponse = {
      message: "Deployment started",
      output: "Building Minecraft stack...",
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(data)),
    });
  });

  // Mock /api/destroy
  await page.route("**/api/destroy", async (route) => {
    const data: DestroyResponse = {
      message: "Stack destruction started",
      output: "Deleting Minecraft stack...",
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createResponse(data)),
    });
  });
}
