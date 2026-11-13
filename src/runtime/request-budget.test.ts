import { describe, expect, it } from "vitest";
import { createRequestBudgetScope } from "./request-budget.js";
import { FusionTurnBudget } from "../tools/fusion/turn-budget.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";

const model = { id: "m", contextWindow: 200_000, source: "user", pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } } as ResolvedModel;
const provider = { id: "cloud", supportsRequestBudget: true } as LlmProvider;
const entry = { id: "cloud", kind: "openai-compatible" } as LlmProviderConfigEntry;

function setup(usd: number, request: Partial<CompletionRequest> = {}) {
  const budget = new FusionTurnBudget();
  budget.begin("p", 0, { usd });
  const req = { sessionId: "p", prompt: "hi", maxOutputTokens: 4096, ...request } as CompletionRequest;
  const scope = () => createRequestBudgetScope(budget, req, provider, entry, model)!;
  return { budget, scope };
}

describe("request budget scope", () => {
  it("sizes the input reservation from the serialized body, not the model context window", () => {
    const { scope } = setup(2);
    const outcomes = [1, 2, 3].map(() => {
      try { scope().beforeSend({ model: "m", messages: [{ role: "user", content: "hi" }] }); return "ok"; }
      catch (error) { return (error as Error).message; }
    });
    expect(outcomes).toEqual(["ok", "ok", "ok"]);
  });

  it("still overestimates input tokens with the UTF-8 byte count plus framing", () => {
    const body = () => ({ model: "m", messages: [{ role: "user", content: "é".repeat(1200) }] });
    const sent = { ...body(), max_tokens: 4096 };
    const bound = ((Buffer.byteLength(JSON.stringify(sent), "utf8") + 1024) * 3.75 + 4096 * 15) / 1_000_000;
    expect(() => setup(bound * 0.999).scope().beforeSend(body())).toThrow(/budget|cap/i);
    expect(() => setup(bound * 1.001).scope().beforeSend(body())).not.toThrow();
});
});
