import {
  RuntimeStateConfigurationError,
  getRuntimeStateAdapter,
  getRuntimeStateAdapterAsync,
  hasCloudflareRuntimeStateBindings,
  selectRuntimeStateAdapterKind,
} from "@/lib/runtime-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

class PrototypeBackedDurableObjectNamespace {
  idFromName(name: string): string {
    return name;
  }

  get(): { fetch: () => Promise<Response> } {
    return {
      fetch: async () => new Response(),
    };
  }
}

class PrototypeBackedKvNamespace {
  async get(): Promise<null> {
    return null;
  }

  async put(): Promise<void> {}

  async delete(): Promise<void> {}
}

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

    it("returns true for a prototype-backed durable object namespace with no enumerable own keys", () => {
      const durableObjectNamespace = new PrototypeBackedDurableObjectNamespace();

      expect(Object.keys(durableObjectNamespace)).toEqual([]);
      expect(hasCloudflareRuntimeStateBindings({ durableObjectNamespace })).toBe(true);
    });

    it("returns false when durable object binding shape is invalid", () => {
      expect(
        hasCloudflareRuntimeStateBindings({
          durableObjectNamespace: {},
        })
      ).toBe(false);

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

    it("selects cloudflare for a prototype-backed durable object namespace", () => {
      const durableObjectNamespace = new PrototypeBackedDurableObjectNamespace();

      expect(Object.keys(durableObjectNamespace)).toEqual([]);
      expect(
        selectRuntimeStateAdapterKind({
          nodeEnv: "production",
          bindings: { durableObjectNamespace },
        })
      ).toBe("cloudflare");

      expect(console.info).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          adapterKind: "cloudflare",
          hasDurableObjectBinding: true,
          hasValidDurableObjectBinding: true,
        })
      );
    });

    it("fails closed in production when no bindings are present", () => {
      let thrownError: unknown;
      try {
        selectRuntimeStateAdapterKind({ nodeEnv: "production", bindings: {} });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(RuntimeStateConfigurationError);
      expect(thrownError).toMatchObject({
        name: "RuntimeStateConfigurationError",
        code: "RUNTIME_STATE_CONFIGURATION_ERROR",
      });
      expect((thrownError as Error).message).toContain("RUNTIME_STATE_DURABLE_OBJECT");
      expect((thrownError as Error).message).toContain("cannot fall back to in-memory");

      expect(console.error).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "unavailable",
          reason: "production_missing_or_invalid_durable_object_binding",
          nodeEnv: "production",
          bindingSource: "explicit",
          hasDurableObjectBinding: false,
          hasValidDurableObjectBinding: false,
          hasSnapshotKvBinding: false,
        })
      );
    });

    it("fails closed in production when durable object binding shape is invalid", () => {
      expect(() =>
        selectRuntimeStateAdapterKind({
          nodeEnv: "production",
          bindings: {
            durableObjectNamespace: {
              idFromName: () => "id",
            },
          },
        })
      ).toThrow(RuntimeStateConfigurationError);

      expect(console.error).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          event: "runtime_state.adapter_selection",
          adapterKind: "unavailable",
          reason: "production_missing_or_invalid_durable_object_binding",
          hasDurableObjectBinding: true,
          hasValidDurableObjectBinding: false,
        })
      );
    });

    it("treats an empty durable object namespace as present but invalid", () => {
      expect(() =>
        selectRuntimeStateAdapterKind({
          nodeEnv: "production",
          bindings: {
            durableObjectNamespace: {},
          },
        })
      ).toThrow(RuntimeStateConfigurationError);

      expect(console.error).toHaveBeenCalledWith(
        "[RUNTIME-STATE]",
        expect.objectContaining({
          hasDurableObjectBinding: true,
          hasValidDurableObjectBinding: false,
        })
      );
    });

    it("selects cloudflare in production when durable object binding is present in cloudflare context", () => {
      const durableObjectNamespace = new PrototypeBackedDurableObjectNamespace();

      expect(Object.keys(durableObjectNamespace)).toEqual([]);
      (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol] = {
        env: {
          RUNTIME_STATE_DURABLE_OBJECT: durableObjectNamespace,
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

      const snapshotKvNamespace = new PrototypeBackedKvNamespace();
      expect(Object.keys(snapshotKvNamespace)).toEqual([]);

      expect(
        selectRuntimeStateAdapterKind({
          nodeEnv: "development",
          bindings: {
            snapshotKvNamespace,
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

    it("returns cloudflare adapter through the asynchronous context path for a prototype-backed namespace", async () => {
      const durableObjectNamespace = new PrototypeBackedDurableObjectNamespace();
      (globalThis as unknown as Record<symbol, unknown>)[cloudflareContextSymbol] = {
        env: {
          RUNTIME_STATE_DURABLE_OBJECT: durableObjectNamespace,
        },
      };

      const adapter = await getRuntimeStateAdapterAsync({ nodeEnv: "production" });

      expect(Object.keys(durableObjectNamespace)).toEqual([]);
      expect(adapter.kind).toBe("cloudflare");
    });

    it("never returns the in-memory adapter when production bindings are missing", () => {
      expect(() => getRuntimeStateAdapter({ nodeEnv: "production", bindings: {} })).toThrow(
        RuntimeStateConfigurationError
      );
    });

    it("fails closed through the asynchronous selector in production", async () => {
      await expect(getRuntimeStateAdapterAsync({ nodeEnv: "production", bindings: {} })).rejects.toBeInstanceOf(
        RuntimeStateConfigurationError
      );
    });

    it("fails closed in production when only cloudflare kv binding is present", () => {
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
      ).toThrow(RuntimeStateConfigurationError);
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
