/**
 * Canonical schema for environment/runtime configuration ownership.
 *
 * This is intentionally policy-light for Story 5.1: it defines typed shape,
 * targets, and requirement levels so later stories can enforce stricter rules.
 */

export const runtimeTargets = ["worker", "lambda", "ec2", "local-dev", "ci"] as const;

export type RuntimeTarget = (typeof runtimeTargets)[number];

export const requirementLevels = ["required", "optional", "deprecated", "forbidden"] as const;

export type RequirementLevel = (typeof requirementLevels)[number];

export type EnvValueType = "string" | "url" | "email" | "enum";

const cloudflareKvNamespaceIdPattern = /^[a-f0-9]{32}$/i;

export interface TargetOwnership {
  level: RequirementLevel;
  note?: string;
}

export type OwnershipByTarget = Record<RuntimeTarget, TargetOwnership>;

export interface EnvSchemaEntry {
  description: string;
  valueType: EnvValueType;
  enumValues?: readonly string[];
  aliases?: readonly string[];
  defaultValue?: string;
  placeholderValues?: readonly string[];
  ownership: OwnershipByTarget;
}

const withOwnership = (levels: Partial<Record<RuntimeTarget, TargetOwnership>>): OwnershipByTarget => {
  return {
    worker: levels.worker ?? { level: "optional" },
    lambda: levels.lambda ?? { level: "optional" },
    ec2: levels.ec2 ?? { level: "optional" },
    "local-dev": levels["local-dev"] ?? { level: "optional" },
    ci: levels.ci ?? { level: "optional" },
  };
};

export const backendModeValues = ["aws", "mock"] as const;

export type BackendMode = (typeof backendModeValues)[number];

