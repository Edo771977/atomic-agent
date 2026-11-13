import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildFusionGuidance, FUSION_GUIDANCE } from "../../prompt/fusion-guidance.js";
import { renderMergeBlock } from "./branch-merge.js";
import { FAILURE_BREAKER_INSTRUCTION } from "./failure-breaker.js";
import { LOCAL_LEG_UNRESPONSIVE_HINT } from "./local-leg-health.js";
import {
  TURN_BUDGET_INSTRUCTION,
  TURN_COUNT_INSTRUCTION,
} from "./turn-budget.js";

/**
 * In fusion mode the orchestrator may not mutate anything
 * (`agent/policies/fusion-orchestrator-mode.ts`). A hint telling it to
 * "do this part yourself" sends it straight into that refusal, so every
 * way out a hint offers is a delegation or telling the person.
 */
describe("orchestrator hints agree with the fusion gate", () => {
  it("offers a re-delegation or the person when the local server stops answering", () => {
    expect(LOCAL_LEG_UNRESPONSIVE_HINT).not.toMatch(/yourself/i);
    expect(LOCAL_LEG_UNRESPONSIVE_HINT).toContain("then delegate this part again, or tell the person");
  });

  it("offers a merge task or the person, never merging by hand", () => {
    const block = renderMergeBlock([
      { id: "merge-t1", title: "Merge t1", instructions: "x", files: ["a.ts"] },
    ]);
    expect(block).not.toMatch(/yourself/i);
    expect(block).toContain("Delegate each merge below as a task (its instructions are in details.merges), or tell the person:");
  });

  it("re-briefs a refused split in the next delegation", () => {
    const source = readFileSync(join(import.meta.dirname, "task-tree.ts"), "utf8");
    expect(source).toContain('"re-brief or split the task in your next fusion.delegate"');
    expect(source).not.toContain("re-brief the task yourself");
  });

  it("mentions 'yourself' only to forbid it", () => {
    for (const text of [FAILURE_BREAKER_INSTRUCTION, TURN_BUDGET_INSTRUCTION, TURN_COUNT_INSTRUCTION]) {
      expect(text).toMatch(/do not (do )?(the work |it |the remaining work )?yourself/i);
    }
    for (const block of [
      FUSION_GUIDANCE,
      buildFusionGuidance({
        workerLeg: "local",
        workerSlots: 2,
        workerTokenBudget: 32_000,
        workerModel: null,
        tokensPerSecond: null,
        workerMaxNewLines: 300,
      }),
    ]) {
      expect(block).not.toMatch(/yourself/i);
      expect(block).toContain("; tell the person what only they can approve.");
    }
  });
});
