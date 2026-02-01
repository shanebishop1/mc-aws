import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fix warning about multiple lockfiles in monorepo structure
  outputFileTracingRoot: resolve(__dirname, ".."),

  // Hide dev toolbar
  devIndicators: false,

  // Expose specific environment variables to the client
    // Only expose safe/public variables here.
    // Secrets (CLOUDFLARE_API_TOKEN, etc.) must remain server-side only.
    AWS_REGION: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION,
    AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT,
};

export default nextConfig;
