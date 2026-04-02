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
          },
        })
      ).toBe(true);
    });

    it("returns true when kv binding is present", () => {
      expect(
        hasCloudflareRuntimeStateBindings({
          snapshotKvNamespace: {
            get: async () => null,
          },
        })
      ).toBe(true);
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
            },
          },
        })
      ).toBe("cloudflare");
    });

    it("falls back to in-memory in production when no bindings are present", () => {
      expect(selectRuntimeStateAdapterKind({ nodeEnv: "production", bindings: {} })).toBe("in-memory");
    });

    it("selects cloudflare in production when bindings are present in cloudflare context", () => {
      (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol] = {
        env: {
          RUNTIME_STATE_DURABLE_OBJECT: {
            idFromName: () => "id",
          },
        },
      };

      expect(selectRuntimeStateAdapterKind({ nodeEnv: "production" })).toBe("cloudflare");
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
          },
        },
      });

      expect(adapter.kind).toBe("cloudflare");
    });

    it("returns cloudflare adapter when only cloudflare context bindings are present", () => {
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
        nodeEnv: "production",
      });

      expect(adapter.kind).toBe("cloudflare");
    });
  });
});
