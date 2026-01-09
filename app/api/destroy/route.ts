/**
 * POST /api/destroy
 * Triggers CDK destroy for MinecraftStack
 */

import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { checkStackExists } from "@/lib/aws/cloudformation-client";
import type { ApiResponse, DestroyResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

const execAsync = promisify(exec);

export async function POST(_request: NextRequest): Promise<NextResponse<ApiResponse<DestroyResponse>>> {
  try {
    // Check admin authorization
    try {
      const user = requireAdmin(_request);
      console.log("[DESTROY] Admin action by:", user.email);
    } catch (error) {
      if (error instanceof Response) {
        return error as NextResponse<ApiResponse<DestroyResponse>>;
      }
      throw error;
    }

    console.log("[DESTROY] Starting destruction...");
    console.log("[DESTROY] Starting destruction...");

    // Safety check: stack must exist to be destroyed
    const exists = await checkStackExists();
    if (!exists) {
      return NextResponse.json(
        {
          success: false,
          error: "Stack 'MinecraftStack' does not exist.",
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // Get infra directory (CDK code location)
    const infraDir = path.resolve(process.cwd(), "infra");

    // Command to run
    // Using --force to avoid interactive confirmation
    const command = 'npx cdk destroy MinecraftStack --force --app "npx ts-node bin/mc-aws.ts"';

    console.log(`[DESTROY] Running command: ${command} in ${infraDir}`);

    const { stdout, stderr } = await execAsync(command, {
      cwd: infraDir,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for logs
    });

    if (stderr) {
      console.log("[DESTROY] CDK stderr output:", stderr);
    }

    return NextResponse.json({
      success: true,
      data: {
        message: "Stack destroyed successfully",
        output: stdout + (stderr ? `\n\nStderr:\n${stderr}` : ""),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[DESTROY] Error:", error);
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
