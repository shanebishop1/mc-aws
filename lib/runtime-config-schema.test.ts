import {
  getEnvVarNamesByRequirement,
  parseBackendMode,
  resolveEnvValue,
  validateEnvForTarget,
  validateRuntimeStateWranglerConfig,
  workerSecretAllowlist,
} from "@/lib/runtime-config-schema";
import { describe, expect, it } from "vitest";

describe("runtime-config-schema", () => {
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

    it("marks runtime-state kv namespace ids as required for worker target", () => {
      expect(getEnvVarNamesByRequirement("worker", "required")).toEqual(
        expect.arrayContaining(["RUNTIME_STATE_SNAPSHOT_KV_ID"])
      );
      expect(getEnvVarNamesByRequirement("worker", "required")).not.toEqual(
        expect.arrayContaining(["CLOUDFLARE_ZONE_ID", "CLOUDFLARE_MC_DOMAIN", "CLOUDFLARE_DNS_API_TOKEN"])
      );
    });

    it("accepts no-domain mode when neither DNS provider is configured", () => {
      const report = validateEnvForTarget(
        {
          AWS_REGION: "us-east-1",
          RUNTIME_STATE_SNAPSHOT_KV_ID: "0123456789abcdef0123456789abcdef",
          AUTH_SECRET: "very-secret-value",
          ADMIN_EMAIL: "admin@real-domain.dev",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret",
          NEXT_PUBLIC_APP_URL: "https://panel.real-domain.dev",
        },
        "worker"
      );

      expect(report.issues).toEqual([]);
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
        expect.objectContaining({ kind: "missing", message: expect.stringContaining("DuckDNS configuration is incomplete") }),
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

      expect(report.issues.map((issue) => issue.kind)).toEqual(["invalid", "invalid"]);
      expect(report.issues.map((issue) => issue.name)).toEqual(["ADMIN_EMAIL", "NEXT_PUBLIC_APP_URL"]);
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
          AUTH_SECRET: "very-secret-value",
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
    it("validates expected durable object/kv/migration config", () => {
      const report = validateRuntimeStateWranglerConfig({
        durable_objects: {
          bindings: [
            {
              name: "RUNTIME_STATE_DURABLE_OBJECT",
              class_name: "RuntimeStateDurableObject",
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
      expect(report.errors).toHaveLength(3);
    });

    it("fails when runtime-state kv binding uses placeholder ids", () => {
      const report = validateRuntimeStateWranglerConfig({
        durable_objects: {
          bindings: [
            {
              name: "RUNTIME_STATE_DURABLE_OBJECT",
              class_name: "RuntimeStateDurableObject",
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
        ])
      );
    });

    it("contains unique keys", () => {
      expect(new Set(workerSecretAllowlist).size).toBe(workerSecretAllowlist.length);
    });
  });
});
