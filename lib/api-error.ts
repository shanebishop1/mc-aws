/**
 * API error handling utilities
 * Provides safe error message formatting for API responses
 */

import { NextResponse } from "next/server";
import type { ApiResponse } from "./types";

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
  customGenericMessage?: string
): NextResponse<ApiResponse<T>> {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";

  // Check if this is a known validation error that should be exposed
  if (isValidationError(errorMessage)) {
    console.error(`[${operationType.toUpperCase()}] Validation error:`, error);
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
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
  safeMessage: string
): NextResponse<ApiResponse<T>> {
  // Log the full error
  console.error("[API] Error:", error);

  return NextResponse.json(
    {
      success: false,
      error: safeMessage,
      timestamp: new Date().toISOString(),
    },
    { status: statusCode }
  );
}
