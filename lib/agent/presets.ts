import {
  AGENT_CAPABILITIES,
  AGENT_SCHEMA_VERSION,
  type AgentCapability,
  type BackupMode,
  type CapabilityRule,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionPreset,
} from "@/lib/agent/contracts";

type RuleMap = Readonly<Record<AgentCapability, PermissionDecision>>;

const COPILOT_RULES: RuleMap = {
  "workspace.read": "allow",
  "workspace.write": "ask-always",
  "workspace.delete": "deny",
  "shell.execute": "ask-always",
  "console.execute": "ask-always",
  "network.outbound": "deny",
  "backup.create": "allow",
  "extension.load": "deny",
  "maintenance.apply": "ask-always",
};

const MAINTAINER_RULES: RuleMap = {
  "workspace.read": "allow",
  "workspace.write": "ask-once",
  "workspace.delete": "ask-always",
  "shell.execute": "ask-once",
  "console.execute": "ask-once",
  "network.outbound": "ask-always",
  "backup.create": "allow",
  "extension.load": "ask-always",
  "maintenance.apply": "ask-always",
};

const AUTOPILOT_RULES: RuleMap = {
  "workspace.read": "allow",
  "workspace.write": "allow",
  "workspace.delete": "ask-once",
  "shell.execute": "allow",
  "console.execute": "allow",
  "network.outbound": "ask-once",
  "backup.create": "allow",
  "extension.load": "ask-once",
  "maintenance.apply": "ask-always",
};

function expandRules(ruleMap: RuleMap): CapabilityRule[] {
  return AGENT_CAPABILITIES.map((capability) => ({
    schemaVersion: AGENT_SCHEMA_VERSION,
    capability,
    decision: ruleMap[capability],
  }));
}

function preset(
  name: "copilot" | "maintainer" | "autopilot",
  displayName: string,
  rules: RuleMap,
  backupMode: BackupMode,
  isDefault = false
): PermissionPreset {
  return Object.freeze({
    schemaVersion: AGENT_SCHEMA_VERSION,
    name,
    displayName,
    isDefault,
    rules: Object.freeze(expandRules(rules)) as unknown as CapabilityRule[],
    backupMode,
  });
}

export const PERMISSION_PRESETS = Object.freeze({
  copilot: preset("copilot", "Copilot", COPILOT_RULES, "before-any-mutation"),
  maintainer: preset("maintainer", "Maintainer", MAINTAINER_RULES, "before-risky", true),
  autopilot: preset("autopilot", "Autopilot", AUTOPILOT_RULES, "before-destructive"),
});

export const PERMISSION_PRESET_NAMES = ["copilot", "maintainer", "autopilot", "custom"] as const;

export function createPolicyFromPreset(
  name: keyof typeof PERMISSION_PRESETS,
  policyId: string,
  revision = 1
): PermissionPolicy {
  const selected = PERMISSION_PRESETS[name];
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    policyId,
    revision,
    preset: name,
    rules: selected.rules.map((rule) => ({ ...rule })),
    backupMode: selected.backupMode,
  };
}

export function createCustomPolicy(
  source: PermissionPolicy,
  policyId: string,
  revision: number,
  overrides: Partial<Record<AgentCapability, PermissionDecision>> = {},
  backupMode = source.backupMode
): PermissionPolicy {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    policyId,
    revision,
    preset: "custom",
    rules: source.rules.map((rule) => ({ ...rule, decision: overrides[rule.capability] ?? rule.decision })),
    backupMode,
  };
}

export function createCustomPreset(source: PermissionPreset): PermissionPreset {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    name: "custom",
    displayName: "Custom",
    isDefault: false,
    rules: source.rules.map((rule) => ({ ...rule })),
    backupMode: source.backupMode,
  };
}
