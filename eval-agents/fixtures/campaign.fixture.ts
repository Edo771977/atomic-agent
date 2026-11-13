import { vi } from "vitest";
import type { AgentAdapter } from "../harness/agent-adapter.js";

// Import the actual campaign and actual case runner, replacing only external
// adapter execution, environment probing and .env loading. Never call a model.
vi.mock("../harness/load-env.js", () => ({ loadEvalAgentsEnvFile() {} }));
vi.mock("../harness/environment-lock.js", () => ({
  captureEnvironmentSnapshot: async () => ({ hermeticFixture: true }),
}));
const fixtureAdapter = vi.hoisted(() => (id: string): AgentAdapter => ({
      id, label: id,
      probeRequirements: () => id === "missing" ? ["fixture executable unavailable"] : [],
      runQuestion: async ({ row }) => ({
        rawReply: `FINAL ANSWER: ${row["Final answer"]}`,
        metrics: { stepCount: 1, promptTokens: 0, predictedTokens: 0,
          toolErrors: 0, wallClockMs: 1, timedOut: false, exitCode: 0 },
        exitCode: 0, timedOut: false, error: null,
      }),
}));
vi.mock("../adapters/atomic-agent-adapter.js", () => ({ createAtomicAgentAdapter: () => fixtureAdapter("ready") }));
vi.mock("../adapters/hermes-adapter.js", () => ({ createHermesAdapter: () => fixtureAdapter("missing") }));
vi.mock("../adapters/openclaw-adapter.js", () => ({ createOpenclawAdapter: () => fixtureAdapter("other") }));

await import("../gaia.eval.js");
