/**
 * AWS client configuration helpers for multiple runtimes.
 *
 * Cloudflare Workers has no filesystem, so the AWS SDK default credential chain
 * (which can try to read ~/.aws/config and ~/.aws/credentials) will fail.
 *
 * In Workers, require explicit environment variable credentials.
 */

import { env } from "../env";

export type AwsCredentialIdentity = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

function isCloudflareWorkersRuntime(): boolean {
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

export function getAwsClientConfig(region: string): { region: string; credentials?: AwsCredentialIdentity } {
  const credentials = getEnvAwsCredentials();
  if (credentials) {
    return { region, credentials };
  }

  if (isCloudflareWorkersRuntime()) {
    throw new Error(
      "AWS credentials are missing in Cloudflare Workers runtime. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN) as Wrangler secrets/vars. Workers cannot read ~/.aws/credentials."
    );
  }

  // Node dev: allow the AWS SDK to resolve credentials from the normal chain.
  return { region };
}
