import { describe, expect, it } from "vitest";
import { validateEnv } from "./validate-env";

const baseWorkerValues: Record<string, string> = {
  AWS_REGION: "us-east-1",
  CLOUDFLARE_ZONE_ID: "zone-id",
  CLOUDFLARE_RECORD_ID: "record-id",
  CLOUDFLARE_MC_DOMAIN: "mc.example.com",
  CLOUDFLARE_DNS_API_TOKEN: "token",
  RUNTIME_STATE_SNAPSHOT_KV_ID: "0123456789abcdef0123456789abcdef",
  AUTH_SECRET: Buffer.from([
    0xd3, 0x1a, 0xf7, 0x0c, 0x5e, 0x92, 0xb8, 0x4f, 0x01, 0x69, 0xc4, 0xe7, 0xab, 0x2d, 0x53, 0x81, 0xf6, 0xa0, 0xce,
    0x9d, 0x34, 0x78, 0xb2, 0x15, 0xc7, 0xe3, 0xf9, 0x02, 0x6d, 0x4a, 0xb1, 0xe8, 0xf0, 0xc5, 0xa7, 0xd2, 0xe9, 0xb3,
    0x14, 0x68, 0x9f, 0x03, 0xdc, 0x76, 0x2a, 0xe1, 0x58, 0xc0,
  ]).toString("base64url"),
  ADMIN_EMAIL: "admin@example.com",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  NEXT_PUBLIC_APP_URL: "https://panel.example.com",
  MC_LIFECYCLE_LOCK_TABLE_NAME: "lifecycle-lock-table",
  MC_OPERATION_STATE_TABLE_NAME: "operation-state-table",
  MC_OPERATION_STATE_RETENTION_DAYS: "30",
  MC_AGENT_RUNTIME_ENABLED: "false",
};

const baseLambdaValues: Record<string, string> = {
  AWS_REGION: "us-east-1",
  AWS_ACCOUNT_ID: "123456789012",
  INSTANCE_ID: "i-abc123",
  ADMIN_EMAIL: "admin@example.com",
  MC_LIFECYCLE_LOCK_TABLE_NAME: "lifecycle-lock-table",
  MC_OPERATION_STATE_TABLE_NAME: "operation-state-table",
  MC_OPERATION_STATE_RETENTION_DAYS: "30",
};

describe("scripts/validation/validate-env", () => {
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

  it("allows lambda target validation without VERIFIED_SENDER", () => {
    expect(() =>
      validateEnv({
        strict: true,
        target: "lambda",
        nodeEnv: "production",
        values: baseLambdaValues,
      })
    ).not.toThrow();
  });

  it("allows strict production no-domain worker config", () => {
    const { CLOUDFLARE_DNS_API_TOKEN, CLOUDFLARE_MC_DOMAIN, CLOUDFLARE_RECORD_ID, CLOUDFLARE_ZONE_ID, ...values } =
      baseWorkerValues;
    void CLOUDFLARE_DNS_API_TOKEN;
    void CLOUDFLARE_MC_DOMAIN;
    void CLOUDFLARE_RECORD_ID;
    void CLOUDFLARE_ZONE_ID;

    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "production",
        values,
      })
    ).not.toThrow();
  });

  it("accepts external panel DNS management as deploy-only worker configuration", () => {
    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "production",
        values: {
          ...baseWorkerValues,
          PANEL_DNS_MANAGEMENT: "external",
        },
      })
    ).not.toThrow();
  });

  it("fails strict production when DNS providers are mixed", () => {
    expect(() =>
      validateEnv({
        strict: true,
        target: "worker",
        nodeEnv: "production",
        values: {
          ...baseWorkerValues,
          DUCKDNS_DOMAIN: "myserver",
          DUCKDNS_TOKEN: "duck-token",
        },
      })
    ).toThrow("Strict environment validation failed.");
  });
});
