import { assertProductionAuthSecret } from "@/lib/auth-secret";
import { setRuntimeAuthSecret } from "@/lib/runtime-auth-secret";
import { setRuntimeBackendMode } from "@/lib/runtime-backend-mode";
import { parseBackendMode } from "@/lib/runtime-config-schema";

export const validateWorkerStartupEnvironment = (environment: Record<string, unknown>): void => {
  const backendMode = typeof environment.MC_BACKEND_MODE === "string" ? environment.MC_BACKEND_MODE.trim() : "";
  if (backendMode !== "aws") {
    if (backendMode) parseBackendMode(backendMode);
    throw new Error('MC_BACKEND_MODE must be the canonical Worker value "aws".');
  }
  const authSecret = typeof environment.AUTH_SECRET === "string" ? environment.AUTH_SECRET : undefined;
  if (!authSecret) throw new Error("AUTH_SECRET is required at Worker startup.");
  setRuntimeBackendMode("aws");
  setRuntimeAuthSecret(assertProductionAuthSecret(authSecret));
};
