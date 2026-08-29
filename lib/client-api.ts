import type {
  ApiResponse,
  AuthMeResponse,
  AwsConfigResponse,
  CostsResponse,
  EmailsResponse,
  GDriveSetupResponse,
  GDriveStatusResponse,
  ListBackupsResponse,
  OperationInfo,
  OperationStatusData,
  PlayersResponse,
  ServerStatusResponse,
  ServiceStatusResponse,
  StackStatusResponse,
} from "@/lib/types";

export type ActionEndpoint =
  | "/api/start"
  | "/api/stop"
  | "/api/resume"
  | "/api/hibernate"
  | "/api/backup"
  | "/api/restore";

interface ApiEnvelope {
  success?: boolean;
  error?: string;
}

export class ClientApiError extends Error {
  readonly status?: number;
  readonly operation?: OperationInfo;

  constructor(message: string, status?: number, operation?: OperationInfo, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientApiError";
    this.status = status;
    this.operation = operation;
  }
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const maybeError = (payload as { error?: unknown }).error;
    if (typeof maybeError === "string" && maybeError.trim().length > 0) {
      return maybeError;
    }
  }

  return fallback;
}

function isFailedApiEnvelope(payload: unknown): payload is ApiEnvelope {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const maybeSuccess = (payload as { success?: unknown }).success;
  return maybeSuccess === false;
}

const operationTypes = new Set(["start", "stop", "backup", "restore", "hibernate", "resume"]);
const operationStatuses = new Set(["accepted", "running", "completed", "failed"]);

function getOperationInfo(payload: unknown): OperationInfo | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const operation = (payload as Record<string, unknown>).operation;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return undefined;
  const candidate = operation as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.type !== "string" ||
    !operationTypes.has(candidate.type) ||
    typeof candidate.status !== "string" ||
    !operationStatuses.has(candidate.status)
  ) {
    return undefined;
  }
  return candidate as unknown as OperationInfo;
}

type ResponseValidator<T> = (payload: unknown) => payload is T;

async function requestJson<T>(path: string, init?: RequestInit, validate?: ResponseValidator<T>): Promise<T> {
  const headers = new Headers(init?.headers);

  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    throw new ClientApiError(
      getErrorMessage(payload, `Request failed (${response.status})`),
      response.status,
      getOperationInfo(payload)
    );
  }

  if (isFailedApiEnvelope(payload)) {
    throw new ClientApiError(getErrorMessage(payload, "Request failed"), response.status);
  }

  if (validate && !validate(payload)) {
    throw new Error(`Invalid response from ${path}`);
  }

  return payload as T;
}

function isStackStatusApiResponse(payload: unknown): payload is ApiResponse<StackStatusResponse> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const response = payload as Record<string, unknown>;
  if (response.success !== true || typeof response.timestamp !== "string") {
    return false;
  }

  const data = response.data;
  return Boolean(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof (data as Record<string, unknown>).exists === "boolean"
  );
}

const operationPhases = new Set(["validating", "dispatching", "dispatched", "executing", "terminal"]);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate the complete untrusted operation-status envelope at one boundary.
function isOperationStatusApiResponse(payload: unknown): payload is ApiResponse<OperationStatusData> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const response = payload as Record<string, unknown>;
  if (
    response.success !== true ||
    typeof response.timestamp !== "string" ||
    !Number.isFinite(Date.parse(response.timestamp))
  )
    return false;
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const operation = data as Record<string, unknown>;
  return Boolean(
    operation.schemaVersion === 1 &&
      typeof operation.id === "string" &&
      operation.id.length > 0 &&
      typeof operation.type === "string" &&
      operationTypes.has(operation.type) &&
      typeof operation.status === "string" &&
      operationStatuses.has(operation.status) &&
      typeof operation.route === "string" &&
      operation.route.startsWith("/api/") &&
      typeof operation.requestedAt === "string" &&
      Number.isFinite(Date.parse(operation.requestedAt)) &&
      typeof operation.updatedAt === "string" &&
      Number.isFinite(Date.parse(operation.updatedAt)) &&
      (operation.lastError === undefined || typeof operation.lastError === "string") &&
      (operation.code === undefined || typeof operation.code === "string") &&
      (operation.phase === undefined ||
        (typeof operation.phase === "string" && operationPhases.has(operation.phase))) &&
      (operation.deadlineAt === undefined ||
        (typeof operation.deadlineAt === "string" && Number.isFinite(Date.parse(operation.deadlineAt)))) &&
      (operation.maxDurationMs === undefined ||
        (typeof operation.maxDurationMs === "number" &&
          Number.isSafeInteger(operation.maxDurationMs) &&
          operation.maxDurationMs > 0)) &&
      (operation.dispatchExpiresAt === undefined ||
        (typeof operation.dispatchExpiresAt === "string" && Number.isFinite(Date.parse(operation.dispatchExpiresAt))))
  );
}

