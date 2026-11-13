import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["eval-agents/fixtures/campaign.fixture.ts"],
    maxWorkers: 1,
    minWorkers: 1,
  },
});
