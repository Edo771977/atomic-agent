import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCampaignScenario } from "../../harness/run-campaign-scenario.js";
import type { MultiTurnResult, TurnRecord } from "../../harness/multi-turn-driver.js";
import { buildDiagnosticsEntry } from "./diagnostics-writer.js";
import { runLocomoConversation } from "./runner.js";
import type { LocomoConversation } from "./dataset.js";

vi.mock("../../harness/run-campaign-scenario.js", () => ({ runCampaignScenario: vi.fn() }));

const conversation: LocomoConversation = {
  sampleId: "c1", speakerA: "A", speakerB: "B",
  sessions: [{ id: "session_1", dateTime: null, turns: [{ speaker: "A", text: "I live in Rome." }] }],
  qa: [1, 2].map((n) => ({
    question: `Question ${n}`, answer: "Rome", category: 1, categoryLabel: "single_hop", evidence: [], adversarialAnswer: null,
  })),
};
const turn = (index: number, overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  index, userMessage: "prompt", assistantReply: "reply", reason: "reply", stepCount: 1, durationMs: 10,
  promptTokens: 20, predictedTokens: 3, parseRetries: 0, toolCalls: [], cacheHits: 0,
  failureCategory: null, failureMessage: null, ...overrides,
});
const childResult: MultiTurnResult = {
  exitCode: null, signal: "SIGTERM", timedOut: true, durationMs: 1234, sessionId: "session-1",
  turns: [turn(0), turn(1, { assistantReply: "", reason: "failed", failureCategory: "provider-unreachable" })],
  stderrTail: "tail", stderrAll: "complete stderr\ntail", replyLinesPerPrompt: ["reply", null, null],
};

describe("LoCoMo diagnostics from scenario results", () => {
  beforeEach(() => {
    vi.mocked(runCampaignScenario).mockResolvedValue({
      stateDir: join(tmpdir(), "kept-state"), workingDir: join(tmpdir(), "kept-work"), result: childResult,
    });
  });

  it("preserves child termination and question failures through the report boundary", async () => {
    const result = await runLocomoConversation({ profile: "fts5_only", llamaUrl: "http://127.0.0.1:18991", conversation, keepStateDir: true });
    expect(result).toMatchObject({
      ok: false, exitCode: null, signal: "SIGTERM", timedOut: true, subprocessDurationMs: 1234,
      sessionId: "session-1", stderrAll: "complete stderr\ntail",
      keptTracePath: join(tmpdir(), "kept-state", "traces", "session-1.ndjson"),
      questions: [
        { reason: "failed", failureCategory: "provider-unreachable" },
        { reason: null, failureCategory: null },
      ],
    });
    expect(buildDiagnosticsEntry(result)).toMatchObject({
      emptyReplies: 2, reasonHistogram: { failed: 1, "<no-turn>": 1 },
      failureCategoryHistogram: { "provider-unreachable": 1 },
    });
  });

  it("does not advertise retained paths after ordinary cleanup", async () => {
    const result = await runLocomoConversation({ profile: "fts5_only", llamaUrl: "http://127.0.0.1:18991", conversation });
    expect(result).toMatchObject({ keptStateDir: null, keptWorkingDir: null, keptTracePath: null });
  });
});
