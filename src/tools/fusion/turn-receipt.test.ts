import { describe, expect, it } from "vitest";

import { sessionTag } from "./outcome-log.js";
import { FusionTurnLedger, cacheHitPercent, formatTurnReceipt } from "./turn-receipt.js";

const usage = (promptTokens: number, completionTokens: number, cachedTokens?: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
  ...(cachedTokens === undefined ? {} : { cachedTokens }),
});

describe("fusion turn receipt", () => {
  it("sums the strong side per request with its cache hits, and the workers per fan-out", () => {
    const ledger = new FusionTurnLedger();
    ledger.begin("s1", { providerId: "claude-cli", model: "strong" });
    ledger.noteCompletion("s1", { providerId: "claude-cli", usage: usage(10_000, 300, 0), costUsd: 0.02 });
    ledger.noteCompletion("s1", { providerId: "claude-cli", usage: usage(12_000, 200, 9_000), costUsd: 0.01 });
    ledger.noteFanout("s1", {
      tasks: [
        { ok: true, tokens: 30_000, durationMs: 50_000, costUsd: null, orchestrator: false },
        { ok: false, tokens: 11_200, durationMs: 70_000, costUsd: null, orchestrator: false },
      ],
      wallMs: 130_000,
      judgeCostUsd: 0.005,
      escalationCostUsd: 0,
    });
    // Another session's completions and an unopened one change nothing.
    ledger.noteCompletion("s2", { usage: usage(1, 1) });
    const receipt = ledger.finish("s1", new Date("2026-11-01T00:00:00Z"))!;
    expect(receipt.record).toEqual({
      v: 1,
      type: "turn",
      ts: "2026-11-01T00:00:00.000Z",
      session: sessionTag("s1"),
      orchestrator: {
        provider: "claude-cli",
        model: "strong",
        requests: 2,
        tokensIn: 22_000,
        tokensOut: 500,
        cachedTokens: 9_000,
        costUsd: 0.035,
        requestCostUsd: 0.03,
        judgeCostUsd: 0.005,
        escalationCostUsd: 0,
        steps: [
          { in: 10_000, cached: 0 },
          { in: 12_000, cached: 9_000 },
        ],
      },
      fanouts: 1,
      tasks: { total: 2, ok: 1, failed: 1 },
      orchestratorTasks: { total: 0, costUsd: null },
      workerTokens: 41_200,
      workerMs: 130_000,
      workerCostUsd: null,
    });
    expect(receipt.line).toBe(
      "fusion receipt · strong $0.04, 2 requests, cache hit 41% · workers 41.2k tokens, 2m10s · tasks 1 ok, 1 failed",
    );
    expect(ledger.finish("s1")).toBeUndefined();
  });

  it("says unpriced and leaves the cache figure out when the strong side reports neither", () => {
    const ledger = new FusionTurnLedger();
    ledger.begin("s1", { providerId: "cli", model: "strong" });
    ledger.noteCompletion("s1", { usage: usage(100, 10) });
    const receipt = ledger.finish("s1")!;
    expect(receipt.record.orchestrator.cachedTokens).toBeNull();
    expect(receipt.record.orchestrator.costUsd).toBeNull();
    expect(receipt.line).toBe("fusion receipt · strong unpriced (subscription), 1 request");
  });

  it("names an unpriced orchestrator beside a priced judge instead of reading the judge as the strong side", () => {
    const ledger = new FusionTurnLedger();
    ledger.begin("s1", { providerId: "claude-cli", model: "strong" });
    ledger.noteCompletion("s1", { providerId: "claude-cli", usage: usage(1_000, 10) });
    ledger.noteFanout("s1", {
      tasks: [{ ok: true, tokens: 500, durationMs: 1_000, costUsd: null, orchestrator: false }],
      wallMs: 1_000,
      judgeCostUsd: 0.03,
      escalationCostUsd: 0,
    });
    const receipt = ledger.finish("s1")!;
    expect(receipt.record.orchestrator).toMatchObject({
      requestCostUsd: null,
      judgeCostUsd: 0.03,
      escalationCostUsd: 0,
    });
    expect(receipt.line).toBe(
      "fusion receipt · strong unpriced (subscription) + $0.03 judge, 1 request · workers 500 tokens, 1s · tasks 1 ok",
    );
  });

  it("counts model:\"orchestrator\" tasks as strong-side spend, as the report does, not as worker cost", () => {
    const ledger = new FusionTurnLedger();
    ledger.begin("s1", { providerId: "openrouter", model: "strong" });
    ledger.noteCompletion("s1", { providerId: "openrouter", usage: usage(1_000, 10), costUsd: 0.01 });
    ledger.noteFanout("s1", {
      tasks: [
        { ok: true, tokens: 700, durationMs: 1_000, costUsd: 0.02, orchestrator: true },
        { ok: true, tokens: 300, durationMs: 1_000, costUsd: 0.005, orchestrator: false },
      ],
      wallMs: 2_000,
      judgeCostUsd: 0,
      escalationCostUsd: 0.004,
    });
    const receipt = ledger.finish("s1")!;
    expect(receipt.record.orchestratorTasks).toEqual({ total: 1, costUsd: 0.02 });
    expect(receipt.record.workerCostUsd).toBe(0.005);
    expect(receipt.record.workerTokens).toBe(300);
    // The record's own-requests total keeps the judge and escalation calls, as the report reads it.
    expect(receipt.record.orchestrator.costUsd).toBe(0.014);
    expect(receipt.line).toBe(
      "fusion receipt · strong $0.03, 1 request · workers 300 tokens, 2s, $0.0050 · tasks 2 ok",
    );
    // An unpriced orchestrator task is said so, too.
    ledger.begin("s2", { providerId: "claude-cli", model: "strong" });
    ledger.noteFanout("s2", {
      tasks: [{ ok: true, tokens: 700, durationMs: 1_000, costUsd: null, orchestrator: true }],
      wallMs: 1_000,
      judgeCostUsd: 0.01,
      escalationCostUsd: 0,
    });
    expect(ledger.finish("s2")!.line).toBe(
      "fusion receipt · strong unpriced orchestrator task + $0.01 judge, 0 requests · workers 0 tokens, 1s · tasks 1 ok",
    );
  });

  it("writes an orchestrator model set to a local path as its base name", () => {
    const ledger = new FusionTurnLedger();
    ledger.begin("s1", { providerId: "local-llama", model: "/home/alice/models/big.gguf" });
    ledger.noteCompletion("s1", { usage: usage(100, 10) });
    const record = ledger.finish("s1")!.record;
    expect(record.orchestrator.model).toBe("big");
    expect(JSON.stringify(record)).not.toContain("alice");
  });

  it("gives no receipt for a turn in which nothing ran", () => {
    const ledger = new FusionTurnLedger();
    ledger.begin("s1", { providerId: "cli", model: "strong" });
    expect(ledger.finish("s1")).toBeUndefined();
  });

  it("computes the hit share of the prompt tokens", () => {
    expect(cacheHitPercent({ cachedTokens: 750, tokensIn: 1000 })).toBe(75);
    expect(cacheHitPercent({ cachedTokens: null, tokensIn: 1000 })).toBeNull();
    expect(cacheHitPercent({ cachedTokens: 0, tokensIn: 0 })).toBeNull();
    const line = formatTurnReceipt({
      v: 1, type: "turn", ts: "", session: "",
      orchestrator: { provider: "p", model: "m", requests: 3, tokensIn: 1000, tokensOut: 1, cachedTokens: 900, costUsd: 0.001, requestCostUsd: 0.001, judgeCostUsd: 0, escalationCostUsd: 0, steps: [] },
      fanouts: 1, tasks: { total: 2, ok: 2, failed: 0 }, orchestratorTasks: { total: 0, costUsd: null }, workerTokens: 500, workerMs: 4_000, workerCostUsd: 0.25,
    });
    expect(line).toBe("fusion receipt · strong $0.0010, 3 requests, cache hit 90% · workers 500 tokens, 4s, $0.25 · tasks 2 ok");
  });
});
