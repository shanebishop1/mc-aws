import { resolve } from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// Load environment variables from parent directory's .env file
config({ path: resolve(__dirname, "../.env") });

const nextConfig: NextConfig = {
  // Fix warning about multiple lockfiles in monorepo structure
  outputFileTracingRoot: resolve(__dirname, ".."),

  // Expose specific environment variables to the client
  env: {
    AWS_REGION: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION,
    AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
    CLOUDFLARE_RECORD_ID: process.env.CLOUDFLARE_RECORD_ID,
    CLOUDFLARE_MC_DOMAIN: process.env.CLOUDFLARE_MC_DOMAIN,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    GDRIVE_REMOTE: process.env.GDRIVE_REMOTE,
    GDRIVE_ROOT: process.env.GDRIVE_ROOT,
    INSTANCE_ID: process.env.INSTANCE_ID,
  },
};

export default nextConfig;
