import { describe, expect, it } from "vitest";
import { validateEnv } from "./validate-env";

const baseWorkerValues: Record<string, string> = {
  AWS_REGION: "us-east-1",
  CLOUDFLARE_ZONE_ID: "zone-id",
  CLOUDFLARE_RECORD_ID: "record-id",
  CLOUDFLARE_MC_DOMAIN: "mc.example.com",
  CLOUDFLARE_DNS_API_TOKEN: "token",
  RUNTIME_STATE_SNAPSHOT_KV_ID: "0123456789abcdef0123456789abcdef",
  AUTH_SECRET: "very-secret-value",
  ADMIN_EMAIL: "admin@example.com",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  NEXT_PUBLIC_APP_URL: "https://panel.example.com",
};

describe("scripts/validate-env", () => {
  it("fails closed for production strict validation", () => {
    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "production",
        values: {
          ...baseWorkerValues,
          ADMIN_EMAIL: "not-an-email",
        },
      })
    ).toThrow("Strict environment validation failed.");
  });

  it("fails closed in production when required worker vars are missing", () => {
    const { AUTH_SECRET, ...withoutAuthSecret } = baseWorkerValues;
    void AUTH_SECRET;

    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "production",
        values: withoutAuthSecret,
      })
    ).toThrow("Strict environment validation failed.");
  });

  it("warns without throwing in non-production", () => {
    const { AUTH_SECRET, ...withoutAuthSecret } = baseWorkerValues;
    void AUTH_SECRET;

    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "development",
        values: withoutAuthSecret,
      })
    ).not.toThrow();
  });

  it("fails closed in strict production when placeholders remain", () => {
    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "production",
        values: {
          ...baseWorkerValues,
          NEXT_PUBLIC_APP_URL: "https://panel.yourdomain.com",
        },
      })
    ).toThrow("Strict environment validation failed.");
  });
});
