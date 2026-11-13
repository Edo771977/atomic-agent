import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { TurnUsageMeter } from "../../analytics/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { outcomeLogPath } from "../../tools/fusion/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeFusionOutcomes } from "./runtime-fusion-outcomes.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

const mode = {
  orchestratorProviderId: "claude-cli",
  orchestratorModel: "strong",
  primaryProviderId: "claude-cli",
} as ResolvedRunMode;

describe("runtime fusion outcomes: the turn receipt", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-receipt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the receipt just before turn_finished and appends the turn record", () => {
    let enabled = true;
    const outcomes = createRuntimeFusionOutcomes({
      stateDir: dir,
      logger,
      resolveRunMode: () => mode,
      outcomeLogEnabled: () => enabled,
    });
    // The meter feeds the orchestrator's completions into the ledger.
    const meter = new TurnUsageMeter({ onRecord: outcomes.onUsageRecord });
    meter.begin("s1");
    outcomes.beginTurn("s1");
    meter.recordServed("s1", "claude-cli");
    meter.record({ sessionId: "s1", usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedTokens: 800 } });
    meter.recordServed("s1", "claude-cli");
    meter.record({ sessionId: "s1", usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedTokens: 900 } });

    const seen: AgentLoopEvent[] = [];
    const sink = outcomes.wrapEventSink((e) => seen.push(e), () => "s1");
    sink({ type: "turn_finished", turnIndex: 0, reason: "reply", stepCount: 2, durationMs: 10 });
    expect(seen.map((e) => e.type)).toEqual(["fusion_worker", "turn_finished"]);
    expect(seen[0]).toMatchObject({
      type: "fusion_worker",
      role: "orchestrator",
      phase: "finished",
      taskId: "fusion.turn",
      model: "strong",
      summary: "fusion receipt · strong unpriced (subscription), 2 requests, cache hit 85%",
    });
    const lines = readFileSync(outcomeLogPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "turn",
      orchestrator: {
        provider: "claude-cli",
        requests: 2,
        cachedTokens: 1700,
        steps: [
          { in: 1000, cached: 800 },
          { in: 1000, cached: 900 },
        ],
      },
    });

    // A turn that was not a fusion turn passes through with no receipt,
    // and with the toggle off nothing reaches the file.
    seen.length = 0;
    sink({ type: "turn_finished", turnIndex: 1, reason: "reply", stepCount: 1, durationMs: 1 });
    expect(seen.map((e) => e.type)).toEqual(["turn_finished"]);
    enabled = false;
    outcomes.beginTurn("s1");
    meter.record({ sessionId: "s1", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    sink({ type: "turn_finished", turnIndex: 2, reason: "reply", stepCount: 1, durationMs: 1 });
    expect(readFileSync(outcomeLogPath(dir), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("writes nothing before any fusion turn", () => {
    createRuntimeFusionOutcomes({
      stateDir: dir,
      logger,
      resolveRunMode: () => mode,
      outcomeLogEnabled: () => true,
    });
    expect(existsSync(join(dir, "fusion"))).toBe(false);
  });
});
