import type {
  RuntimeStateAdapter,
  RuntimeStateAdapterKind,
  RuntimeStateCloudflareBindings,
  RuntimeStateSelectorInput,
} from "@/lib/runtime-state/adapters";
import { createCloudflareRuntimeStateAdapter } from "@/lib/runtime-state/cloudflare-adapter";
import { inMemoryRuntimeStateAdapter } from "@/lib/runtime-state/in-memory-adapter";

const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

interface CloudflareRequestContext {
  env?: Record<string, unknown>;
}

const normalizeNodeEnv = (nodeEnv: string | undefined): string => {
  return nodeEnv?.trim().toLowerCase() ?? "";
};

const isPresentBinding = (binding: unknown): boolean => {
  if (binding === null || binding === undefined) {
    return false;
  }

  if (typeof binding === "object") {
    return Object.keys(binding as Record<string, unknown>).length > 0;
  }

  return true;
};

export const hasCloudflareRuntimeStateBindings = (
  bindings: RuntimeStateCloudflareBindings | null | undefined
): boolean => {
  if (!bindings) {
    return false;
  }

  return isPresentBinding(bindings.durableObjectNamespace) || isPresentBinding(bindings.snapshotKvNamespace);
};

const getCloudflareContextBindings = (): RuntimeStateCloudflareBindings | null => {
  try {
    const contextStore = (globalThis as unknown as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL];
    const context = contextStore as CloudflareRequestContext | undefined;
    if (!context?.env) {
      return null;
    }

    const bindings: RuntimeStateCloudflareBindings = {
      durableObjectNamespace: context.env.RUNTIME_STATE_DURABLE_OBJECT,
      snapshotKvNamespace: context.env.RUNTIME_STATE_SNAPSHOT_KV,
    };

    return hasCloudflareRuntimeStateBindings(bindings) ? bindings : null;
  } catch {
    return null;
  }
};

const resolveRuntimeStateBindings = (
  bindings: RuntimeStateCloudflareBindings | null | undefined
): RuntimeStateCloudflareBindings | null => {
  if (bindings) {
    return bindings;
  }

  return getCloudflareContextBindings();
};

export const selectRuntimeStateAdapterKind = ({
  nodeEnv = process.env.NODE_ENV,
  bindings,
}: RuntimeStateSelectorInput = {}): RuntimeStateAdapterKind => {
  const resolvedBindings = resolveRuntimeStateBindings(bindings);
  const normalizedNodeEnv = normalizeNodeEnv(nodeEnv);

  if (normalizedNodeEnv === "test" || normalizedNodeEnv === "development") {
    return "in-memory";
  }

  if (hasCloudflareRuntimeStateBindings(resolvedBindings)) {
    return "cloudflare";
  }

  return "in-memory";
};

export const getRuntimeStateAdapter = (input: RuntimeStateSelectorInput = {}): RuntimeStateAdapter => {
  const resolvedBindings = resolveRuntimeStateBindings(input.bindings);
  const adapterKind = selectRuntimeStateAdapterKind(input);

  if (adapterKind === "cloudflare") {
    return createCloudflareRuntimeStateAdapter(resolvedBindings ?? {});
  }

  return inMemoryRuntimeStateAdapter;
};
