import {
  getEnvVarNamesByRequirement,
  parseBackendMode,
  resolveEnvValue,
  validateEnvForTarget,
  validateRuntimeStateWranglerConfig,
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
  });
});
