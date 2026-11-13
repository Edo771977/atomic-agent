import { describe, expect, it } from "vitest";

import { completionCostUsd, estimateSummedUsageCostUsd, estimateUsageCostUsd } from "./usage-cost.js";

describe("estimateUsageCostUsd", () => {
  it("prices cached prompt tokens at the cacheRead rate", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 800_000 },
      { input: 3, output: 15, cacheRead: 0.3 },
    );
    // 200k uncached at $3/M + 800k cached at $0.30/M.
    expect(usd).toBeCloseTo(0.6 + 0.24, 9);
  });

  it("charges the plain input rate when no cacheRead rate is known", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 800_000 },
      { input: 3, output: 15 },
    );
    expect(usd).toBeCloseTo(3, 9);
  });

  it("is the historical formula when nothing was cached", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 500_000, completionTokens: 100_000, totalTokens: 600_000 },
      { input: 2, output: 10, cacheRead: 0.2 },
    );
    expect(usd).toBeCloseTo(1 + 1, 9);
  });

  // ATO-912: Kimi reports cache writes beside the hits; they are their
  // own share of the prompt and have their own rate.
  it("prices cache-write tokens at the cacheWrite rate when one is known", () => {
    const usd = estimateUsageCostUsd(
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        totalTokens: 1_000_000,
        cachedTokens: 600_000,
        cacheWriteTokens: 300_000,
      },
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
    );
    // 100k uncached at $2 + 600k hits at $0.20 + 300k writes at $4 (1h TTL).
    expect(usd).toBeCloseTo(0.2 + 0.12 + 1.2, 9);
  });

  it("keeps cache writes at the input rate when no cacheWrite rate is known", () => {
    const withWrites = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 600_000, cacheWriteTokens: 300_000 },
      { input: 2, output: 10, cacheRead: 0.2 },
    );
    const without = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 600_000 },
      { input: 2, output: 10, cacheRead: 0.2 },
    );
    expect(withWrites).toBeCloseTo(without, 9);
  });

  it("never lets cache writes eat into the cached share or past the prompt", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 5_000 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
    );
    // Only the 200 tokens left after the hits can be writes.
    expect(usd).toBeCloseTo(200, 9);
  });

  it("never lets a cached count exceed the prompt it is part of", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000, cachedTokens: 5_000 },
      { input: 1_000_000, output: 0, cacheRead: 0 },
    );
    expect(usd).toBe(0);
  });

  it("prefers the service-billed cost over the estimate", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, costUsd: 0.75 },
      { input: 3, output: 15 },
    );
    expect(usd).toBe(0.75);
  });

  it("counts the service-billed cost for an unpriced model, and 0 without one", () => {
    const billed = { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: 0.75 };
    expect(estimateUsageCostUsd(billed, undefined)).toBe(0.75);
    expect(estimateUsageCostUsd({ ...billed, costUsd: undefined }, undefined)).toBe(0);
  });

  it("ignores a negative or non-finite billed cost", () => {
    const base = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };
    expect(estimateUsageCostUsd({ ...base, costUsd: -1 }, { input: 3, output: 15 })).toBeCloseTo(3, 9);
    expect(estimateUsageCostUsd({ ...base, costUsd: Number.NaN }, { input: 3, output: 15 })).toBeCloseTo(3, 9);
  });
});

describe("completionCostUsd", () => {
  const base = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };

  it("is the billed cost when reported, priced or not", () => {
    expect(completionCostUsd({ ...base, costUsd: 0.75 }, undefined)).toBe(0.75);
    expect(completionCostUsd({ ...base, costUsd: 0.75 }, { input: 3, output: 15 })).toBe(0.75);
  });

  it("falls back to the estimate, and is undefined for an unpriced, unbilled call", () => {
    expect(completionCostUsd(base, { input: 3, output: 15 })).toBeCloseTo(3, 9);
    expect(completionCostUsd(base, undefined)).toBeUndefined();
  });
});

describe("long-context pricing", () => {
  const pricing = { input: 3, output: 15, cacheRead: 0.3, longContext: { thresholdTokens: 200_000, input: 6, output: 22.5, cacheRead: 0.6 } };

  it("prices a prompt above the threshold at the long-context rates", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 300_000, completionTokens: 10_000, totalTokens: 310_000, cachedTokens: 100_000 },
      pricing,
    );
    expect(usd).toBeCloseTo((200_000 * 6 + 100_000 * 0.6 + 10_000 * 22.5) / 1_000_000, 9);
  });

  it("keeps the base rates at or below the threshold", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 200_000, completionTokens: 10_000, totalTokens: 210_000 },
      pricing,
    );
    expect(usd).toBeCloseTo((200_000 * 3 + 10_000 * 15) / 1_000_000, 9);
  });

  it("prices a sum of sub-threshold completions at the base rates", () => {
    // Two 150k-token prompts summed to 300k: neither request was long.
    const summed = { promptTokens: 300_000, completionTokens: 10_000, totalTokens: 310_000 };
    expect(estimateSummedUsageCostUsd(summed, pricing)).toBeCloseTo((300_000 * 3 + 10_000 * 15) / 1_000_000, 9);
    expect(estimateSummedUsageCostUsd({ ...summed, costUsd: 0.5 }, pricing)).toBe(0.5);
  });

  it("derives missing long-context cache rates from the base cache ratios", () => {
    const usd = estimateUsageCostUsd(
      { promptTokens: 300_000, completionTokens: 0, totalTokens: 300_000, cachedTokens: 100_000, cacheWriteTokens: 50_000 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, longContext: { thresholdTokens: 200_000, input: 6, output: 22.5 } },
    );
    // Writes at 6 x 3.75/3 = 7.5, reads at 6 x 0.3/3 = 0.6.
    expect(usd).toBeCloseTo((150_000 * 6 + 100_000 * 0.6 + 50_000 * 7.5) / 1_000_000, 9);
  });

  it("still lets a reported bill win", () => {
    expect(completionCostUsd({ promptTokens: 300_000, completionTokens: 0, totalTokens: 300_000, costUsd: 0.5 }, pricing)).toBe(0.5);
  });
});
