import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fix warning about multiple lockfiles in monorepo structure
  outputFileTracingRoot: resolve(__dirname, ".."),

  // Hide dev toolbar
  devIndicators: false,

};

export default nextConfig;
