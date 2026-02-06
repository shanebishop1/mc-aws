/**
 * AWS client configuration helpers for multiple runtimes.
 *
 * Cloudflare Workers has no filesystem, so the AWS SDK default credential chain
 * (which can try to read ~/.aws/config and ~/.aws/credentials) will fail.
 *
 * In Workers, require explicit environment variable credentials.
 */

import * as fs from "node:fs";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { env } from "../env";

export type AwsCredentialIdentity = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

type AwsProvider<T> = () => Promise<T>;

// Mirror AWS SDK v3 string literal unions (avoid importing node-only types).
type AwsDefaultsMode = "auto" | "in-region" | "cross-region" | "mobile" | "standard" | "legacy";
type AwsRetryMode = "standard" | "adaptive";

export type AwsClientConfig = {
  region: string;
  credentials?: AwsCredentialIdentity;

  requestHandler?: FetchHttpHandler;

  // Prevent AWS SDK "node" runtime from consulting shared config files.
  defaultsMode?: AwsDefaultsMode | AwsProvider<AwsDefaultsMode>;
  retryMode?: AwsRetryMode | AwsProvider<AwsRetryMode>;
  maxAttempts?: number;
  userAgentAppId?: string;
  useDualstackEndpoint?: boolean | AwsProvider<boolean>;
  useFipsEndpoint?: boolean | AwsProvider<boolean>;

  // AWS SDK v3 (Smithy) http auth scheme selection.
  // If this falls back to shared config files, Workers will crash (no fs).
  authSchemePreference?: AwsProvider<string[]>;
};

type CloudflareRequestContext = {
  env?: Record<string, unknown>;
};

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike | null {
  const maybe = globalThis as unknown as { process?: { env?: ProcessEnvLike } };
  return maybe.process?.env ?? null;
}

let fsPatchedForWorkers = false;

function patchFsForWorkers(): void {
  if (fsPatchedForWorkers) {
    return;
  }

  fsPatchedForWorkers = true;

  const toPathString = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof URL) {
      return value.toString();
    }
    return String(value);
  };

  const enoent = (path: unknown): Error => {
    const p = toPathString(path);
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    (err as unknown as { code?: string }).code = "ENOENT";
    (err as unknown as { errno?: number }).errno = -2;
    (err as unknown as { syscall?: string }).syscall = "open";
    (err as unknown as { path?: string }).path = p;
    return err;
  };

  const set = (obj: unknown, key: string, value: unknown): void => {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) {
      return;
    }

    try {
      (obj as unknown as Record<string, unknown>)[key] = value;
      return;
    } catch {
      // ignore
    }

    try {
      Object.defineProperty(obj, key, {
        value,
        configurable: true,
        writable: true,
      });
    } catch {
      // ignore
    }
  };

  const schedule = (fn: () => void): void => {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(fn);
      return;
    }
    Promise.resolve()
      .then(fn)
      .catch(() => {
        // ignore
      });
  };

  // Some AWS SDK "node" config providers attempt to read shared config files.
  // In Workers, make these reads behave like "file not found" rather than crashing.
  set(fs, "readFile", (path: unknown, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") {
      schedule(() => (cb as (err: Error) => void)(enoent(path)));
      return;
    }
    return Promise.reject(enoent(path));
  });

  set(fs, "readFileSync", (path: unknown) => {
    throw enoent(path);
  });

  const promisesObj = (fs as unknown as { promises?: unknown }).promises;
  if (promisesObj && typeof promisesObj === "object") {
    set(promisesObj, "readFile", async (path: unknown) => {
      throw enoent(path);
    });
  }
}

function isCloudflareWorkersRuntime(): boolean {
  const maybeNavigator = globalThis as unknown as { navigator?: { userAgent?: unknown } };
  const userAgent = maybeNavigator.navigator?.userAgent;
  if (typeof userAgent === "string" && userAgent.toLowerCase().includes("cloudflare")) {
    return true;
  }

  // Workerd (Cloudflare Workers) provides Service Worker globals like caches.
  // We prefer this signal over Node shims (nodejs_compat) which may polyfill process.
  if (typeof (globalThis as unknown as { caches?: unknown }).caches !== "undefined") {
    return true;
  }

  // Fallback: WebSocketPair is Cloudflare-specific in practice.
  return typeof (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";
}

function getEnvAwsCredentials(): AwsCredentialIdentity | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
  };
}

function getCloudflareContextEnvString(key: string): string | null {
  try {
    const store = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")];
    const ctx = store as CloudflareRequestContext | undefined;
    const value = ctx?.env?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function getCloudflareContextAwsCredentials(): AwsCredentialIdentity | null {
  const accessKeyId = getCloudflareContextEnvString("AWS_ACCESS_KEY_ID");
  const secretAccessKey = getCloudflareContextEnvString("AWS_SECRET_ACCESS_KEY");
  const sessionToken = getCloudflareContextEnvString("AWS_SESSION_TOKEN");

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
  };
}

export function getAwsClientConfig(region: string): AwsClientConfig {
  const isWorkers = isCloudflareWorkersRuntime();

  // Cloudflare Workers cannot read ~/.aws/config or ~/.aws/credentials.
  // Some AWS SDK "node" defaults try to read config files when certain env vars aren't set.
  // Ensure those defaults stay on env-only paths in Workers.
  if (isWorkers) {
    patchFsForWorkers();

    const procEnv = getProcessEnv();
    if (procEnv) {
      // If AWS_PROFILE is set, the AWS SDK may prefer profile/ini providers even when static env creds exist.
      // That triggers filesystem reads and crashes in Workers.
      for (const key of [
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_SDK_LOAD_CONFIG",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
      ]) {
        delete procEnv[key];
      }

      // Avoid SDK config-file fallbacks for common defaults.
      procEnv.AWS_DEFAULTS_MODE ??= "standard";
      procEnv.AWS_RETRY_MODE ??= "standard";
      procEnv.AWS_MAX_ATTEMPTS ??= "3";
      procEnv.AWS_SDK_UA_APP_ID ??= "mc-aws-panel";

      // Prevent any IMDS-related config lookups from falling back to shared config files.
      // (Workers cannot use IMDS anyway.)
      procEnv.AWS_EC2_METADATA_DISABLED ??= "true";
      procEnv.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE ??= "IPv4";
      procEnv.AWS_EC2_METADATA_SERVICE_ENDPOINT ??= "http://169.254.169.254";
    }
  }

  const credentials = getEnvAwsCredentials() ?? getCloudflareContextAwsCredentials();
  if (credentials) {
    const defaultsMode = "standard";
    const retryMode = "standard";
    const maxAttempts = 3;
    const userAgentAppId = "mc-aws-panel";
    const useDualstackEndpoint = false;
    const useFipsEndpoint = false;

    // Force SigV4 in Workers; otherwise the SDK can consult shared config files.
    const authSchemePreference = async () => ["sigv4"];

    // Cloudflare Workers can't use node:http/node:https sockets. Use fetch instead.
    const requestHandler = isWorkers ? new FetchHttpHandler() : undefined;

    return {
      region,
      credentials,

      requestHandler,
      defaultsMode,
      retryMode,
      maxAttempts,
      userAgentAppId,
      useDualstackEndpoint,
      useFipsEndpoint,
      authSchemePreference,
    };
  }

  if (isWorkers) {
    throw new Error(
      "AWS credentials are missing in Cloudflare Workers runtime. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN) as Wrangler secrets/vars. Workers cannot read ~/.aws/credentials."
    );
  }

  // Node dev: allow the AWS SDK to resolve credentials from the normal chain.
  return { region };
}
