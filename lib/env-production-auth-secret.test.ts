import { afterEach, describe, expect, it, vi } from "vitest";

describe("production environment AUTH_SECRET loading", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not read an existing weak secret while importing production env", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/env");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("AUTH_SECRET", "weak-existing-secret-that-is-not-a-placeholder");
    vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://panel.example.com");
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "lifecycle-lock-table");
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operation-state-table");
    vi.stubEnv("MC_AGENT_RUNTIME_ENABLED", "false");

    const imported = await import("./env");
    expect(imported.env.AUTH_SECRET).toBe("");
  });

  it("does not capture a former noncanonical secret while importing production env", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/env");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_BACKEND_MODE", "aws");
    vi.stubEnv("AUTH_SECRET", "8f2a7c91d4e6b3085a1f9c72e4d6a8037b5c1e94f2a860d3c7e59b14a826f0d9");
    vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://panel.example.com");
    vi.stubEnv("MC_LIFECYCLE_LOCK_TABLE_NAME", "lifecycle-lock-table");
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "operation-state-table");
    vi.stubEnv("MC_AGENT_RUNTIME_ENABLED", "false");

    const imported = await import("./env");
    expect(imported.env.AUTH_SECRET).toBe("");
  });
});
