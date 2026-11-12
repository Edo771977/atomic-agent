import { describe, expect, it } from "vitest";

import { normaliseOpenAiUsage } from "./openai-normalise-response.js";

describe("normaliseOpenAiUsage: output tokens missing from completion_tokens", () => {
  it("bills the excess of total_tokens as output when completion_tokens leaves out thinking", () => {
    // A service whose completion_tokens counts only the visible reply,
    // while total_tokens also counts the hidden thinking tokens.
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 420,
    });
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(320);
    expect(usage.totalTokens).toBe(420);
  });

  it("does not double count when completion_tokens already includes reasoning", () => {
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 320,
      total_tokens: 420,
      completion_tokens_details: { reasoning_tokens: 300 },
    });
    expect(usage.completionTokens).toBe(320);
  });

  it("leaves completion_tokens alone when total_tokens is missing or smaller", () => {
    expect(
      normaliseOpenAiUsage({ prompt_tokens: 100, completion_tokens: 20 })
        .completionTokens,
    ).toBe(20);
    expect(
      normaliseOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 50,
      }).completionTokens,
    ).toBe(20);
  });

  it("does not read cache reads reported outside prompt_tokens as output", () => {
    // An Anthropic-style shim may leave cache reads out of prompt_tokens
    // and count them in total_tokens; that excess is not output.
    const usage = normaliseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 1120,
      cache_read_input_tokens: 1000,
    });
    expect(usage.completionTokens).toBe(20);
  });
});
