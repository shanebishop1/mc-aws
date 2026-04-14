import {
  getRuntimeStateAdapter,
  hasCloudflareRuntimeStateBindings,
  selectRuntimeStateAdapterKind,
} from "@/lib/runtime-state";
import { afterEach, describe, expect, it } from "vitest";

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol];
});

describe("runtime-state provider selector", () => {
  describe("hasCloudflareRuntimeStateBindings", () => {
    it("returns false when bindings are missing", () => {
      expect(hasCloudflareRuntimeStateBindings(undefined)).toBe(false);
      expect(hasCloudflareRuntimeStateBindings(null)).toBe(false);
      expect(hasCloudflareRuntimeStateBindings({})).toBe(false);
    });

    it("returns true when durable object binding is present", () => {
      expect(
        hasCloudflareRuntimeStateBindings({
          durableObjectNamespace: {
            idFromName: () => "id",
            get: () => ({
              fetch: async () => new Response(),
            }),
          },
        })
      ).toBe(true);
    });

    it("returns false when durable object binding shape is invalid", () => {
      expect(
        hasCloudflareRuntimeStateBindings({
          durableObjectNamespace: {
            idFromName: () => "id",
          },
        })
      ).toBe(false);
    });

    it("returns false when only kv binding is present", () => {
      expect(
        hasCloudflareRuntimeStateBindings({
          snapshotKvNamespace: {
            get: async () => null,
          },
        })
      ).toBe(false);
    });
  });

  describe("selectRuntimeStateAdapterKind", () => {
    it("selects in-memory for test", () => {
      expect(selectRuntimeStateAdapterKind({ nodeEnv: "test" })).toBe("in-memory");
    });

    it("selects in-memory for development", () => {
      expect(selectRuntimeStateAdapterKind({ nodeEnv: "development" })).toBe("in-memory");
    });

    it("selects cloudflare in production when bindings are present", () => {
      expect(
        selectRuntimeStateAdapterKind({
          nodeEnv: "production",
          bindings: {
            durableObjectNamespace: {
              idFromName: () => "id",
              get: () => ({
                fetch: async () => new Response(),
              }),
            },
          },
        })
      ).toBe("cloudflare");
    });

    it("fails fast in production when no bindings are present", () => {
      expect(() => selectRuntimeStateAdapterKind({ nodeEnv: "production", bindings: {} })).toThrow(
        /Missing or invalid Cloudflare runtime-state binding in production/
      );
    });

    it("selects cloudflare in production when durable object binding is present in cloudflare context", () => {
      (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol] = {
        env: {
          RUNTIME_STATE_DURABLE_OBJECT: {
            idFromName: () => "id",
            get: () => ({
              fetch: async () => new Response(),
            }),
          },
        },
      };

      expect(selectRuntimeStateAdapterKind({ nodeEnv: "production" })).toBe("cloudflare");
    });

    it("keeps non-production fallback behavior for unspecified environments", () => {
      expect(selectRuntimeStateAdapterKind({ nodeEnv: "staging", bindings: {} })).toBe("in-memory");
    });
  });

  describe("getRuntimeStateAdapter", () => {
    it("returns in-memory adapter in local and test environments", () => {
      expect(getRuntimeStateAdapter({ nodeEnv: "test" }).kind).toBe("in-memory");
      expect(getRuntimeStateAdapter({ nodeEnv: "development" }).kind).toBe("in-memory");
    });

    it("returns cloudflare adapter when bindings are present in production", () => {
      const adapter = getRuntimeStateAdapter({
        nodeEnv: "production",
        bindings: {
          durableObjectNamespace: {
            idFromName: () => "id",
            get: () => ({
              fetch: async () => new Response(),
            }),
          },
        },
      });

      expect(adapter.kind).toBe("cloudflare");
    });

    it("fails fast in production when only cloudflare kv binding is present", () => {
      (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol] = {
        env: {
          RUNTIME_STATE_SNAPSHOT_KV: {
            get: async () => null,
            put: async () => undefined,
            delete: async () => undefined,
          },
        },
      };

      expect(() =>
        getRuntimeStateAdapter({
          nodeEnv: "production",
        })
      ).toThrow(/Missing or invalid Cloudflare runtime-state binding in production/);
    });

    it("returns in-memory adapter in development when only cloudflare kv binding is present", () => {
      (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol] = {
        env: {
          RUNTIME_STATE_SNAPSHOT_KV: {
            get: async () => null,
            put: async () => undefined,
            delete: async () => undefined,
          },
        },
      };

      const adapter = getRuntimeStateAdapter({
        nodeEnv: "development",
      });

      expect(adapter.kind).toBe("in-memory");
    });
  });
});
