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

const productionBindingErrorMessage =
  "[RUNTIME-STATE] Missing or invalid Cloudflare runtime-state binding in production. Ensure RUNTIME_STATE_DURABLE_OBJECT is configured; production cannot fall back to in-memory runtime-state.";

const runtimeStateSelectionDiagnosticEventName = "runtime_state.adapter_selection";

type RuntimeStateBindingSource = "explicit" | "cloudflare-context" | "none";

interface RuntimeStateSelectionDiagnostic {
  event: typeof runtimeStateSelectionDiagnosticEventName;
  adapterKind: RuntimeStateAdapterKind;
  reason:
    | "node_env_prefers_in_memory"
    | "valid_cloudflare_binding_detected"
    | "production_missing_or_invalid_durable_object_binding"
    | "non_production_fallback_missing_or_invalid_binding";
  nodeEnv: string;
  bindingSource: RuntimeStateBindingSource;
  hasDurableObjectBinding: boolean;
  hasValidDurableObjectBinding: boolean;
  hasSnapshotKvBinding: boolean;
  timestamp: string;
}

const emitRuntimeStateSelectionDiagnostic = (
  diagnostic: RuntimeStateSelectionDiagnostic,
  level: "info" | "warn" | "error"
): void => {
  if (level === "error") {
    console.error("[RUNTIME-STATE]", diagnostic);
    return;
  }

  if (level === "warn") {
    console.warn("[RUNTIME-STATE]", diagnostic);
    return;
  }

  console.info("[RUNTIME-STATE]", diagnostic);
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

const hasValidDurableObjectNamespaceBinding = (binding: unknown): boolean => {
  if (!isPresentBinding(binding) || typeof binding !== "object") {
    return false;
  }

  const namespace = binding as Record<string, unknown>;
  return typeof namespace.idFromName === "function" && typeof namespace.get === "function";
};

const resolveBindingState = (bindings: RuntimeStateCloudflareBindings | null | undefined) => {
  const durableObjectBinding = bindings?.durableObjectNamespace;
  const snapshotKvBinding = bindings?.snapshotKvNamespace;

  return {
    hasDurableObjectBinding: isPresentBinding(durableObjectBinding),
    hasValidDurableObjectBinding: hasValidDurableObjectNamespaceBinding(durableObjectBinding),
    hasSnapshotKvBinding: isPresentBinding(snapshotKvBinding),
  };
};

export const hasCloudflareRuntimeStateBindings = (
  bindings: RuntimeStateCloudflareBindings | null | undefined
): boolean => {
  if (!bindings) {
    return false;
  }

  return hasValidDurableObjectNamespaceBinding(bindings.durableObjectNamespace);
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
): {
  bindings: RuntimeStateCloudflareBindings | null;
  bindingSource: RuntimeStateBindingSource;
} => {
  if (bindings) {
    return {
      bindings,
      bindingSource: "explicit",
    };
  }

  const contextBindings = getCloudflareContextBindings();

  if (contextBindings) {
    return {
      bindings: contextBindings,
      bindingSource: "cloudflare-context",
    };
  }

  return {
    bindings: null,
    bindingSource: "none",
  };
};

export const selectRuntimeStateAdapterKind = ({
  nodeEnv = process.env.NODE_ENV,
  bindings,
}: RuntimeStateSelectorInput = {}): RuntimeStateAdapterKind => {
  const { bindings: resolvedBindings, bindingSource } = resolveRuntimeStateBindings(bindings);
  const normalizedNodeEnv = normalizeNodeEnv(nodeEnv);
  const bindingState = resolveBindingState(resolvedBindings);

  const createDiagnostic = (
    adapterKind: RuntimeStateAdapterKind,
    reason: RuntimeStateSelectionDiagnostic["reason"]
  ): RuntimeStateSelectionDiagnostic => {
    return {
      event: runtimeStateSelectionDiagnosticEventName,
      adapterKind,
      reason,
      nodeEnv: normalizedNodeEnv || "unknown",
      bindingSource,
      hasDurableObjectBinding: bindingState.hasDurableObjectBinding,
      hasValidDurableObjectBinding: bindingState.hasValidDurableObjectBinding,
      hasSnapshotKvBinding: bindingState.hasSnapshotKvBinding,
      timestamp: new Date().toISOString(),
    };
  };

  if (normalizedNodeEnv === "test" || normalizedNodeEnv === "development") {
    if (bindingState.hasDurableObjectBinding || bindingState.hasSnapshotKvBinding) {
      emitRuntimeStateSelectionDiagnostic(
        createDiagnostic("in-memory", "node_env_prefers_in_memory"),
        "info"
      );
    }

    return "in-memory";
  }

  if (hasCloudflareRuntimeStateBindings(resolvedBindings)) {
    emitRuntimeStateSelectionDiagnostic(
      createDiagnostic("cloudflare", "valid_cloudflare_binding_detected"),
      "info"
    );
    return "cloudflare";
  }

  if (normalizedNodeEnv === "production") {
    emitRuntimeStateSelectionDiagnostic(
      createDiagnostic("in-memory", "production_missing_or_invalid_durable_object_binding"),
      "error"
    );
    throw new Error(productionBindingErrorMessage);
  }

  emitRuntimeStateSelectionDiagnostic(
    createDiagnostic("in-memory", "non_production_fallback_missing_or_invalid_binding"),
    "warn"
  );

  return "in-memory";
};

export const getRuntimeStateAdapter = (input: RuntimeStateSelectorInput = {}): RuntimeStateAdapter => {
  const resolvedBindingResult = resolveRuntimeStateBindings(input.bindings);
  const adapterKind = selectRuntimeStateAdapterKind({
    ...input,
    bindings: resolvedBindingResult.bindings,
  });

  if (adapterKind === "cloudflare") {
    return createCloudflareRuntimeStateAdapter(resolvedBindingResult.bindings ?? {});
  }

  return inMemoryRuntimeStateAdapter;
};
