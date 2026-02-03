import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OpenNext expects standalone output rooted at this app.
  // Using the parent directory causes Next.js to nest files under .next/standalone/<project>/...
  // which breaks OpenNext's manifest lookups.
  outputFileTracingRoot: resolve(__dirname),

  // Required by OpenNext adapters (generates .next/standalone output).
  output: "standalone",

  // Hide dev toolbar
  devIndicators: false,
};

export default nextConfig;
