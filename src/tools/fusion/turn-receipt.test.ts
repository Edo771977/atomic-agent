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
        { ok: true, tokens: 30_000, durationMs: 50_000, costUsd: null },
        { ok: false, tokens: 11_200, durationMs: 70_000, costUsd: null },
      ],
      wallMs: 130_000,
      sideCostUsd: 0.005,
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
        steps: [
          { in: 10_000, cached: 0 },
          { in: 12_000, cached: 9_000 },
        ],
      },
      fanouts: 1,
      tasks: { total: 2, ok: 1, failed: 1 },
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
    expect(receipt.line).toBe("fusion receipt · strong unpriced, 1 request");
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
      orchestrator: { provider: "p", model: "m", requests: 3, tokensIn: 1000, tokensOut: 1, cachedTokens: 900, costUsd: 0.001, steps: [] },
      fanouts: 1, tasks: { total: 2, ok: 2, failed: 0 }, workerTokens: 500, workerMs: 4_000, workerCostUsd: 0.25,
    });
    expect(line).toBe("fusion receipt · strong $0.0010, 3 requests, cache hit 90% · workers 500 tokens, 4s, $0.25 · tasks 2 ok");
  });
});
