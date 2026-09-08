import type { HookDefinition, ToolInvocation, ToolResult } from "@/lib/agent/contracts";
import { agentSchemas } from "@/lib/agent/validators";

/** These are trusted mc-aws actions, not executable values supplied by a bundle. */
export const TRUSTED_EXTENSION_HOOK_REFS = Object.freeze(["mc-aws.record-read-evidence"] as const);

export function isTrustedExtensionHookRef(handlerRef: string): boolean {
  return TRUSTED_EXTENSION_HOOK_REFS.includes(handlerRef as (typeof TRUSTED_EXTENSION_HOOK_REFS)[number]);
}

/**
 * Applies only built-in hook behavior selected by an inert handlerRef.  The
 * bundle never supplies a callback, module path, or code to this function.
 * The returned value is a non-authoritative display/event projection. Callers
 * must retain the input result for executor receipts, reconciliation, and
 * terminal publication.
 */
export function applyTrustedAfterInvocationHooks(
  hooks: readonly HookDefinition[],
  invocation: ToolInvocation,
  result: ToolResult
): ToolResult {
  let current = result;
  for (const hook of hooks) {
    if (hook.hookPoint !== "after-invocation") continue;
    if (!isTrustedExtensionHookRef(hook.handlerRef)) {
      if (hook.failureBehavior === "fail-closed") throw new Error("Unmapped extension hook was rejected.");
      continue;
    }
    if (hook.handlerRef === "mc-aws.record-read-evidence" && invocation.capability === "workspace.read") {
      if (current.status !== "succeeded" || current.evidence.length >= 32) continue;
      const evidenceId = `${hook.hookId.slice(0, 48)}:${invocation.invocationId.slice(0, 48)}`;
      current = {
        ...current,
        evidence: [
          ...current.evidence,
          {
            schemaVersion: 1 as const,
            evidenceId,
            kind: "file" as const,
            uri: `agent-evidence://${invocation.sessionId}/${encodeURIComponent(evidenceId)}`,
            description: "Trusted extension hook recorded the completed workspace read.",
          },
        ],
      };
    }
  }
  return agentSchemas.toolResult.parse(current);
}

export function orderHookDefinitions(hooks: readonly HookDefinition[]): HookDefinition[] {
  hooks.forEach((hook) => agentSchemas.hookDefinition.parse(hook));
  return [...hooks].sort((left, right) => left.priority - right.priority || left.hookId.localeCompare(right.hookId));
}
