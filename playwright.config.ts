import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
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
    command: "MC_BACKEND_MODE=mock ENABLE_DEV_LOGIN=true npm run dev -- -p 3004",
    url: "http://localhost:3004",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: "pipe",
  },
});
