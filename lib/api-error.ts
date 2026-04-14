/**
 * API error handling utilities
 * Provides safe error message formatting for API responses
 */

import { NextResponse } from "next/server";
import type { ApiResponse, OperationInfo } from "./types";

/**
 * Format an auth/authorization response so mutating routes keep operation metadata
 */
export async function formatAuthErrorResponse<T>(
  authError: Response,
  operation: OperationInfo
): Promise<NextResponse<ApiResponse<T>>> {
  let errorMessage = authError.status === 403 ? "Insufficient permissions" : "Authentication required";

  try {
    const body = (await authError.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      errorMessage = body.error;
    }
  } catch {
    // Fall back to generic auth message when response body is unavailable
  }

  return NextResponse.json(
    {
      success: false,
      error: errorMessage,
      operation,
      timestamp: new Date().toISOString(),
    },
    { status: authError.status }
  );
}

/**
 * Known validation error messages that should be exposed to clients
 * These are safe because they don't leak internal implementation details
 */
const VALIDATION_ERROR_PATTERNS = [
  "Backup name is required",
  "Backup name exceeds maximum length",
  "Backup name cannot be empty",
  "Backup name contains invalid characters",
  "emails must be an array",
  "emails must be an array of strings",
  "Invalid email format",
] as const;

/**
 * Check if an error message is a safe validation error
 */
function isValidationError(message: string): boolean {
  return VALIDATION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Generic error messages for different operation types
 * These are safe to expose to clients
 */
const GENERIC_ERROR_MESSAGES = {
  status: "Failed to fetch server status",
  start: "Failed to start server",
  stop: "Failed to stop server",
  resume: "Failed to resume server",
  hibernate: "Failed to hibernate server",
  backup: "Failed to create backup",
  backups: "Failed to list backups",
  restore: "Failed to restore backup",
  costs: "Failed to fetch cost data",
  players: "Failed to fetch player count",
  awsConfig: "Failed to fetch AWS configuration",
  stackStatus: "Failed to fetch stack status",
  gdriveStatus: "Failed to check Google Drive status",
  gdriveSetup: "Failed to initiate Google Drive setup",
  gdriveCallback: "Failed to complete Google Drive setup",
  logout: "Failed to logout",
  emails: "Failed to fetch email configuration",
  emailsAllowlist: "Failed to update email allowlist",
} as const;

/**
 * Format an API error response with safe messaging
 *
 * @param error - The caught error
 * @param operationType - The type of operation (for generic message selection)
 * @param customGenericMessage - Optional custom generic message override
 * @returns NextResponse with appropriate status code and safe error message
 */
export function formatApiErrorResponse<T>(
  error: unknown,
  operationType: keyof typeof GENERIC_ERROR_MESSAGES,
  customGenericMessage?: string,
  operation?: OperationInfo
): NextResponse<ApiResponse<T>> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  // Check if this is a known validation error that should be exposed
  if (isValidationError(errorMessage)) {
    console.error(`[${operationType.toUpperCase()}] Validation error:`, error);
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        operation,
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    );
  }

  // For all other errors, log the full error but return a generic message
  console.error(`[${operationType.toUpperCase()}] Error:`, error);

  const safeMessage = customGenericMessage ?? GENERIC_ERROR_MESSAGES[operationType] ?? "Failed to process request";

  return NextResponse.json(
    {
      success: false,
      error: safeMessage,
      operation,
      timestamp: new Date().toISOString(),
    },
    { status: 500 }
  );
}

/**
 * Format an API error response with a specific status code
 * Use this when you need to return a non-500 status code for non-validation errors
 *
 * @param error - The caught error
 * @param statusCode - The HTTP status code to return
 * @param safeMessage - The safe message to expose to clients
 * @returns NextResponse with the specified status code and safe error message
 */
export function formatApiErrorResponseWithStatus<T>(
  error: unknown,
  statusCode: number,
  safeMessage: string,
  operation?: OperationInfo
): NextResponse<ApiResponse<T>> {
  // Log the full error
  console.error("[API] Error:", error);

  return NextResponse.json(
    {
      success: false,
      error: safeMessage,
      operation,
      timestamp: new Date().toISOString(),
    },
    { status: statusCode }
  );
}
