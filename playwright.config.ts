import { defineConfig, devices } from "@playwright/test";

const isMockMode = process.env.MC_BACKEND_MODE === "mock";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: !isMockMode,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : isMockMode ? 1 : undefined,
  reporter: "html",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3004",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "bash -lc 'set -euo pipefail; export MC_BACKEND_MODE=mock ENABLE_DEV_LOGIN=true AUTH_SECRET=dev-secret-placeholder; npm run build; npm run start -- -p 3004'",
    url: "http://localhost:3004",
    // In mock mode, always start fresh to avoid stale server/mock state.
    reuseExistingServer: !process.env.CI && !isMockMode,
    timeout: 120000,
    stdout: "pipe",
  },
});
