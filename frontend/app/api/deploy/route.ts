/**
 * POST /api/deploy
 * Triggers CDK deploy for MinecraftStack
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { checkStackExists } from "@/lib/aws/cloudformation-client";
import type { ApiResponse, DeployResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

const execAsync = promisify(exec);

export async function POST(_request: NextRequest): Promise<NextResponse<ApiResponse<DeployResponse>>> {
  try {
    console.log("[DEPLOY] Starting deployment...");

    // Optional safety check: see if stack already exists
    const exists = await checkStackExists();
    if (exists) {
      console.log("[DEPLOY] Stack already exists, performing update.");
    } else {
      console.log("[DEPLOY] Stack does not exist, performing fresh deployment.");
    }

    // Get project root (one level up from frontend/)
    const projectRoot = path.resolve(process.cwd(), "..");

    // Command to run
    // Using --require-approval never to avoid interactive prompts
    const command = 'npx cdk deploy MinecraftStack --require-approval never --app "npx ts-node bin/mc-aws.ts"';

    console.log(`[DEPLOY] Running command: ${command} in ${projectRoot}`);

    // This is a long-running operation.
    // In a serverless environment, this might timeout.
    // For local dev/standard server, it depends on the Node configuration.
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectRoot,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for logs
    });

    if (stderr) {
      console.log("[DEPLOY] CDK stderr output:", stderr);
    }

    return NextResponse.json({
      success: true,
      data: {
        message: exists ? "Stack updated successfully" : "Stack deployed successfully",
        output: stdout + (stderr ? `\n\nStderr:\n${stderr}` : ""),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[DEPLOY] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
