import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/agent-local-vertical-slice.test.ts", "tests/agent-security-adversarial.test.ts"],
    setupFiles: ["./tests/setup.ts", "./tests/agent-e2e-network.setup.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
