import { randomUUID } from "node:crypto";
import type { OperationInfo, OperationStatus, OperationType } from "@/lib/types";

export function createOperationId(type: OperationType): string {
  return `${type}-${Date.now()}-${randomUUID()}`;
}

export function createOperationInfo(type: OperationType, status: OperationStatus): OperationInfo {
  return {
    id: createOperationId(type),
    type,
    status,
  };
}

export function withOperationStatus(operation: OperationInfo, status: OperationStatus): OperationInfo {
  return {
    ...operation,
    status,
  };
}
