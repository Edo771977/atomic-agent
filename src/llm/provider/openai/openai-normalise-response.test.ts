import { describe, expect, it } from "vitest";

import { normaliseOpenAiChatResponse, normaliseOpenAiUsage } from "./openai-normalise-response.js";
import { estimateUsageCostUsd } from "../usage-cost.js";

const PRICING = { input: 1, output: 10 };

describe("normaliseOpenAiUsage: output tokens missing from completion_tokens", () => {
  it("bills the excess of total_tokens as output, outside completionTokens", () => {
    // A service whose completion_tokens counts only the visible reply,
    // while total_tokens also counts the hidden thinking tokens.
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 420,
    });
    expect(usage.promptTokens).toBe(100);
    // The inferred excess is priced, but not counted as a reported reply
    // length (tok/s, truncation recovery read completionTokens).
    expect(usage.completionTokens).toBe(20);
    expect(usage.unreportedOutputTokens).toBe(300);
    expect(usage.totalTokens).toBe(420);
    expect(estimateUsageCostUsd(usage, PRICING)).toBeCloseTo((100 * 1 + 320 * 10) / 1e6);
  });

  it("keeps the excess out of the predicted token count a completion reports", () => {
    const result = normaliseOpenAiChatResponse(
      {
        choices: [{ message: { content: "hi" }, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 420 },
      },
      "m",
    );
    expect(result.timing.predictedTokens).toBe(20);
    expect(result.usage?.completionTokens).toBe(20);
  });

  it("does not double count when completion_tokens already includes reasoning", () => {
    // OpenAI: reasoning_tokens is a subset of completion_tokens.
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 320,
      total_tokens: 420,
      completion_tokens_details: { reasoning_tokens: 300 },
    });
    expect(usage.completionTokens).toBe(320);
    expect(usage.unreportedOutputTokens).toBeUndefined();
  });

  it("adds reasoning_tokens that are evidently outside completion_tokens", () => {
    // More reasoning than completion: it cannot be a subset.
    expect(
      normaliseOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 420,
        completion_tokens_details: { reasoning_tokens: 300 },
      }),
    ).toMatchObject({ completionTokens: 320 });
    // Smaller than completion, but total only adds up with it outside.
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 190,
      completion_tokens_details: { reasoning_tokens: 40 },
    });
    expect(usage.completionTokens).toBe(90);
    expect(usage.unreportedOutputTokens).toBeUndefined();
  });

  it("prefers reasoning_tokens over the total excess", () => {
    // reasoning_tokens is a subset here; the leftover excess is something
    // else (not output), so nothing is added.
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 400,
      completion_tokens_details: { reasoning_tokens: 30 },
    });
    expect(usage.completionTokens).toBe(50);
    expect(usage.unreportedOutputTokens).toBeUndefined();
  });

  it("leaves completion_tokens alone when total_tokens is missing or smaller", () => {
    expect(
      normaliseOpenAiUsage({ prompt_tokens: 100, completion_tokens: 20 }),
    ).toMatchObject({ completionTokens: 20 });
    const smaller = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 50,
    });
    expect(smaller.completionTokens).toBe(20);
    expect(smaller.unreportedOutputTokens).toBeUndefined();
  });

  it("does not guess when prompt_tokens or completion_tokens is missing", () => {
    // A usage chunk with a total but no prompt count: the whole total
    // is not output.
    expect(
      normaliseOpenAiUsage({ completion_tokens: 20, total_tokens: 420 })
        .unreportedOutputTokens,
    ).toBeUndefined();
    expect(
      normaliseOpenAiUsage({ prompt_tokens: 100, total_tokens: 420 })
        .unreportedOutputTokens,
    ).toBeUndefined();
  });

  it.each([
    ["cache reads outside prompt_tokens", { cache_read_input_tokens: 1000 }],
    ["cache writes outside prompt_tokens", { cache_creation_input_tokens: 1000 }],
    ["search tokens", { search_context_tokens: 1000 }],
    ["citation tokens", { citation_tokens: 1000 }],
    ["image tokens in details", { completion_tokens_details: { image_tokens: 1000 } }],
    ["audio tokens in details", { prompt_tokens_details: { audio_tokens: 0 } }],
  ])("does not read the excess as output beside %s", (_label, extra) => {
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 1120,
      ...extra,
    });
    expect(usage.completionTokens).toBe(20);
    expect(usage.unreportedOutputTokens).toBeUndefined();
  });
});

describe("normaliseOpenAiChatResponse: served service tier", () => {
  it("carries the response's service_tier on the usage", () => {
    const result = normaliseOpenAiChatResponse(
      { model: "m", service_tier: "priority", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      "m",
    );
    expect(result.usage?.serviceTier).toBe("priority");
  });

  it("leaves the tier out when the response does not say", () => {
    const result = normaliseOpenAiChatResponse(
      { model: "m", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      "m",
    );
    expect(result.usage).not.toHaveProperty("serviceTier");
  });
});

describe("normaliseOpenAiUsage: Anthropic-shaped cache counts", () => {
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, longContext: { thresholdTokens: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 } };

  it("adds cache reads and writes reported outside prompt_tokens to the prompt", () => {
    // Anthropic's `input_tokens` excludes both cache counts.
    const usage = normaliseOpenAiUsage({ prompt_tokens: 5_000, completion_tokens: 100, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 60_000 });
    expect(usage).toMatchObject({ promptTokens: 215_000, cachedTokens: 150_000, cacheWriteTokens: 60_000 });
    // 215k crosses the 200k long-context threshold though prompt_tokens alone does not.
    expect(estimateUsageCostUsd(usage, pricing)).toBeCloseTo((5_000 * 6 + 150_000 * 0.6 + 60_000 * 7.5 + 100 * 22.5) / 1_000_000, 9);
  });

  it("treats them as outside when total_tokens counts them separately", () => {
    const usage = normaliseOpenAiUsage({ prompt_tokens: 150_000, completion_tokens: 100, total_tokens: 250_100, cache_read_input_tokens: 100_000 });
    expect(usage.promptTokens).toBe(250_000);
    expect(usage.cachedTokens).toBe(100_000);
  });

  it("keeps the prompt when total_tokens says they are already inside it", () => {
    const usage = normaliseOpenAiUsage({ prompt_tokens: 150_000, completion_tokens: 100, total_tokens: 150_100, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 20_000 });
    expect(usage).toMatchObject({ promptTokens: 150_000, cachedTokens: 100_000, cacheWriteTokens: 20_000 });
  });

  it("reads OpenAI's prompt_tokens_details as part of the prompt, as before", () => {
    const usage = normaliseOpenAiUsage({ prompt_tokens: 150_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 100_000 } });
    expect(usage).toMatchObject({ promptTokens: 150_000, cachedTokens: 100_000 });
  });
});
