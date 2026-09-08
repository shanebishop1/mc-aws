import { getRuntimeBackendMode } from "@/lib/runtime-backend-mode";
import { validateWorkerStartupEnvironment } from "@/lib/worker-startup";
import { describe, expect, it } from "vitest";

const validAuthSecret = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";

describe("Worker startup boundary", () => {
  it("requires the canonical AWS backend binding", () => {
    expect(() => validateWorkerStartupEnvironment({ AUTH_SECRET: validAuthSecret })).toThrow(
      'MC_BACKEND_MODE must be the canonical Worker value "aws".'
    );
    expect(() => validateWorkerStartupEnvironment({ MC_BACKEND_MODE: "mock", AUTH_SECRET: validAuthSecret })).toThrow();
  });

  it("requires a valid runtime auth secret before publishing the backend binding", () => {
    expect(() => validateWorkerStartupEnvironment({ MC_BACKEND_MODE: "aws" })).toThrow(
      "AUTH_SECRET is required at Worker startup."
    );
    validateWorkerStartupEnvironment({ MC_BACKEND_MODE: "aws", AUTH_SECRET: validAuthSecret });
    expect(getRuntimeBackendMode()).toBe("aws");
  });
});
