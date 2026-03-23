import type {
  RuntimeStateAdapter,
  RuntimeStateAdapterKind,
  RuntimeStateCloudflareBindings,
  RuntimeStateSelectorInput,
} from "@/lib/runtime-state/adapters";
import { createCloudflareRuntimeStateAdapter } from "@/lib/runtime-state/cloudflare-adapter";
import { inMemoryRuntimeStateAdapter } from "@/lib/runtime-state/in-memory-adapter";

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

export const selectRuntimeStateAdapterKind = ({
  nodeEnv = process.env.NODE_ENV,
  bindings,
}: RuntimeStateSelectorInput = {}): RuntimeStateAdapterKind => {
  const normalizedNodeEnv = normalizeNodeEnv(nodeEnv);

  if (normalizedNodeEnv === "test" || normalizedNodeEnv === "development") {
    return "in-memory";
  }

  if (hasCloudflareRuntimeStateBindings(bindings)) {
    return "cloudflare";
  }

  return "in-memory";
};

export const getRuntimeStateAdapter = (input: RuntimeStateSelectorInput = {}): RuntimeStateAdapter => {
  const adapterKind = selectRuntimeStateAdapterKind(input);

  if (adapterKind === "cloudflare") {
    return createCloudflareRuntimeStateAdapter(input.bindings ?? {});
  }

  return inMemoryRuntimeStateAdapter;
};