export const envRuntimeSchema = {
  MC_BACKEND_MODE: {
    description: "Backend provider mode for API/runtime operations",
    valueType: "enum",
    enumValues: backendModeValues,
    defaultValue: "aws",
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  AWS_REGION: {
    description: "Primary AWS region used by app clients",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "required" },
      ec2: { level: "required" },
      ci: { level: "optional" },
    }),
  },
  AWS_ACCOUNT_ID: {
    description: "AWS account identifier",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "optional", note: "Can be inferred from CDK defaults in some flows." },
      lambda: { level: "required" },
      ec2: { level: "required" },
      ci: { level: "optional" },
    }),
  },
  INSTANCE_ID: {
    description: "Minecraft EC2 instance identifier",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "required" },
      ec2: { level: "forbidden" },
      ci: { level: "optional" },
    }),
  },
  AWS_ACCESS_KEY_ID: {
    description: "AWS access key id",
    valueType: "string",
    placeholderValues: ["AKIAIOSFODNN7EXAMPLE"],
    ownership: withOwnership({
      worker: { level: "optional", note: "Prefer platform IAM/role where available." },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      ci: { level: "optional" },
    }),
  },
  AWS_SECRET_ACCESS_KEY: {
    description: "AWS secret access key",
    valueType: "string",
    placeholderValues: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ownership: withOwnership({
      worker: { level: "optional", note: "Prefer platform IAM/role where available." },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      ci: { level: "optional" },
    }),
  },
  AWS_SESSION_TOKEN: {
    description: "Optional AWS session token for temporary credentials",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      ci: { level: "optional" },
    }),
  },
  CLOUDFORMATION_STACK_NAME: {
    description: "CloudFormation stack name for lookup operations",
    valueType: "string",
    aliases: ["STACK_NAME"],
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "optional" },
      ec2: { level: "forbidden" },
      ci: { level: "optional" },
    }),
  },
  CLOUDFLARE_ZONE_ID: {
    description: "Cloudflare zone identifier",
    valueType: "string",
    placeholderValues: ["your-zone-id"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "optional" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  CLOUDFLARE_RECORD_ID: {
    description: "Cloudflare DNS record identifier",
    valueType: "string",
    placeholderValues: ["your-record-id"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "optional" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  CLOUDFLARE_MC_DOMAIN: {
    description: "Public Minecraft DNS name managed in Cloudflare",
    valueType: "string",
    placeholderValues: ["mc.yourdomain.com"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "optional" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  CLOUDFLARE_DNS_API_TOKEN: {
    description: "DNS-scoped Cloudflare API token for runtime DNS updates",
    valueType: "string",
    placeholderValues: ["your-cloudflare-api-token"],
    aliases: ["CLOUDFLARE_API_TOKEN"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "optional" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  RUNTIME_STATE_SNAPSHOT_KV_ID: {
    description: "Cloudflare KV namespace id for runtime-state snapshots",
    valueType: "string",
    placeholderValues: ["your-runtime-state-kv-id", "REPLACE_WITH_RUNTIME_STATE_SNAPSHOT_KV_ID"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID: {
    description: "Cloudflare preview KV namespace id for runtime-state snapshots",
    valueType: "string",
    placeholderValues: ["your-runtime-state-kv-preview-id", "REPLACE_WITH_RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID"],
    ownership: withOwnership({
      worker: { level: "optional", note: "Falls back to RUNTIME_STATE_SNAPSHOT_KV_ID in deploy flow." },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  GDRIVE_REMOTE: {
    description: "Google Drive remote name for backup sync",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "optional" },
      ec2: { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  GDRIVE_ROOT: {
    description: "Google Drive root path for backup sync",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "optional" },
      ec2: { level: "optional" },
      ci: { level: "optional" },
    }),
  },
  AUTH_SECRET: {
    description: "JWT/session signing secret",
    valueType: "string",
    placeholderValues: ["your-secret-here", "dev-secret-change-in-production"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "required" },
    }),
  },
  ADMIN_EMAIL: {
    description: "Primary administrator email",
    valueType: "email",
    placeholderValues: ["your-email@gmail.com"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "required" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "required" },
    }),
  },
  ALLOWED_EMAILS: {
    description: "Comma-separated allowlist for panel access",
    valueType: "string",
    ownership: withOwnership({
      worker: { level: "optional" },
      lambda: { level: "optional" },
      ec2: { level: "forbidden" },
      ci: { level: "optional" },
    }),
  },
  GOOGLE_CLIENT_ID: {
    description: "Google OAuth client id",
    valueType: "string",
    placeholderValues: ["123456789-abcdefg.apps.googleusercontent.com"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "required" },
    }),
  },
  GOOGLE_CLIENT_SECRET: {
    description: "Google OAuth client secret",
    valueType: "string",
    placeholderValues: ["GOCSPX-abc123xyz789"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "required" },
    }),
  },
  NEXT_PUBLIC_APP_URL: {
    description: "Canonical public panel URL",
    valueType: "url",
    defaultValue: "http://localhost:3000",
    placeholderValues: ["http://localhost:3000", "https://panel.yourdomain.com", "https://mc.yourdomain.com"],
    ownership: withOwnership({
      worker: { level: "required" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "required" },
    }),
  },
  ENABLE_DEV_LOGIN: {
    description: "Local development bypass for authentication",
    valueType: "enum",
    enumValues: ["true", "false"],
    ownership: withOwnership({
      worker: { level: "forbidden" },
      lambda: { level: "forbidden" },
      ec2: { level: "forbidden" },
      "local-dev": { level: "optional" },
      ci: { level: "forbidden" },
    }),
  },
} as const satisfies Record<string, EnvSchemaEntry>;

export type EnvVarName = keyof typeof envRuntimeSchema;

export const workerSecretAllowlist = [
  "AWS_REGION",
  "AWS_ACCOUNT_ID",
  "INSTANCE_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFORMATION_STACK_NAME",
  "STACK_NAME",
  "CLOUDFLARE_DNS_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_RECORD_ID",
  "CLOUDFLARE_MC_DOMAIN",
  "GDRIVE_REMOTE",
  "GDRIVE_ROOT",
  "AUTH_SECRET",
  "ADMIN_EMAIL",
  "ALLOWED_EMAILS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NEXT_PUBLIC_APP_URL",
] as const;

export type WorkerSecretAllowlistKey = (typeof workerSecretAllowlist)[number];

export interface ResolvedEnvValue {
  name: EnvVarName;
  value: string;
  sourceName: string;
  usedAlias: boolean;
}

export const parseBackendMode = (value: string): BackendMode => {
  const normalizedValue = value.toLowerCase().trim();
  if (normalizedValue !== "aws" && normalizedValue !== "mock") {
    throw new Error(`Invalid MC_BACKEND_MODE value: "${value}". Must be "aws" or "mock".`);
  }
  return normalizedValue;
};

export const getSchemaEntry = (name: EnvVarName): EnvSchemaEntry => {
  return envRuntimeSchema[name];
};

const isPresent = (value: string | undefined): value is string => {
  return typeof value === "string" && value.trim().length > 0;
};

export const resolveEnvValue = (
  values: Record<string, string | undefined>,
  name: EnvVarName
): ResolvedEnvValue | null => {
  const primaryValue = values[name];
  if (isPresent(primaryValue)) {
    return {
      name,
      value: primaryValue,
      sourceName: name,
      usedAlias: false,
    };
  }

  const aliases = getSchemaEntry(name).aliases ?? [];
  for (const alias of aliases) {
    const aliasValue = values[alias];
    if (isPresent(aliasValue)) {
      return {
        name,
        value: aliasValue,
        sourceName: alias,
        usedAlias: true,
      };
    }
  }

  return null;
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EnvSchemaValidationIssue {
  name: EnvVarName;
  kind: "missing" | "invalid" | "forbidden" | "deprecated";
  message: string;
}

export interface EnvSchemaValidationReport {
  target: RuntimeTarget;
  issues: EnvSchemaValidationIssue[];
}

const createIssue = (
  name: EnvVarName,
  kind: EnvSchemaValidationIssue["kind"],
  message: string
): EnvSchemaValidationIssue => {
  return {
    name,
    kind,
    message,
  };
};

const validateRuleAndPresence = ({
  name,
  target,
  rule,
  resolved,
  issues,
}: {
  name: EnvVarName;
  target: RuntimeTarget;
  rule: TargetOwnership;
  resolved: ResolvedEnvValue | null;
  issues: EnvSchemaValidationIssue[];
}): boolean => {
  if (rule.level === "required" && !resolved) {
    issues.push(createIssue(name, "missing", `${name} is required for ${target}.`));
    return true;
  }

  if (rule.level === "forbidden" && resolved) {
    issues.push(createIssue(name, "forbidden", `${name} is forbidden for ${target}.`));
    return true;
  }

  if (rule.level === "deprecated" && resolved) {
    issues.push(createIssue(name, "deprecated", `${name} is deprecated for ${target}.`));
  }

  return false;
};

const isValidValueType = (entry: EnvSchemaEntry, value: string): boolean => {
  if (entry.valueType === "string") {
    return true;
  }

  if (entry.valueType === "email") {
    return emailRegex.test(value);
  }

  if (entry.valueType === "url") {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  if (entry.valueType === "enum") {
    if (!entry.enumValues || entry.enumValues.length === 0) {
      return false;
    }
    return entry.enumValues.includes(value.trim().toLowerCase());
  }

  return false;
};

const isPlaceholderValue = (entry: EnvSchemaEntry, value: string): boolean => {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  const placeholders = entry.placeholderValues ?? [];
  return placeholders.some((placeholder) => placeholder === normalized);
};

export const validateEnvForTarget = (
  values: Record<string, string | undefined>,
  target: RuntimeTarget
): EnvSchemaValidationReport => {
  const issues: EnvSchemaValidationIssue[] = [];

  for (const name of Object.keys(envRuntimeSchema) as EnvVarName[]) {
    const entry = envRuntimeSchema[name];
    const rule = entry.ownership[target];
    const resolved = resolveEnvValue(values, name);

    if (
      validateRuleAndPresence({
        name,
        target,
        rule,
        resolved,
        issues,
      })
    ) {
      continue;
    }

    if (!resolved) {
      continue;
    }

    if (resolved.usedAlias) {
      issues.push(createIssue(name, "deprecated", `${resolved.sourceName} is deprecated. Use ${name}.`));
    }

    if (!isValidValueType(entry, resolved.value)) {
      issues.push(createIssue(name, "invalid", `${name} value is invalid for type ${entry.valueType}.`));
      continue;
    }

    if (isPlaceholderValue(entry, resolved.value)) {
      issues.push(
        createIssue(
          name,
          "invalid",
          `${name} is using a placeholder value. Replace it with your real deployment value.`
        )
      );
    }
  }

  return {
    target,
    issues,
  };
};

export const getEnvVarNamesByRequirement = (target: RuntimeTarget, level: RequirementLevel): EnvVarName[] => {
  return (Object.keys(envRuntimeSchema) as EnvVarName[]).filter((name) => {
    return envRuntimeSchema[name].ownership[target].level === level;
  });
};

export const runtimeStateWranglerSchema = {
  durableObjectBindingName: "RUNTIME_STATE_DURABLE_OBJECT",
  durableObjectClassName: "RuntimeStateDurableObject",
  snapshotKvBindingName: "RUNTIME_STATE_SNAPSHOT_KV",
  placeholderKvIdPattern: /^REPLACE_WITH_RUNTIME_STATE_SNAPSHOT_KV(_PREVIEW)?_ID$/,
  migrationTagPattern: /^v\d+-runtime-state-durable-object$/,
} as const;

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as UnknownRecord;
};

export interface RuntimeStateWranglerValidationReport {
  errors: string[];
  isValid: boolean;
}

export const validateRuntimeStateWranglerConfig = (config: unknown): RuntimeStateWranglerValidationReport => {
  const errors: string[] = [];
  const root = asRecord(config);

  if (!root) {
    return {
      errors: ["Wrangler config must be an object."],
      isValid: false,
    };
  }

  const durableObjects = asRecord(root.durable_objects);
  const durableBindings = Array.isArray(durableObjects?.bindings) ? durableObjects?.bindings : [];
  const hasExpectedDurableBinding = durableBindings.some((binding) => {
    const record = asRecord(binding);
    return (
      record?.name === runtimeStateWranglerSchema.durableObjectBindingName &&
      record?.class_name === runtimeStateWranglerSchema.durableObjectClassName
    );
  });

  if (!hasExpectedDurableBinding) {
    errors.push(
      `durable_objects.bindings must include ${runtimeStateWranglerSchema.durableObjectBindingName} -> ${runtimeStateWranglerSchema.durableObjectClassName}.`
    );
  }

  const kvNamespaces = Array.isArray(root.kv_namespaces) ? root.kv_namespaces : [];
  const hasExpectedKvBinding = kvNamespaces.some((binding) => {
    const record = asRecord(binding);
    return record?.binding === runtimeStateWranglerSchema.snapshotKvBindingName;
  });

  if (!hasExpectedKvBinding) {
    errors.push(`kv_namespaces must include binding ${runtimeStateWranglerSchema.snapshotKvBindingName}.`);
  }

  for (const binding of kvNamespaces) {
    const record = asRecord(binding);
    if (record?.binding !== runtimeStateWranglerSchema.snapshotKvBindingName) {
      continue;
    }

    const kvId = typeof record.id === "string" ? record.id.trim() : "";
    const previewId = typeof record.preview_id === "string" ? record.preview_id.trim() : "";

    if (!kvId) {
      errors.push(`${runtimeStateWranglerSchema.snapshotKvBindingName} id is required.`);
    } else if (runtimeStateWranglerSchema.placeholderKvIdPattern.test(kvId)) {
      errors.push(`${runtimeStateWranglerSchema.snapshotKvBindingName} id cannot use placeholder values.`);
    } else if (!cloudflareKvNamespaceIdPattern.test(kvId)) {
      errors.push(`${runtimeStateWranglerSchema.snapshotKvBindingName} id must be a Cloudflare KV namespace id.`);
    }

    if (!previewId) {
      errors.push(`${runtimeStateWranglerSchema.snapshotKvBindingName} preview_id is required.`);
    } else if (runtimeStateWranglerSchema.placeholderKvIdPattern.test(previewId)) {
      errors.push(`${runtimeStateWranglerSchema.snapshotKvBindingName} preview_id cannot use placeholder values.`);
    } else if (!cloudflareKvNamespaceIdPattern.test(previewId)) {
      errors.push(
        `${runtimeStateWranglerSchema.snapshotKvBindingName} preview_id must be a Cloudflare KV namespace id.`
      );
    }
  }

  const migrations = Array.isArray(root.migrations) ? root.migrations : [];
  const hasExpectedMigration = migrations.some((migration) => {
    const record = asRecord(migration);
    const tag = typeof record?.tag === "string" ? record.tag : "";
    const classes = Array.isArray(record?.new_sqlite_classes) ? record.new_sqlite_classes : [];
    return (
      runtimeStateWranglerSchema.migrationTagPattern.test(tag) &&
      classes.includes(runtimeStateWranglerSchema.durableObjectClassName)
    );
  });

  if (!hasExpectedMigration) {
    errors.push(
      `migrations must include ${runtimeStateWranglerSchema.durableObjectClassName} with tag matching ${String(runtimeStateWranglerSchema.migrationTagPattern)}.`
    );
  }

  return {
    errors,
    isValid: errors.length === 0,
  };
};
