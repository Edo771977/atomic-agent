import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import {
  DEFAULT_LOCAL_WORKER_REASONING_BUDGET_TOKENS,
  DEFAULT_REASONING_BUDGET_TOKENS,
  LOCAL_WORKER_REASONING_BUDGET_TOKENS,
  REASONING_CHARS_PER_TOKEN,
  effectiveReasoningBudgetTokens,
  estimateReasoningTokens,
  localWorkerReasoningBudgetTokens,
  reasoningBudgetChars,
} from "./reasoning-budget.js";

describe("reasoning budget units (F49)", () => {
  it("shares its default with the config schema", () => {
    expect(DEFAULT_REASONING_BUDGET_TOKENS).toBe(
      USER_CONFIG_DEFAULTS.localModels.reasoningBudgetTokens,
    );
  });

  it("prices a budget at four characters per token, and keeps 0 unbounded", () => {
    expect(REASONING_CHARS_PER_TOKEN).toBe(4);
    expect(reasoningBudgetChars(1500)).toBe(6000);
    expect(reasoningBudgetChars(64)).toBe(256);
    expect(reasoningBudgetChars(0)).toBe(0);
    expect(reasoningBudgetChars(-5)).toBe(0);
    expect(reasoningBudgetChars(Number.NaN)).toBe(0);
  });

  it("prices a completion's reasoning at the same ratio, so a cut reads as the budget", () => {
    expect(estimateReasoningTokens("")).toBe(0);
    expect(estimateReasoningTokens("abc")).toBe(1);
    expect(estimateReasoningTokens("x".repeat(reasoningBudgetChars(1500)))).toBe(
      1500,
    );
  });
});

describe("effective reasoning budget (ATO-607: no 1,999-char llama.cpp clamp)", () => {
  it("is the configured budget, floored, past the old 499-token cap", () => {
    expect(effectiveReasoningBudgetTokens(1500)).toBe(1500);
    expect(effectiveReasoningBudgetTokens(32768)).toBe(32768);
    expect(effectiveReasoningBudgetTokens(500)).toBe(500);
    expect(effectiveReasoningBudgetTokens(499)).toBe(499);
    expect(effectiveReasoningBudgetTokens(64.9)).toBe(64);
  });

  it("keeps 0, negative and non-finite budgets unbounded", () => {
    expect(effectiveReasoningBudgetTokens(0)).toBe(0);
    expect(effectiveReasoningBudgetTokens(-5)).toBe(0);
    expect(effectiveReasoningBudgetTokens(Number.NaN)).toBe(0);
  });
});

describe("a local fusion worker's reasoning bound (workerReasoning on a grammar leg)", () => {
  it("maps each workerReasoning level to its own bound, whatever the config says", () => {
    expect(LOCAL_WORKER_REASONING_BUDGET_TOKENS).toEqual({ low: 512, medium: 1536, high: 4096 });
    for (const configured of [0, 800, 32768]) {
      expect(localWorkerReasoningBudgetTokens("low", configured)).toBe(512);
      expect(localWorkerReasoningBudgetTokens("medium", configured)).toBe(1536);
      expect(localWorkerReasoningBudgetTokens("high", configured)).toBe(4096);
    }
  });

  it("is bounded by default when workerReasoning is unset and the config is unbounded", () => {
    expect(DEFAULT_LOCAL_WORKER_REASONING_BUDGET_TOKENS).toBe(1536);
    expect(localWorkerReasoningBudgetTokens(undefined, DEFAULT_REASONING_BUDGET_TOKENS)).toBe(1536);
    expect(localWorkerReasoningBudgetTokens(undefined, 0)).toBe(1536);
    expect(localWorkerReasoningBudgetTokens(undefined, Number.NaN)).toBe(1536);
  });

  it("keeps a configured localModels.reasoningBudgetTokens when workerReasoning is unset", () => {
    expect(localWorkerReasoningBudgetTokens(undefined, 800)).toBe(800);
    expect(localWorkerReasoningBudgetTokens(undefined, 8000.7)).toBe(8000);
    // As set, not capped at the default: a larger bound was chosen too.
    expect(localWorkerReasoningBudgetTokens(undefined, 8000)).toBe(8000);
  });

  it("lets an explicit level win over a stricter configured bound", () => {
    expect(localWorkerReasoningBudgetTokens("low", 256)).toBe(512);
  });

  it("opts out with \"unbounded\": 0, no bound, whatever the config says", () => {
    for (const configured of [0, 256, 8000]) {
      expect(localWorkerReasoningBudgetTokens("unbounded", configured)).toBe(0);
    }
  });
});
