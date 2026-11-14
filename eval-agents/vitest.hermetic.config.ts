import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from the campaigns: no *.eval.ts, daemons, judge or providers.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: [
      "eval-agents/harness/**/*.test.ts",
      "eval-agents/adapters/**/*.test.ts",
      "eval-agents/scripts/**/*.test.ts",
      "eval/**/*.test.ts",
    ],
    exclude: ["**/fixtures/**", "**/node_modules/**"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 20_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
