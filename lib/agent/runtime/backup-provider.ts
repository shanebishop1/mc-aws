import {
  DeterministicRuntimeBackupControlAdapter,
  ProductionRuntimeBackupControlAdapter,
  type RuntimeBackupControlAdapter,
} from "@/lib/agent/runtime/backup-control";
import { AgentRuntimeService } from "@/lib/agent/runtime/service";
import { getAgentSessionStore } from "@/lib/agent/state";
import { getProvider } from "@/lib/aws/provider-selector";
import { getRuntimeBackendMode } from "@/lib/runtime-backend-mode";

export function getRuntimeBackupControlAdapter(): RuntimeBackupControlAdapter {
  const backendMode = getRuntimeBackendMode() ?? process.env.MC_BACKEND_MODE?.trim().toLowerCase();
  if (backendMode === "mock" || process.env.NODE_ENV === "test") {
    return new DeterministicRuntimeBackupControlAdapter();
  }
  const ownerEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const configured =
    backendMode === "aws" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) &&
    Boolean(process.env.MC_LIFECYCLE_LOCK_TABLE_NAME?.trim()) &&
    Boolean(process.env.MC_OPERATION_STATE_TABLE_NAME?.trim()) &&
    Boolean(process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8?.trim()) &&
    Boolean(process.env.MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS?.trim());
  return new ProductionRuntimeBackupControlAdapter({
    provider: getProvider(),
    ownerEmail: ownerEmail || "unavailable@agent.invalid",
    configured,
    assertCurrentAuthority: async (input) =>
      await new AgentRuntimeService(await getAgentSessionStore()).assertBackupBinding(input.runtimeId, input),
  });
}
