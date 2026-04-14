import type { MutatingActionCommandPayloadByType, MutatingActionType } from "@/lib/mutating-action-contract";
import { sanitizeBackupName } from "@/lib/sanitization";
import type { NextRequest } from "next/server";

const mutatingActionTypes = ["start", "stop", "backup", "restore", "hibernate", "resume"] as const;

const backupNameFieldAliases = ["backupName", "name"] as const;
const resumeModeFieldAliases = ["restoreMode", "mode"] as const;

export type ResumeRestoreMode = "fresh" | "latest" | "named";

export type MutatingActionRequestPayloadByType = Omit<MutatingActionCommandPayloadByType, "restore"> & {
  // Back-compat: routes currently allow restore with no explicit backupName ("latest").
  restore: { backupName?: string };
  resume: { backupName?: string; restoreMode?: ResumeRestoreMode };
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeMutatingActionType(command: unknown): MutatingActionType | null {
  if (typeof command !== "string") {
    return null;
  }

  const normalized = command.trim().toLowerCase();
  return mutatingActionTypes.includes(normalized as MutatingActionType) ? (normalized as MutatingActionType) : null;
}

export function normalizeMutatingActionArgs(args: unknown): string[] {
  if (!Array.isArray(args)) {
    return [];
  }

  const normalizedArgs: string[] = [];
  for (const arg of args) {
    const normalized = normalizeOptionalString(arg);
    if (normalized) {
      normalizedArgs.push(normalized);
    }
  }

  return normalizedArgs;
}

export async function parseOptionalMutatingJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.clone().json();
    return isObjectRecord(body) ? body : {};
  } catch {
    return {};
  }
}

export function normalizeAndSanitizeBackupName(body: Record<string, unknown>): string | undefined {
  for (const field of backupNameFieldAliases) {
    const candidate = normalizeOptionalString(body[field]);
    if (candidate) {
      return sanitizeBackupName(candidate);
    }
  }

  return undefined;
}

function normalizeResumeRestoreMode(body: Record<string, unknown>): ResumeRestoreMode | undefined {
  for (const field of resumeModeFieldAliases) {
    const candidate = normalizeOptionalString(body[field]);
    if (!candidate) {
      continue;
    }

    const normalized = candidate.toLowerCase();
    if (normalized === "fresh" || normalized === "latest" || normalized === "named") {
      return normalized;
    }

    throw new Error("Restore mode must be one of: fresh, latest, named");
  }

  return undefined;
}

export async function parseMutatingActionRequestPayload<TAction extends MutatingActionType>(
  request: NextRequest,
  action: TAction
): Promise<MutatingActionRequestPayloadByType[TAction]> {
  const body = await parseOptionalMutatingJsonBody(request);

  if (action === "backup" || action === "restore" || action === "resume") {
    const backupName = normalizeAndSanitizeBackupName(body);

    if (action === "resume") {
      return {
        backupName,
        restoreMode: normalizeResumeRestoreMode(body),
      } as MutatingActionRequestPayloadByType[TAction];
    }

    return {
      backupName,
    } as MutatingActionRequestPayloadByType[TAction];
  }

  return {} as MutatingActionRequestPayloadByType[TAction];
}
