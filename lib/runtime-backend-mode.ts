const runtimeBackendModeKey = Symbol.for("mc-aws.runtime-backend-mode");

type RuntimeBackendModeGlobal = typeof globalThis & {
  [runtimeBackendModeKey]?: "aws";
};

export const setRuntimeBackendMode = (value: "aws" | undefined): void => {
  const runtimeGlobal = globalThis as RuntimeBackendModeGlobal;
  if (value === undefined) delete runtimeGlobal[runtimeBackendModeKey];
  else runtimeGlobal[runtimeBackendModeKey] = value;
};

export const getRuntimeBackendMode = (): "aws" | undefined => {
  return (globalThis as RuntimeBackendModeGlobal)[runtimeBackendModeKey];
};
