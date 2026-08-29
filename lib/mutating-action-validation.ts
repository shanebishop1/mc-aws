import type { MutatingActionCommandPayloadByType, MutatingActionType } from "@/lib/mutating-action-contract";
import { sanitizeBackupName } from "@/lib/sanitization";
import type { NextRequest } from "next/server";

const mutatingActionTypes = ["start", "stop", "backup", "restore", "hibernate", "resume"] as const;

const backupNameFieldAliases = ["backupName", "name"] as const;
const resumeModeFieldAliases = ["restoreMode", "mode"] as const;

export type ResumeRestoreMode = "fresh" | "latest" | "named";

export type MutatingActionPayloadValidationReason =
  | "malformed_json"
  | "non_object_json"
  | "invalid_field_type"
  | "invalid_field_value"
  | "conflicting_aliases"
  | "unknown_field";

export class MutatingActionPayloadValidationError extends Error {
  readonly code = "invalid_payload";

  constructor(
    message: string,
    readonly reason: MutatingActionPayloadValidationReason,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MutatingActionPayloadValidationError";
  }
}

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
  const rawBody = await request.clone().text();
  if (rawBody.trim().length === 0) {
    return {};
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (cause) {
    throw new MutatingActionPayloadValidationError("Request body must contain valid JSON", "malformed_json", {
      cause,
    });
  }

  if (!isObjectRecord(body)) {
    throw new MutatingActionPayloadValidationError("Request body must be a JSON object", "non_object_json");
  }

  return body;
}

export function isMutatingActionPayloadValidationError(error: unknown): error is MutatingActionPayloadValidationError {
  return error instanceof MutatingActionPayloadValidationError;
}

export function normalizeAndSanitizeBackupName(body: Record<string, unknown>): string | undefined {
  const values: string[] = [];
  for (const field of backupNameFieldAliases) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string") {
      throw new MutatingActionPayloadValidationError(`${field} must be a string`, "invalid_field_type");
    }
    const candidate = normalizeOptionalString(body[field]);
    if (candidate) values.push(sanitizeBackupName(candidate));
  }

  if (new Set(values).size > 1) {
    throw new MutatingActionPayloadValidationError("backupName and name must not conflict", "conflicting_aliases");
  }
  return values[0];
}

function normalizeResumeRestoreMode(body: Record<string, unknown>): ResumeRestoreMode | undefined {
  const values: ResumeRestoreMode[] = [];
  for (const field of resumeModeFieldAliases) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string") {
      throw new MutatingActionPayloadValidationError(`${field} must be a string`, "invalid_field_type");
    }
    const candidate = normalizeOptionalString(body[field]);
    if (!candidate) {
      continue;
    }

    const normalized = candidate.toLowerCase();
    if (normalized === "fresh" || normalized === "latest" || normalized === "named") {
      values.push(normalized);
      continue;
    }

    throw new Error("Restore mode must be one of: fresh, latest, named");
  }

  if (new Set(values).size > 1) {
    throw new MutatingActionPayloadValidationError("restoreMode and mode must not conflict", "conflicting_aliases");
  }
  return values[0];
}

const allowedFieldsByAction: Record<MutatingActionType, ReadonlySet<string>> = {
  start: new Set(),
  stop: new Set(),
  hibernate: new Set(),
  backup: new Set(backupNameFieldAliases),
  restore: new Set(backupNameFieldAliases),
  resume: new Set([...backupNameFieldAliases, ...resumeModeFieldAliases]),
};

function rejectUnknownFields(body: Record<string, unknown>, action: MutatingActionType): void {
  const unknownField = Object.keys(body).find((field) => !allowedFieldsByAction[action].has(field));
  if (unknownField) {
    throw new MutatingActionPayloadValidationError(
      `${unknownField} is not allowed for ${action} requests`,
      "unknown_field"
    );
  }
}

export async function parseMutatingActionRequestPayload<TAction extends MutatingActionType>(
  request: NextRequest,
  action: TAction
): Promise<MutatingActionRequestPayloadByType[TAction]> {
  const body = await parseOptionalMutatingJsonBody(request);
  rejectUnknownFields(body, action);

  if (action === "backup" || action === "restore" || action === "resume") {
    if (
      action === "restore" &&
      backupNameFieldAliases.some(
        (field) => Object.hasOwn(body, field) && typeof body[field] === "string" && body[field].trim().length === 0
      )
    ) {
      throw new MutatingActionPayloadValidationError("Backup name cannot be empty", "invalid_field_value");
    }
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
