import { resolve } from "node:path";
import type { NextConfig } from "next";

// These paths are repository-local inputs, never runtime dependencies. The
// same Next trace is consumed by OpenNext, so keeping this list here protects
// both the standalone tree and the Cloudflare bundle.
export const buildArtifactTracingExcludes = [
  "./.mock-state.json",
  "./.mock-state.json.*",
  "./.local-artifacts/**/*",
  "./.env*",
  "./**/.mock-state.json",
  "./**/.mock-state.json.*",
];

const nextConfig: NextConfig = {
  // OpenNext expects standalone output rooted at this app.
  // Using the parent directory causes Next.js to nest files under .next/standalone/<project>/...
  // which breaks OpenNext's manifest lookups.
  outputFileTracingRoot: resolve(__dirname),
  // Local agent instructions are developer-only and must never enter panel artifacts.
  outputFileTracingExcludes: {
    "*": [".agents/**/*", ...buildArtifactTracingExcludes],
  },

  // Required by OpenNext adapters (generates .next/standalone output).
  output: "standalone",

  // Hide dev toolbar
  devIndicators: false,

  // Security headers for all responses
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
