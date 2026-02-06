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
