import { generateKeyPairSync } from "node:crypto";
import {
  getEnvVarNamesByRequirement,
  parseBackendMode,
  resolveEnvValue,
  validateEnvForTarget,
  validateRuntimeStateWranglerConfig,
  workerManagedAwsCredentialSecretNames,
  workerSecretAllowlist,
  workerVariableAllowlist,
} from "@/lib/runtime-config-schema";
import { describe, expect, it } from "vitest";

const backupFencePrivateKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");

const publicProviderCatalog = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      schemaVersion: 1,
      profileId: "reviewed-provider",
      providerId: "reviewed-openai-api",
      providerKind: "openai-compatible",
      displayName: "Reviewed provider",
      endpoint: "https://provider.example.com",
      allowedModels: ["reviewed-model"],
      supportedFeatures: ["streaming", "tools"],
    },
  ],
});
const runtimeProviderProfiles = publicProviderCatalog;
const validAuthSecret = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";
const enabledWorkerRuntime = {
  MC_AGENT_RUNTIME_ENABLED: "true",
  MC_AGENT_RUNTIME_ID: "minecraft-gateway",
  MC_AGENT_RUNTIME_TOKEN_SHA256: "ab".repeat(32),
  MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8: backupFencePrivateKey,
  MC_AGENT_PUBLIC_PROVIDER_CATALOG: publicProviderCatalog,
  MC_AGENT_RUNTIME_PROVIDER_PROFILES: runtimeProviderProfiles,
};

