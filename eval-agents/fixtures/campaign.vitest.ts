import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["eval-agents/fixtures/campaign.fixture.ts"],
    runner: fileURLToPath(new URL("../harness/campaign-runner.ts", import.meta.url)),
    maxWorkers: 1,
    minWorkers: 1,
  },
});
