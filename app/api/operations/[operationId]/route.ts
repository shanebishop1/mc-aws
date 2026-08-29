/**
 * GET /api/operations/[operationId]
 * Returns durable mutating operation status from DynamoDB with legacy SSM read fallback.
 */

import { createHash } from "node:crypto";
import { requireAllowed } from "@/lib/api-auth";
import {
  type DurableOperationState,
  expireAcceptedDispatchIfDeadlineElapsed,
  getAcceptedDispatchExpiryAt,
  getDurableOperationState,
} from "@/lib/durable-operation-state";
import { checkRateLimit } from "@/lib/rate-limit";
import { releaseServerActionLockIfOwned } from "@/lib/server-action-lock";
import type { ApiResponse, OperationStatusData } from "@/lib/types";
import { type NextRequest, NextResponse } from "next/server";

interface OperationRouteContext {
  params: Promise<{
    operationId: string;
  }>;
}

const OPERATION_ID_MAX_LENGTH = 128;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OPERATION_STATUS_RATE_LIMIT_WINDOW_MS = 60_000;
const OPERATION_STATUS_RATE_LIMIT_MAX_REQUESTS = 60;

async function mapAuthFailureResponse(error: Response): Promise<NextResponse<ApiResponse<OperationStatusData>>> {
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

function toPublicOperationStatus(operation: DurableOperationState): OperationStatusData {
  const dispatchExpiresAt = getAcceptedDispatchExpiryAt(operation);
  return {
    schemaVersion: 1,
    id: operation.id,
    type: operation.type,
    status: operation.status,
    route: operation.route,
    requestedAt: operation.requestedAt,
    updatedAt: operation.updatedAt,
    ...(operation.lastError ? { lastError: operation.lastError } : {}),
    ...(operation.code ? { code: operation.code } : {}),
    ...(operation.phase ? { phase: operation.phase } : {}),
    ...(operation.deadlineAt ? { deadlineAt: operation.deadlineAt } : {}),
    ...(operation.maxDurationMs ? { maxDurationMs: operation.maxDurationMs } : {}),
    ...(dispatchExpiresAt ? { dispatchExpiresAt } : {}),
  };
}

export async function GET(
  request: NextRequest,
  context: OperationRouteContext
): Promise<NextResponse<ApiResponse<OperationStatusData>>> {
  let user: Awaited<ReturnType<typeof requireAllowed>>;
  try {
    user = await requireAllowed(request);
  } catch (error) {
    if (error instanceof Response) {
      return await mapAuthFailureResponse(error);
    }

    console.error("[OPERATIONS] Failed to authenticate operation-status request");
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
  if (
    normalizedOperationId.length === 0 ||
    normalizedOperationId.length > OPERATION_ID_MAX_LENGTH ||
    !OPERATION_ID_PATTERN.test(normalizedOperationId)
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "Operation ID is invalid",
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }

  const identityHash = createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex").slice(0, 32);
  const rateLimit = await checkRateLimit({
    route: "/api/operations/[operationId]",
    key: `operation-status:${identityHash}`,
    limit: OPERATION_STATUS_RATE_LIMIT_MAX_REQUESTS,
    windowMs: OPERATION_STATUS_RATE_LIMIT_WINDOW_MS,
    failureMode: "closed",
  });
  if (!rateLimit.allowed) {
    const response = NextResponse.json(
      {
        success: false,
        error: "Too many operation status requests. Please retry shortly.",
        timestamp: new Date().toISOString(),
      },
      { status: 429 }
    );
    response.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  try {
    let operation = await getDurableOperationState(normalizedOperationId);
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

    const isOwner = operation.requestedBy?.trim().toLowerCase() === user.email.trim().toLowerCase();
    if (user.role !== "admin" && !isOwner) {
      return NextResponse.json(
        {
          success: false,
          error: "Insufficient permissions",
          timestamp: new Date().toISOString(),
        },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      );
    }

    const expiry = await expireAcceptedDispatchIfDeadlineElapsed(normalizedOperationId);
    operation = expiry.operation ?? operation;
    const fencingToken = operation.fencingToken;
    if (
      expiry.shouldReleaseLock &&
      operation.lockId &&
      operation.requestedBy &&
      typeof fencingToken === "number" &&
      Number.isSafeInteger(fencingToken) &&
      fencingToken > 0
    ) {
      try {
        await releaseServerActionLockIfOwned({
          lockId: operation.lockId,
          action: operation.type,
          ownerEmail: operation.requestedBy,
          fencingToken,
        });
      } catch {
        // The terminal state remains authoritative. A later poll retries the
        // exact fenced release, and lock expiry already prevents early reuse.
        console.error("[OPERATIONS] Failed to release expired operation lock");
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: toPublicOperationStatus(operation),
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    console.error("[OPERATIONS] Failed to fetch durable operation state");

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
