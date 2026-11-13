import { vi } from "vitest";
import type { AgentAdapter } from "../harness/agent-adapter.js";

// Import the actual campaign and actual case runner, replacing only external
// adapter execution, environment probing and .env loading. Never call a model.
vi.mock("../harness/load-env.js", () => ({ loadEvalAgentsEnvFile() {} }));
vi.mock("../harness/environment-lock.js", () => ({
  captureEnvironmentSnapshot: async () => ({ hermeticFixture: true }),
}));
vi.mock("../adapters/index.js", () => ({
  listAgentAdapters(filter?: string[]): AgentAdapter[] {
    const adapters: AgentAdapter[] = ["ready", "missing"].map((id) => ({
      id, label: id,
      probeRequirements: () => id === "missing" ? ["fixture executable unavailable"] : [],
      runQuestion: async ({ row }) => ({
        rawReply: `FINAL ANSWER: ${row["Final answer"]}`,
        metrics: { stepCount: 1, promptTokens: 0, predictedTokens: 0,
          toolErrors: 0, wallClockMs: 1, timedOut: false, exitCode: 0 },
        exitCode: 0, timedOut: false, error: null,
      }),
    }));
    return adapters.filter((adapter) => !filter || filter.includes(adapter.id));
  },
}));

await import("../gaia.eval.js");
