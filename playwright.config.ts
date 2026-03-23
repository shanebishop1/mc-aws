import { defineConfig, devices } from "@playwright/test";

// This suite always targets the mock backend via webServer.command.
const isMockMode = true;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: !isMockMode,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : isMockMode ? 1 : undefined,
  reporter: "html",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3001",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Run Playwright against mock dev server so tests can exercise mock-mode
    // flows without weakening the production-only guard that blocks mock mode.
    command: "bash -lc 'set -euo pipefail; export AUTH_SECRET=dev-secret-placeholder; npm run dev:mock -- -p 3001'",
    url: "http://localhost:3001",
    // In mock mode, always start fresh to avoid stale server/mock state.
    reuseExistingServer: !process.env.CI && !isMockMode,
    timeout: 120000,
    stdout: "pipe",
  },
});
