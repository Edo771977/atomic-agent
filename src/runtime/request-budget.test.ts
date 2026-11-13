import { describe, expect, it } from "vitest";
import { createRequestBudgetScope } from "./request-budget.js";
import { FusionTurnBudget } from "../tools/fusion/turn-budget.js";
import { OpenAiProvider } from "../llm/provider/openai/openai-provider.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";

const model = { id: "m", contextWindow: 200_000, source: "user", pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } } as ResolvedModel;
const provider = { id: "cloud", supportsRequestBudget: true } as LlmProvider;
const entry = { id: "cloud", kind: "openai-compatible" } as LlmProviderConfigEntry;

function setup(usd: number, request: Partial<CompletionRequest> = {}, providerEntry: LlmProviderConfigEntry = entry) {
  const budget = new FusionTurnBudget();
  budget.begin("p", 0, { usd });
  const req = { sessionId: "p", prompt: "hi", maxOutputTokens: 4096, ...request } as CompletionRequest;
  const scope = () => createRequestBudgetScope(budget, req, provider, providerEntry, model)!;
  return { budget, scope };
}

/** check() with a zero cap always reports the accounted spend. */
function spent(budget: FusionTurnBudget): number {
  return budget.check("p", { usd: 0 })!.spentUsd;
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

  it("reserves at least one input token per character of a multi-byte prompt", () => {
    // Independent bound: even a tokenizer emitting one token per character
    // of N characters needs N input tokens at the highest ($3.75) rate.
    const n = 20_000;
    const body = () => ({ model: "m", messages: [{ role: "user", content: "é".repeat(n) }] });
    const perCharacterUsd = (n * 3.75 + 4096 * 15) / 1_000_000;
    expect(() => setup(perCharacterUsd).scope().beforeSend(body())).toThrow(/budget|cap/i);
    expect(() => setup(perCharacterUsd * 4).scope().beforeSend(body())).not.toThrow();
  });

  // A 200k window at the $3.75 cache-write rate alone holds $0.75.
  it.each<[string, Record<string, unknown>]>([
    ["OpenRouter plugins", { plugins: [{ id: "web" }] }],
    ["an :online model id", { model: "m:online" }],
    ["web_search_options", { web_search_options: {} }],
    ["a non-function tool", { tools: [{ type: "web_search_preview" }] }],
  ])("reserves the context window for provider-side input added by %s", (_label, extra) => {
    const body = () => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra });
    expect(() => setup(0.75).scope().beforeSend(body())).toThrow(/budget|cap/i);
    expect(() => setup(0.82).scope().beforeSend(body())).not.toThrow();
  });

  it("refuses provider-side input when the context window is not verified", () => {
    const budget = new FusionTurnBudget();
    budget.begin("p", 0, { usd: 10 });
    const req = { sessionId: "p", prompt: "hi", maxOutputTokens: 4096 } as CompletionRequest;
    const s = createRequestBudgetScope(budget, req, provider, entry, { ...model, source: "default" })!;
    expect(() => s.beforeSend({ model: "m", messages: [], plugins: [{ id: "web" }] })).toThrow(/provider-side input/);
  });

  it("keeps the byte-sized input reservation for function tools", () => {
    const body = { model: "m", messages: [], tools: [{ type: "function", function: { name: "f", parameters: {} } }] };
    expect(() => setup(0.1).scope().beforeSend(body)).not.toThrow();
  });

  function refused(code: string): Error {
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = Object.assign(new Error(`connect ${code}`), { code });
    return error;
  }

  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"])("releases a hold whose send failed with %s before any connection", code => {
    const { budget, scope } = setup(2);
    const s = scope();
    s.beforeSend({ model: "m", messages: [] });
    s.onSendFailed?.(refused(code));
    s.finish(undefined);
    expect(spent(budget)).toBe(0);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"])("keeps the conservative charge for ambiguous transport failure %s", code => {
    const { budget, scope } = setup(2);
    const s = scope();
    s.beforeSend({ model: "m", messages: [] });
    s.onSendFailed?.(refused(code));
    s.finish(undefined);
    expect(spent(budget)).toBeGreaterThan(0.06);
  });

  it.each([[529, 0], [429, 0], [500, 1], [502, 1], [503, 1], [504, 1]])("status %s releases (0) or retains (1) the hold", (status, retained) => {
    const { budget, scope } = setup(2);
    const s = scope();
    s.beforeSend({ model: "m", messages: [] });
    s.onResponse(status);
    s.finish(undefined);
    if (retained) expect(spent(budget)).toBeGreaterThan(0.06); else expect(spent(budget)).toBe(0);
  });

  it("surfaces repeated connection refusals instead of draining the turn budget", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("p", 0, { usd: 0.1 });
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw refused("ECONNREFUSED"); }) as unknown as typeof fetch;
    const p = new OpenAiProvider({ id: "cloud", baseUrl: "https://paid.invalid", apiKey: "", defaultChatModel: "m", fetchImpl });
    const req = { sessionId: "p", maxOutputTokens: 4096, prompt: "hi", grammar: 'root ::= "ok"', slotId: -1 } as CompletionRequest;
    const s = createRequestBudgetScope(budget, req, p, entry, model)!;
    req.requestBudget = s;
    let error: unknown;
    try { await p.complete(req); } catch (caught) { error = caught; }
    s.finish(undefined);
    expect(calls).toBeGreaterThan(1);
    expect(error).toBeInstanceOf(OpenAiHttpError);
    expect(String(error)).toMatch(/network error/);
    expect(spent(budget)).toBe(0);
  }, 30_000);

  it("writes the model profile's cap field when the body carries none", () => {
    const { scope } = setup(10, { maxOutputTokens: undefined }, { ...entry, maxOutputTokens: 8192 });
    const body: Record<string, unknown> = { model: "openai/gpt-5.1", messages: [] };
    scope().beforeSend(body);
    expect(body).toMatchObject({ max_completion_tokens: 8192 });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("refuses a paid send without any explicit output ceiling instead of reserving the context window", () => {
    const { budget, scope } = setup(10, { maxOutputTokens: undefined });
    const body: Record<string, unknown> = { model: "openai/gpt-5.1", messages: [] };
    expect(() => scope().beforeSend(body)).toThrow(/set `maxOutputTokens` on provider entry cloud/);
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(spent(budget)).toBe(0);
  });

  it("accepts a cap field already in the body as the explicit ceiling", () => {
    const { scope } = setup(10, { maxOutputTokens: undefined });
    const body: Record<string, unknown> = { model: "m", messages: [], max_tokens: 2048 };
    scope().beforeSend(body);
    expect(body).toEqual({ model: "m", messages: [], max_tokens: 2048 });
  });

  it("clamps an existing max_completion_tokens without adding max_tokens", () => {
    const { scope } = setup(10);
    const body: Record<string, unknown> = { model: "custom-model", messages: [], max_completion_tokens: 9000 };
    scope().beforeSend(body);
    expect(body).toEqual({ model: "custom-model", messages: [], max_completion_tokens: 4096 });
  });

  it("keeps max_tokens for models whose profile uses it", () => {
    const { scope } = setup(10);
    const body: Record<string, unknown> = { model: "claude-sonnet-4.5", messages: [] };
    scope().beforeSend(body);
    expect(body).toEqual({ model: "claude-sonnet-4.5", messages: [], max_tokens: 4096 });
  });

  it("refuses a paid request with no verified output ceiling", () => {
    const budget = new FusionTurnBudget();
    budget.begin("p", 0, { usd: 10 });
    const req = { sessionId: "p", prompt: "hi" } as CompletionRequest;
    const s = createRequestBudgetScope(budget, req, provider, entry, { ...model, source: "default" })!;
    expect(() => s.beforeSend({ model: "m", messages: [] })).toThrow(/output ceiling/);
  });

  describe("price modifiers carried by the request", () => {
    function scoped(usd: number, priced: ResolvedModel) {
      const budget = new FusionTurnBudget();
      budget.begin("p", 0, { usd });
      const req = { sessionId: "p", prompt: "hi", maxOutputTokens: 4096 } as CompletionRequest;
      return { budget, scope: () => createRequestBudgetScope(budget, req, provider, entry, priced)! };
    }

    it.each(["priority", "flex", "scale", 7])("refuses service_tier %s without a configured multiplier", tier => {
      const { budget, scope } = scoped(10, model);
      expect(() => scope().beforeSend({ model: "m", messages: [], service_tier: tier })).toThrow(/service_tier/);
      expect(spent(budget)).toBe(0);
    });

    it.each([undefined, null, "default", "auto"])("prices service_tier %s at the configured rates", tier => {
      const { scope } = scoped(10, model);
      expect(() => scope().beforeSend({ model: "m", messages: [], service_tier: tier })).not.toThrow();
    });

    it("reserves and settles a configured service-tier multiplier", () => {
      const priced = { ...model, pricing: { ...model.pricing!, serviceTierMultipliers: { priority: 2 } } } as ResolvedModel;
      // Base bound: ~1.1k body tokens at $3.75 + 4096 output at $15 ~= $0.066.
      expect(() => scoped(0.1, priced).scope().beforeSend({ model: "m", messages: [], service_tier: "priority" })).toThrow(/budget|cap/i);
      const { budget, scope } = scoped(0.2, priced);
      const s = scope();
      s.beforeSend({ model: "m", messages: [], service_tier: "priority" });
      s.finish({ usage: { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 } } as never);
      expect(spent(budget)).toBeCloseTo(2 * (1_000 * 3 + 1_000 * 15) / 1_000_000, 9);
    });

    it("reserves long-context rates when the bound input can exceed the threshold", () => {
      const priced = { ...model, pricing: { ...model.pricing!, longContext: { thresholdTokens: 100_000, input: 6, output: 22.5, cacheWrite: 7.5, cacheRead: 0.6 } } } as ResolvedModel;
      const body = () => ({ model: "m", messages: [{ role: "user", content: "a".repeat(120_000) }] });
      // Base rates hold ~$0.52; long-context rates ~$1.00.
      expect(() => scoped(0.8, priced).scope().beforeSend(body())).toThrow(/budget|cap/i);
      expect(() => scoped(1.2, priced).scope().beforeSend(body())).not.toThrow();
      // Below the threshold the base rates still apply.
      expect(() => scoped(0.1, priced).scope().beforeSend({ model: "m", messages: [] })).not.toThrow();
    });
  });
});
