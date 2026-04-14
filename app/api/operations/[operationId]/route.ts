/**
 * GET /api/operations/[operationId]
 * Returns durable mutating operation status persisted in SSM.
 */

import { requireAllowed } from "@/lib/api-auth";
import { getDurableOperationState, type DurableOperationState } from "@/lib/durable-operation-state";
import type { ApiResponse } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface OperationRouteContext {
  params: Promise<{
    operationId: string;
  }>;
}

async function mapAuthFailureResponse(error: Response): Promise<NextResponse<ApiResponse<DurableOperationState>>> {
  let message = error.status === 403 ? "Insufficient permissions" : "Authentication required";

  try {
    const payload = (await error.clone().json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.length > 0) {
      message = payload.error;
    }
  } catch {
    // Keep fallback auth error message when payload cannot be parsed.
  }

  return NextResponse.json(
    {
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    },
    { status: error.status }
  );
}

export async function GET(
  request: NextRequest,
  context: OperationRouteContext
): Promise<NextResponse<ApiResponse<DurableOperationState>>> {
  try {
    await requireAllowed(request);
  } catch (error) {
    if (error instanceof Response) {
      return await mapAuthFailureResponse(error);
    }

    console.error("[OPERATIONS] Failed to authenticate operation-status request:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Authentication required",
        timestamp: new Date().toISOString(),
      },
      { status: 401 }
    );
  }

  const { operationId } = await context.params;
  const normalizedOperationId = operationId.trim();
  if (normalizedOperationId.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error: "Operation ID is required",
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }

  try {
    const operation = await getDurableOperationState(normalizedOperationId);
    if (!operation) {
      return NextResponse.json(
        {
          success: false,
          error: "Operation not found",
          timestamp: new Date().toISOString(),
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: operation,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[OPERATIONS] Failed to fetch durable operation state:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch operation status",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
