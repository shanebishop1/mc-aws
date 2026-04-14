import { createMutatingActionFailure, createMutatingActionSuccess } from "@/lib/mutating-action-contract";
import {
  createMutatingActionLockConflictFailure,
  mapMutatingActionExecutionToApiResponse,
  mapMutatingActionHttpStatus,
  mutatingActionLockConflictMessage,
} from "@/lib/mutating-action-response";
import { createOperationInfo } from "@/lib/operation";
import type { ApiResponse } from "@/lib/types";
import { parseNextResponse } from "@/tests/utils";
import { describe, expect, it } from "vitest";

describe("mutating-action-response", () => {
  it("maps operation statuses to canonical HTTP statuses", () => {
    expect(mapMutatingActionHttpStatus("accepted")).toBe(202);
    expect(mapMutatingActionHttpStatus("running")).toBe(202);
    expect(mapMutatingActionHttpStatus("completed")).toBe(200);
    expect(mapMutatingActionHttpStatus("failed")).toBe(500);
  });

  it("maps success execution to consistent payload shape and operation status", async () => {
    const operation = createOperationInfo("start", "running");
    const response = mapMutatingActionExecutionToApiResponse(
      operation,
      createMutatingActionSuccess({ instanceId: "i-123", message: "ok" }, "accepted")
    );

    expect(response.status).toBe(202);
    const payload = await parseNextResponse<ApiResponse<{ instanceId: string; message: string }>>(response);

    expect(payload.success).toBe(true);
    expect(payload.data).toEqual({ instanceId: "i-123", message: "ok" });
    expect(payload.operation).toMatchObject({
      type: "start",
      status: "accepted",
    });
  });

  it("maps completed success to 200 even when execution helper defaulted to accepted-status HTTP code", async () => {
    const operation = createOperationInfo("hibernate", "running");
    const response = mapMutatingActionExecutionToApiResponse(
      operation,
      createMutatingActionSuccess({ message: "already hibernating" }, "completed")
    );

    expect(response.status).toBe(200);
    const payload = await parseNextResponse<ApiResponse<{ message: string }>>(response);
    expect(payload.success).toBe(true);
    expect(payload.operation?.status).toBe("completed");
  });

  it("maps explicit failure status and payload consistently", async () => {
    const operation = createOperationInfo("backup", "running");
    const response = mapMutatingActionExecutionToApiResponse(
      operation,
      createMutatingActionFailure("Bad request", { httpStatus: 400, code: "invalid_state" })
    );

    expect(response.status).toBe(400);
    const payload = await parseNextResponse<ApiResponse<unknown>>(response);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Bad request");
    expect(payload.operation).toMatchObject({
      type: "backup",
      status: "failed",
    });
  });

  it("creates lock conflict failures with shared message and status", () => {
    const failure = createMutatingActionLockConflictFailure(new Error("lock"));

    expect(failure.ok).toBe(false);
    expect(failure.error).toBe(mutatingActionLockConflictMessage);
    expect(failure.httpStatus).toBe(409);
    expect(failure.code).toBe("action_in_progress");
  });
});
