const runtimeAuthSecretKey = Symbol.for("mc-aws.runtime-auth-secret");

type RuntimeAuthSecretGlobal = typeof globalThis & {
  [runtimeAuthSecretKey]?: string;
};

export const setRuntimeAuthSecret = (value: string | undefined): void => {
  const runtimeGlobal = globalThis as RuntimeAuthSecretGlobal;
  if (value === undefined) {
    delete runtimeGlobal[runtimeAuthSecretKey];
  } else {
    runtimeGlobal[runtimeAuthSecretKey] = value;
  }
};

export const getRuntimeAuthSecret = (): string | undefined => {
  return (globalThis as RuntimeAuthSecretGlobal)[runtimeAuthSecretKey];
};
