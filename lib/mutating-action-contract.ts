import { createOperationInfo } from "@/lib/operation";
import type { ReleaseServerActionLockOptions, ServerActionLock, ServerActionType } from "@/lib/server-action-lock";
import type { OperationInfo, OperationStatus, OperationType } from "@/lib/types";
import type { NextRequest } from "next/server";

export type MutatingActionType = OperationType;

export interface MutatingActionCommandPayloadByType {
  start: Record<string, never>;
  stop: Record<string, never>;
  backup: { backupName?: string };
  restore: { backupName: string };
  hibernate: Record<string, never>;
  resume: Record<string, never>;
}

export interface MutatingActionCommand<TAction extends MutatingActionType = MutatingActionType> {
  action: TAction;
  instanceId: string;
  requestedBy: string;
  payload: MutatingActionCommandPayloadByType[TAction];
}

export interface MutatingActionRequestContext<TAction extends MutatingActionType = MutatingActionType> {
  request: NextRequest;
  route: string;
  action: TAction;
  operation: OperationInfo & { type: TAction };
  requestedAt: string;
}

export interface MutatingActionOperationMetadata {
  route: string;
  action: MutatingActionType;
  operation: OperationInfo;
}

export interface MutatingActionLockManager {
  acquire(action: ServerActionType, ownerEmail: string): Promise<ServerActionLock>;
  release(lockId: string, options?: ReleaseServerActionLockOptions): Promise<boolean>;
}

export interface MutatingActionLockHandling {
  lock: ServerActionLock;
  released: boolean;
}

export interface MutatingActionExecutionSuccess<TData> {
  ok: true;
  status: Exclude<OperationStatus, "failed" | "running">;
  httpStatus: number;
  data: TData;
}

export interface MutatingActionExecutionFailure {
  ok: false;
  status: "failed";
  httpStatus: number;
  error: string;
  code?: string;
  cause?: unknown;
}

export type MutatingActionExecutionResult<TData> =
  | MutatingActionExecutionSuccess<TData>
  | MutatingActionExecutionFailure;

export interface MutatingActionResponseMappingInput<TData> {
  context: MutatingActionRequestContext;
  operation: OperationInfo;
  execution: MutatingActionExecutionResult<TData>;
  userEmail?: string;
  lock?: ServerActionLock;
}

export function createMutatingActionRequestContext<TAction extends MutatingActionType>(
  request: NextRequest,
  route: string,
  action: TAction
): MutatingActionRequestContext<TAction> {
  return {
    request,
    route,
    action,
    operation: createOperationInfo(action, "running") as OperationInfo & { type: TAction },
    requestedAt: new Date().toISOString(),
  };
}

export function createMutatingActionSuccess<TData>(
  data: TData,
  status: Exclude<OperationStatus, "failed" | "running"> = "accepted",
  httpStatus = 202
): MutatingActionExecutionSuccess<TData> {
  return {
    ok: true,
    status,
    httpStatus,
    data,
  };
}

export function createMutatingActionFailure(
  error: string,
  options?: { httpStatus?: number; code?: string; cause?: unknown }
): MutatingActionExecutionFailure {
  return {
    ok: false,
    status: "failed",
    httpStatus: options?.httpStatus ?? 500,
    error,
    code: options?.code,
    cause: options?.cause,
  };
}
