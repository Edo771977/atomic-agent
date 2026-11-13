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
