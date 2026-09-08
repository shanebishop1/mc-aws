import type { HookDefinition } from "@/lib/agent/contracts";
import { agentSchemas } from "@/lib/agent/validators";

export function orderHookDefinitions(hooks: readonly HookDefinition[]): HookDefinition[] {
  hooks.forEach((hook) => agentSchemas.hookDefinition.parse(hook));
  return [...hooks].sort((left, right) => left.priority - right.priority || left.hookId.localeCompare(right.hookId));
}