describe("runtime-config-schema", () => {
  it("keeps MC_BACKEND_MODE as an allowlisted non-secret Worker variable", () => {
    expect(workerVariableAllowlist).toEqual(["MC_BACKEND_MODE"]);
    expect(workerSecretAllowlist).not.toContain("MC_BACKEND_MODE");
  });

  describe("parseBackendMode", () => {
    it("parses allowed backend modes", () => {
      expect(parseBackendMode("aws")).toBe("aws");
      expect(parseBackendMode("MOCK")).toBe("mock");
    });

    it("throws for unsupported backend modes", () => {
      expect(() => parseBackendMode("invalid")).toThrow(
        'Invalid MC_BACKEND_MODE value: "invalid". Must be "aws" or "mock".'
      );
    });
  });

  describe("resolveEnvValue", () => {
    it("resolves primary values", () => {
      const resolved = resolveEnvValue(
        {
          CLOUDFLARE_DNS_API_TOKEN: "primary-token",
        },
        "CLOUDFLARE_DNS_API_TOKEN"
      );

      expect(resolved?.value).toBe("primary-token");
      expect(resolved?.usedAlias).toBe(false);
      expect(resolved?.sourceName).toBe("CLOUDFLARE_DNS_API_TOKEN");
    });

    it("resolves deprecated alias values", () => {
      const resolved = resolveEnvValue(
        {
          CLOUDFLARE_API_TOKEN: "legacy-token",
        },
        "CLOUDFLARE_DNS_API_TOKEN"
      );

      expect(resolved?.value).toBe("legacy-token");
      expect(resolved?.usedAlias).toBe(true);
      expect(resolved?.sourceName).toBe("CLOUDFLARE_API_TOKEN");
    });
  });

  describe("target validation", () => {
    it("returns required CI variables from the schema", () => {
      expect(getEnvVarNamesByRequirement("ci", "required")).toEqual([
        "AUTH_SECRET",
        "ADMIN_EMAIL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "NEXT_PUBLIC_APP_URL",
      ]);
    });

    it("leaves runtime-state kv namespace ids to generated deploy bindings", () => {
      expect(getEnvVarNamesByRequirement("worker", "required")).toEqual(
        expect.arrayContaining(["MC_LIFECYCLE_LOCK_TABLE_NAME", "MC_OPERATION_STATE_TABLE_NAME"])
      );
      expect(getEnvVarNamesByRequirement("worker", "required")).not.toEqual(
        expect.arrayContaining(["RUNTIME_STATE_SNAPSHOT_KV_ID", "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID"])
      );
      expect(getEnvVarNamesByRequirement("worker", "optional")).toEqual(
        expect.arrayContaining(["RUNTIME_STATE_SNAPSHOT_KV_ID", "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID"])
      );
      expect(getEnvVarNamesByRequirement("worker", "required")).not.toEqual(
        expect.arrayContaining(["CLOUDFLARE_ZONE_ID", "CLOUDFLARE_MC_DOMAIN", "CLOUDFLARE_DNS_API_TOKEN"])
      );
    });

    it("accepts no-domain mode when neither DNS provider is configured", () => {
      const report = validateEnvForTarget(
        {
          AWS_REGION: "us-east-1",
          MC_LIFECYCLE_LOCK_TABLE_NAME: "lifecycle-lock-table",
          MC_OPERATION_STATE_TABLE_NAME: "operation-state-table",
          MC_AGENT_RUNTIME_ENABLED: "false",
          RUNTIME_STATE_SNAPSHOT_KV_ID: "0123456789abcdef0123456789abcdef",
          AUTH_SECRET: validAuthSecret,
          ADMIN_EMAIL: "admin@real-domain.dev",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          NEXT_PUBLIC_APP_URL: "https://panel.real-domain.dev",
        },
        "worker"
      );

      expect(report.issues).toEqual([]);
    });

    it("validates immutable AMI and bootstrap pin provenance values", () => {
      expect(
        validateEnvForTarget(
          {
            AL2023_ARM64_AMI_ID: `ami-${"1".repeat(17)}`,
            MC_BOOTSTRAP_PINS_SHA256: "a1".repeat(32),
          },
          "local-dev"
        ).issues
      ).toEqual([]);

      expect(
        validateEnvForTarget(
          {
            AL2023_ARM64_AMI_ID: "latest",
            MC_BOOTSTRAP_PINS_SHA256: "0".repeat(64),
          },
          "local-dev"
        ).issues
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "AL2023_ARM64_AMI_ID", kind: "invalid" }),
          expect.objectContaining({ name: "MC_BOOTSTRAP_PINS_SHA256", kind: "invalid" }),
        ])
      );
    });

    it("enforces the agent runtime verifier and raw-secret ownership boundary", () => {
      expect(
        validateEnvForTarget(
          {
            ...enabledWorkerRuntime,
            MC_AGENT_RUNTIME_ID: "minecraft-gateway",
            MC_AGENT_RUNTIME_TOKEN_SHA256: "ab".repeat(32),
          },
          "worker"
        ).issues
      ).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "MC_AGENT_RUNTIME_ID" })]));
      expect(
        validateEnvForTarget(
          {
            MC_AGENT_RUNTIME_ENABLED: "true",
            MC_AGENT_RUNTIME_ID: "minecraft-gateway",
            MC_AGENT_RUNTIME_TOKEN: "raw-gateway-token-with-more-than-thirty-two-characters",
          },
          "worker"
        ).issues
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "MC_AGENT_RUNTIME_TOKEN", kind: "forbidden" }),
          expect.objectContaining({ name: "MC_AGENT_RUNTIME_TOKEN_SHA256", kind: "missing" }),
          expect.objectContaining({ name: "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8", kind: "missing" }),
        ])
      );
    });

    it("requires explicit Worker runtime state and complete enabled configuration", () => {
      expect(validateEnvForTarget({}, "worker").issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "MC_AGENT_RUNTIME_ENABLED", kind: "missing" })])
      );
      expect(
        validateEnvForTarget(
          {
            MC_AGENT_RUNTIME_ENABLED: "true",
            MC_AGENT_RUNTIME_ID: "minecraft-gateway",
          },
          "worker"
        ).issues
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "MC_AGENT_RUNTIME_TOKEN_SHA256", kind: "missing" }),
          expect.objectContaining({ name: "MC_AGENT_PUBLIC_PROVIDER_CATALOG", kind: "missing" }),
          expect.objectContaining({ name: "MC_AGENT_RUNTIME_PROVIDER_PROFILES", kind: "missing" }),
        ])
      );
      expect(
        validateEnvForTarget(
          {
            MC_AGENT_RUNTIME_ENABLED: "false",
            MC_AGENT_RUNTIME_ID: "retained-old-runtime",
            MC_AGENT_RUNTIME_TOKEN_SHA256: "not-a-valid-retained-hash",
          },
          "worker"
        ).issues.filter(({ name }) => name.startsWith("MC_AGENT_"))
      ).toEqual([]);
    });

    it("validates bounded credential-free Agent provider metadata for Worker ownership", () => {
      const validReport = validateEnvForTarget(
        {
          ...enabledWorkerRuntime,
        },
        "worker"
      );
      expect(
        validReport.issues.filter(
          ({ name }) => name === "MC_AGENT_PUBLIC_PROVIDER_CATALOG" || name === "MC_AGENT_RUNTIME_PROVIDER_PROFILES"
        )
      ).toEqual([]);

      const sensitiveCatalog = publicProviderCatalog.replace(
        '"endpoint"',
        '"credentialRef":"secret-ref:providers/reviewed","endpoint"'
      );
      expect(
        validateEnvForTarget(
          {
            ...enabledWorkerRuntime,
            MC_AGENT_PUBLIC_PROVIDER_CATALOG: sensitiveCatalog,
            MC_AGENT_RUNTIME_PROVIDER_PROFILES: runtimeProviderProfiles,
          },
          "worker"
        ).issues
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "MC_AGENT_PUBLIC_PROVIDER_CATALOG", kind: "invalid" })])
      );

      expect(
        validateEnvForTarget(
          {
            ...enabledWorkerRuntime,
            MC_AGENT_PUBLIC_PROVIDER_CATALOG: `${publicProviderCatalog}${" ".repeat(64_001)}`,
            MC_AGENT_RUNTIME_PROVIDER_PROFILES: runtimeProviderProfiles,
          },
          "worker"
        ).issues
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "MC_AGENT_PUBLIC_PROVIDER_CATALOG", kind: "invalid" })])
      );

      expect(
        validateEnvForTarget(
          {
            ...enabledWorkerRuntime,
            MC_AGENT_PUBLIC_PROVIDER_CATALOG: publicProviderCatalog,
            MC_AGENT_RUNTIME_PROVIDER_PROFILES: `${runtimeProviderProfiles}${" ".repeat(64_001)}`,
          },
          "worker"
        ).issues
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "MC_AGENT_RUNTIME_PROVIDER_PROFILES", kind: "invalid" }),
        ])
      );
    });

    it("forbids Worker-only Agent provider metadata on Lambda and EC2", () => {
      for (const target of ["lambda", "ec2"] as const) {
        expect(
          validateEnvForTarget(
            {
              MC_AGENT_PUBLIC_PROVIDER_CATALOG: publicProviderCatalog,
              MC_AGENT_RUNTIME_PROVIDER_PROFILES: runtimeProviderProfiles,
            },
            target
          ).issues
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "MC_AGENT_PUBLIC_PROVIDER_CATALOG", kind: "forbidden" }),
            expect.objectContaining({ name: "MC_AGENT_RUNTIME_PROVIDER_PROFILES", kind: "forbidden" }),
          ])
        );
      }
    });

    it("accepts complete DuckDNS config", () => {
      const report = validateEnvForTarget(
        {
          DUCKDNS_DOMAIN: "myserver",
          DUCKDNS_TOKEN: "duck-token",
        },
        "local-dev"
      );

      expect(report.issues).toEqual([]);
    });

    it("accepts Cloudflare Minecraft DNS without the legacy record id", () => {
      const report = validateEnvForTarget(
        {
          CLOUDFLARE_ZONE_ID: "zone-id",
          CLOUDFLARE_MC_DOMAIN: "mc.example.com",
          CLOUDFLARE_DNS_API_TOKEN: "cf-token",
        },
        "local-dev"
      );

      expect(report.issues).toEqual([]);
    });

    it("validates disabled, notifications-only, and inbound SES capability modes", () => {
      expect(
        validateEnvForTarget(
          {
            SES_NOTIFICATIONS_ENABLED: "false",
            SES_INBOUND_COMMANDS_ENABLED: "false",
          },
          "local-dev"
        ).issues
      ).toEqual([]);

      expect(
        validateEnvForTarget(
          {
            SES_NOTIFICATIONS_ENABLED: "true",
            VERIFIED_SENDER: "sender@real-domain.dev",
            NOTIFICATION_EMAIL: "operator@real-domain.dev",
          },
          "local-dev"
        ).issues
      ).toEqual([]);

      expect(
        validateEnvForTarget(
          {
            SES_INBOUND_COMMANDS_ENABLED: "true",
            SES_INBOUND_RECIPIENT: "commands@real-domain.dev",
            SES_RECEIPT_RULE_SET_NAME: "operator-managed-rules",
            START_KEYWORD: "private-start-keyword",
          },
          "local-dev"
        ).issues
      ).toEqual([]);
    });

    it("rejects incomplete enabled SES capabilities", () => {
      const report = validateEnvForTarget(
        {
          SES_NOTIFICATIONS_ENABLED: "true",
          SES_INBOUND_COMMANDS_ENABLED: "true",
        },
        "local-dev"
      );

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "VERIFIED_SENDER", kind: "missing" }),
          expect.objectContaining({ name: "SES_INBOUND_RECIPIENT", kind: "missing" }),
        ])
      );
    });

    it("validates scheduled backup and alarm configuration", () => {
      expect(
        validateEnvForTarget(
          {
            MC_SCHEDULED_BACKUP_ENABLED: "true",
            MC_SCHEDULED_BACKUP_SCHEDULE: "cron(0 5 ? * SUN *)",
            MC_BACKUP_STALE_AFTER_HOURS: "192",
            MC_ALARM_EMAIL: "operator@real-domain.dev",
          },
          "local-dev"
        ).issues
      ).toEqual([]);

      const invalid = validateEnvForTarget(
        {
          MC_SCHEDULED_BACKUP_SCHEDULE: "every sunday",
          MC_BACKUP_STALE_AFTER_HOURS: "24",
          MC_ALARM_EMAIL: "not-an-email",
        },
        "local-dev"
      );
      expect(invalid.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "MC_ALARM_EMAIL", kind: "invalid" }),
          expect.objectContaining({ name: "MC_SCHEDULED_BACKUP_SCHEDULE", kind: "invalid" }),
          expect.objectContaining({ name: "MC_BACKUP_STALE_AFTER_HOURS", kind: "invalid" }),
        ])
      );
    });

    it("rejects mixed Cloudflare and DuckDNS config", () => {
      const report = validateEnvForTarget(
        {
          CLOUDFLARE_ZONE_ID: "zone-id",
          CLOUDFLARE_RECORD_ID: "record-id",
          CLOUDFLARE_MC_DOMAIN: "mc.example.com",
          CLOUDFLARE_DNS_API_TOKEN: "cf-token",
          DUCKDNS_DOMAIN: "myserver",
          DUCKDNS_TOKEN: "duck-token",
        },
        "local-dev"
      );

      expect(report.issues).toEqual([
        expect.objectContaining({
          kind: "invalid",
          message: expect.stringContaining("mutually exclusive"),
        }),
      ]);
    });

    it("rejects partial DNS provider config", () => {
      const duckDnsReport = validateEnvForTarget({ DUCKDNS_DOMAIN: "myserver" }, "local-dev");
      expect(duckDnsReport.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "missing",
            message: expect.stringContaining("DuckDNS configuration is incomplete"),
          }),
        ])
      );

      const cloudflareReport = validateEnvForTarget({ CLOUDFLARE_MC_DOMAIN: "mc.example.com" }, "local-dev");
      expect(cloudflareReport.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "missing",
            message: expect.stringContaining("Cloudflare DNS configuration is incomplete"),
          }),
        ])
      );
    });

    it("reports missing and invalid values for target", () => {
      const report = validateEnvForTarget(
        {
          ADMIN_EMAIL: "not-an-email",
          AUTH_SECRET: "secret",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          NEXT_PUBLIC_APP_URL: "not-a-url",
        },
        "ci"
      );

      expect(report.issues.map((issue) => issue.kind)).toEqual(["invalid", "invalid", "invalid"]);
      expect(report.issues.map((issue) => issue.name)).toEqual(["AUTH_SECRET", "ADMIN_EMAIL", "NEXT_PUBLIC_APP_URL"]);
    });

    it.each([
      "short",
      "z".repeat(64),
      "correct-horse-battery-staple-correct-horse-battery-staple",
      "0123456789abcdef0123456789abcdef",
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
      "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk=",
    ])("rejects a weak production AUTH_SECRET: %s", (AUTH_SECRET) => {
      const report = validateEnvForTarget({ AUTH_SECRET }, "worker");
      expect(report.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "AUTH_SECRET", kind: "invalid" })])
      );
    });

    it("does not apply production AUTH_SECRET strength policy to local development", () => {
      expect(validateEnvForTarget({ AUTH_SECRET: "local-only" }, "local-dev").issues).toEqual([]);
    });

    it("reports placeholder values for worker target", () => {
      const report = validateEnvForTarget(
        {
          AWS_REGION: "us-east-1",
          CLOUDFLARE_ZONE_ID: "your-zone-id",
          CLOUDFLARE_RECORD_ID: "your-record-id",
          CLOUDFLARE_MC_DOMAIN: "mc.yourdomain.com",
          CLOUDFLARE_DNS_API_TOKEN: "your-cloudflare-api-token",
          RUNTIME_STATE_SNAPSHOT_KV_ID: "your-runtime-state-kv-id",
          MC_AGENT_RUNTIME_ENABLED: "false",
          AUTH_SECRET: validAuthSecret,
          ADMIN_EMAIL: "admin@real-domain.dev",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          NEXT_PUBLIC_APP_URL: "https://panel.yourdomain.com",
        },
        "worker"
      );

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "CLOUDFLARE_ZONE_ID", kind: "invalid" }),
          expect.objectContaining({ name: "NEXT_PUBLIC_APP_URL", kind: "invalid" }),
          expect.objectContaining({ name: "RUNTIME_STATE_SNAPSHOT_KV_ID", kind: "invalid" }),
        ])
      );
    });

    it("marks forbidden values for local-dev target", () => {
      const report = validateEnvForTarget(
        {
          ENABLE_DEV_LOGIN: "true",
        },
        "worker"
      );

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "forbidden",
            name: "ENABLE_DEV_LOGIN",
          }),
        ])
      );
    });
  });

  describe("runtime-state wrangler schema validation", () => {
    it("validates generated deploy config durable object, kv, and migration bindings", () => {
      const report = validateRuntimeStateWranglerConfig({
        durable_objects: {
          bindings: [
            {
              name: "RUNTIME_STATE_DURABLE_OBJECT",
              class_name: "RuntimeStateDurableObject",
            },
            {
              name: "AGENT_SESSION_DURABLE_OBJECT",
              class_name: "AgentSessionDurableObject",
            },
            {
              name: "AGENT_SESSION_INDEX_DURABLE_OBJECT",
              class_name: "AgentSessionIndexDurableObject",
            },
            {
              name: "AGENT_SESSION_SHARD_DURABLE_OBJECT",
              class_name: "AgentSessionShardDurableObject",
            },
          ],
        },
        kv_namespaces: [
          {
            binding: "RUNTIME_STATE_SNAPSHOT_KV",
            id: "0123456789abcdef0123456789abcdef",
            preview_id: "fedcba9876543210fedcba9876543210",
          },
        ],
        migrations: [
          {
            tag: "v1-runtime-state-durable-object",
            new_sqlite_classes: ["RuntimeStateDurableObject"],
          },
          {
            tag: "v2-agent-session-durable-object",
            new_sqlite_classes: ["AgentSessionDurableObject"],
          },
          {
            tag: "v3-agent-session-shards",
            new_sqlite_classes: ["AgentSessionIndexDurableObject", "AgentSessionShardDurableObject"],
          },
        ],
      });

      expect(report.isValid).toBe(true);
      expect(report.errors).toEqual([]);
    });

    it("fails when required runtime-state config entries are missing", () => {
      const report = validateRuntimeStateWranglerConfig({
        durable_objects: {
          bindings: [],
        },
        kv_namespaces: [],
        migrations: [],
      });

      expect(report.isValid).toBe(false);
      expect(report.errors).toHaveLength(9);
    });

    it("fails when runtime-state kv binding uses placeholder ids", () => {
      const report = validateRuntimeStateWranglerConfig({
        durable_objects: {
          bindings: [
            {
              name: "RUNTIME_STATE_DURABLE_OBJECT",
              class_name: "RuntimeStateDurableObject",
            },
            {
              name: "AGENT_SESSION_DURABLE_OBJECT",
              class_name: "AgentSessionDurableObject",
            },
            {
              name: "AGENT_SESSION_INDEX_DURABLE_OBJECT",
              class_name: "AgentSessionIndexDurableObject",
            },
            {
              name: "AGENT_SESSION_SHARD_DURABLE_OBJECT",
              class_name: "AgentSessionShardDurableObject",
            },
          ],
        },
        kv_namespaces: [
          {
            binding: "RUNTIME_STATE_SNAPSHOT_KV",
            id: "REPLACE_WITH_RUNTIME_STATE_SNAPSHOT_KV_ID",
            preview_id: "REPLACE_WITH_RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID",
          },
        ],
        migrations: [
          {
            tag: "v1-runtime-state-durable-object",
            new_sqlite_classes: ["RuntimeStateDurableObject"],
          },
          {
            tag: "v2-agent-session-durable-object",
            new_sqlite_classes: ["AgentSessionDurableObject"],
          },
          {
            tag: "v3-agent-session-shards",
            new_sqlite_classes: ["AgentSessionIndexDurableObject", "AgentSessionShardDurableObject"],
          },
        ],
      });

      expect(report.isValid).toBe(false);
      expect(report.errors).toEqual(
        expect.arrayContaining([
          "RUNTIME_STATE_SNAPSHOT_KV id cannot use placeholder values.",
          "RUNTIME_STATE_SNAPSHOT_KV preview_id cannot use placeholder values.",
        ])
      );
    });
  });

  describe("workerSecretAllowlist", () => {
    it("contains expected production Worker secret keys", () => {
      expect(workerSecretAllowlist).toEqual(
        expect.arrayContaining([
          "AWS_REGION",
          "AUTH_SECRET",
          "CLOUDFLARE_DNS_API_TOKEN",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "NEXT_PUBLIC_APP_URL",
          "MC_AGENT_RUNTIME_ENABLED",
          "MC_AGENT_RUNTIME_ID",
          "MC_AGENT_RUNTIME_TOKEN_SHA256",
          "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8",
          "MC_AGENT_PUBLIC_PROVIDER_CATALOG",
          "MC_AGENT_RUNTIME_PROVIDER_PROFILES",
        ])
      );
    });

    it("contains unique keys", () => {
      expect(new Set(workerSecretAllowlist).size).toBe(workerSecretAllowlist.length);
    });

    it("tracks directly managed AWS runtime credentials", () => {
      expect(workerManagedAwsCredentialSecretNames).toEqual(
        expect.arrayContaining([
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID",
          "MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY",
          "MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN",
        ])
      );
    });
  });
});