export const queryKeys = {
  authMe: ["auth", "me"] as const,
  status: ["status"] as const,
  serviceStatus: ["service-status"] as const,
  stackStatus: ["stack-status"] as const,
  players: ["players"] as const,
  costs: ["costs"] as const,
  emails: ["emails"] as const,
  gdriveStatus: ["gdrive", "status"] as const,
  awsConfig: ["aws-config"] as const,
  backups: (refresh: boolean) => ["backups", refresh ? "refresh" : "cached"] as const,
  gdriveSetup: ["gdrive", "setup"] as const,
  operation: (operationId: string) => ["operations", operationId] as const,
};

export function fetchAuthMe(): Promise<AuthMeResponse> {
  return requestJson<AuthMeResponse>("/api/auth/me");
}

export function postAuthLogout(): Promise<{ success: true; timestamp: string }> {
  return requestJson<{ success: true; timestamp: string }>("/api/auth/logout", {
    method: "POST",
  });
}

export function fetchStatus(): Promise<ApiResponse<ServerStatusResponse>> {
  return requestJson<ApiResponse<ServerStatusResponse>>("/api/status");
}

export function fetchStatusWithSignal(signal?: AbortSignal): Promise<ApiResponse<ServerStatusResponse>> {
  return requestJson<ApiResponse<ServerStatusResponse>>("/api/status", { signal });
}

export function fetchServiceStatus(): Promise<ApiResponse<ServiceStatusResponse>> {
  return requestJson<ApiResponse<ServiceStatusResponse>>("/api/service-status");
}

export function fetchStackStatus(): Promise<ApiResponse<StackStatusResponse>> {
  return requestJson<ApiResponse<StackStatusResponse>>("/api/stack-status", undefined, isStackStatusApiResponse);
}

export function fetchPlayers(): Promise<PlayersResponse> {
  return requestJson<PlayersResponse>("/api/players");
}

export function fetchCosts(refresh = false): Promise<CostsResponse> {
  const path = refresh ? "/api/costs?refresh=true" : "/api/costs";
  return requestJson<CostsResponse>(path);
}

export function fetchEmails(refresh = false): Promise<EmailsResponse> {
  const path = refresh ? "/api/emails?refresh=true" : "/api/emails";
  return requestJson<EmailsResponse>(path);
}

export function putEmailsAllowlist(emails: string[]): Promise<EmailsResponse> {
  return requestJson<EmailsResponse>("/api/emails/allowlist", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emails }),
  });
}

export function fetchGDriveStatus(): Promise<ApiResponse<GDriveStatusResponse>> {
  return requestJson<ApiResponse<GDriveStatusResponse>>("/api/gdrive/status");
}

export function fetchGDriveSetup(signal?: AbortSignal): Promise<ApiResponse<GDriveSetupResponse>> {
  return requestJson<ApiResponse<GDriveSetupResponse>>("/api/gdrive/setup", { signal });
}

export function fetchAwsConfig(): Promise<ApiResponse<AwsConfigResponse>> {
  return requestJson<ApiResponse<AwsConfigResponse>>("/api/aws-config");
}

export function fetchBackups(refresh = false, signal?: AbortSignal): Promise<ApiResponse<ListBackupsResponse>> {
  const path = refresh ? "/api/backups?refresh=true" : "/api/backups";
  return requestJson<ApiResponse<ListBackupsResponse>>(path, { signal });
}

export function postServerAction(
  endpoint: ActionEndpoint,
  body?: Record<string, string>,
  signal?: AbortSignal
): Promise<ApiResponse<{ message?: string } & Record<string, unknown>>> {
  return requestJson<ApiResponse<{ message?: string } & Record<string, unknown>>>(endpoint, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

export function fetchOperationStatus(
  operationId: string,
  signal?: AbortSignal
): Promise<ApiResponse<OperationStatusData>> {
  return requestJson<ApiResponse<OperationStatusData>>(
    `/api/operations/${encodeURIComponent(operationId)}`,
    { signal },
    isOperationStatusApiResponse
  );
}
