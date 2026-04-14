import {
  createMutatingActionFailure,
  type MutatingActionExecutionResult,
} from "@/lib/mutating-action-contract";
import { withOperationStatus } from "@/lib/operation";
import type { ApiResponse, OperationInfo, OperationStatus } from "@/lib/types";
import { NextResponse } from "next/server";

const mutatingActionHttpStatusByOperationStatus: Record<OperationStatus, number> = {
  accepted: 202,
  running: 202,
  completed: 200,
  failed: 500,
};

export const mutatingActionLockConflictMessage =
  "Another operation is already in progress. Please wait for it to complete.";

export function mapMutatingActionHttpStatus(status: OperationStatus): number {
  return mutatingActionHttpStatusByOperationStatus[status];
}

export function mapMutatingActionExecutionToApiResponse<TData>(
  operation: OperationInfo,
  execution: MutatingActionExecutionResult<TData>
): NextResponse<ApiResponse<TData>> {
  const statusCode = execution.ok
    ? mapMutatingActionHttpStatus(execution.status)
    : execution.httpStatus ?? mapMutatingActionHttpStatus("failed");

  if (execution.ok) {
    return NextResponse.json(
      {
        success: true,
        data: execution.data,
        operation: withOperationStatus(operation, execution.status),
        timestamp: new Date().toISOString(),
      },
      { status: statusCode }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: execution.error,
      operation: withOperationStatus(operation, "failed"),
      timestamp: new Date().toISOString(),
    },
    { status: statusCode }
  );
}

export function createMutatingActionLockConflictFailure(cause?: unknown) {
  return createMutatingActionFailure(mutatingActionLockConflictMessage, {
    httpStatus: 409,
    code: "action_in_progress",
    cause,
  });
}
