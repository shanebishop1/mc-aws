import { setRuntimeBackendMode } from "@/lib/runtime-backend-mode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionRuntimeBackupControlAdapter } from "./backup-control";
import { getRuntimeBackupControlAdapter } from "./backup-provider";

describe("Worker runtime backup provider selection", () => {
  afterEach(() => {
    setRuntimeBackendMode(undefined);
    vi.unstubAllEnvs();
  });

  it("selects the configured production adapter from the Worker backend binding", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "lifecycle-lock-table");
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operation-state-table");
    vi.stubEnv("MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8", "private-key");
    vi.stubEnv("MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS", "verifiers");
    setRuntimeBackendMode("aws");

    expect(getRuntimeBackupControlAdapter()).toBeInstanceOf(ProductionRuntimeBackupControlAdapter);
  });
});
