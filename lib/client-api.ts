import type {
  ApiResponse,
  AuthMeResponse,
  AwsConfigResponse,
  CostsResponse,
  EmailsResponse,
  GDriveSetupResponse,
  GDriveStatusResponse,
  ListBackupsResponse,
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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error(getErrorMessage(payload, `Request failed (${response.status})`));
  }

  if (isFailedApiEnvelope(payload)) {
    throw new Error(getErrorMessage(payload, "Request failed"));
  }

  return payload as T;
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

export function fetchServiceStatus(): Promise<ApiResponse<ServiceStatusResponse>> {
  return requestJson<ApiResponse<ServiceStatusResponse>>("/api/service-status");
}

export function fetchStackStatus(): Promise<ApiResponse<StackStatusResponse>> {
  return requestJson<ApiResponse<StackStatusResponse>>("/api/stack-status");
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

export function fetchGDriveSetup(): Promise<ApiResponse<GDriveSetupResponse>> {
  return requestJson<ApiResponse<GDriveSetupResponse>>("/api/gdrive/setup");
}

export function fetchAwsConfig(): Promise<ApiResponse<AwsConfigResponse>> {
  return requestJson<ApiResponse<AwsConfigResponse>>("/api/aws-config");
}

export function fetchBackups(refresh = false): Promise<ApiResponse<ListBackupsResponse>> {
  const path = refresh ? "/api/backups?refresh=true" : "/api/backups";
  return requestJson<ApiResponse<ListBackupsResponse>>(path);
}

export function postServerAction(
  endpoint: ActionEndpoint,
  body?: Record<string, string>
): Promise<ApiResponse<{ message?: string } & Record<string, unknown>>> {
  return requestJson<ApiResponse<{ message?: string } & Record<string, unknown>>>(endpoint, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}
