import {
  getRuntimeStateAdapter,
  hasCloudflareRuntimeStateBindings,
  selectRuntimeStateAdapterKind,
} from "@/lib/runtime-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol];
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
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

      expect(console.info).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "cloudflare",
          reason: "valid_cloudflare_binding_detected",
          nodeEnv: "production",
          bindingSource: "explicit",
          hasDurableObjectBinding: true,
          hasValidDurableObjectBinding: true,
        })
      );
    });

    it("fails fast in production when no bindings are present", () => {
      expect(() => selectRuntimeStateAdapterKind({ nodeEnv: "production", bindings: {} })).toThrow(
        /Missing or invalid Cloudflare runtime-state binding in production/
      );

      expect(console.error).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "in-memory",
          reason: "production_missing_or_invalid_durable_object_binding",
          nodeEnv: "production",
          bindingSource: "explicit",
          hasDurableObjectBinding: false,
          hasValidDurableObjectBinding: false,
          hasSnapshotKvBinding: false,
        })
      );
    });

    it("fails fast in production when durable object binding shape is invalid", () => {
      expect(() =>
        selectRuntimeStateAdapterKind({
          nodeEnv: "production",
          bindings: {
            durableObjectNamespace: {
              idFromName: () => "id",
            },
          },
        })
      ).toThrow(/Missing or invalid Cloudflare runtime-state binding in production/);

      expect(console.error).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "in-memory",
          reason: "production_missing_or_invalid_durable_object_binding",
          hasDurableObjectBinding: true,
          hasValidDurableObjectBinding: false,
        })
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

      expect(console.warn).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "in-memory",
          reason: "non_production_fallback_missing_or_invalid_binding",
          nodeEnv: "staging",
        })
      );
    });

    it("keeps dev/test fallback behavior and emits non-noisy diagnostics only when bindings exist", () => {
      expect(selectRuntimeStateAdapterKind({ nodeEnv: "test" })).toBe("in-memory");
      expect(selectRuntimeStateAdapterKind({ nodeEnv: "development" })).toBe("in-memory");

      expect(console.info).not.toHaveBeenCalled();

      expect(
        selectRuntimeStateAdapterKind({
          nodeEnv: "development",
          bindings: {
            snapshotKvNamespace: {
              get: async () => null,
            },
          },
        })
      ).toBe("in-memory");

      expect(console.info).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "in-memory",
          reason: "node_env_prefers_in_memory",
          nodeEnv: "development",
          hasSnapshotKvBinding: true,
        })
      );
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
