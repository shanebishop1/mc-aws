const CDK_TARGET_VARIABLES = ["CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"] as const;

export function loadEnvironmentPreservingCdkTarget(
  loadEnvironment: () => void,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const explicitTarget = new Map<string, string>();
  for (const name of CDK_TARGET_VARIABLES) {
    const value = environment[name];
    if (value) explicitTarget.set(name, value);
  }

  loadEnvironment();

  for (const [name, value] of explicitTarget) environment[name] = value;
}
