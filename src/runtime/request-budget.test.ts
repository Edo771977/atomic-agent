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

function setup(usd: number, request: Partial<CompletionRequest> = {}) {
  const budget = new FusionTurnBudget();
  budget.begin("p", 0, { usd });
  const req = { sessionId: "p", prompt: "hi", maxOutputTokens: 4096, ...request } as CompletionRequest;
  const scope = () => createRequestBudgetScope(budget, req, provider, entry, model)!;
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

  it("still overestimates input tokens with the UTF-8 byte count plus framing", () => {
    const body = () => ({ model: "m", messages: [{ role: "user", content: "é".repeat(1200) }] });
    const sent = { ...body(), max_tokens: 4096 };
    const bound = ((Buffer.byteLength(JSON.stringify(sent), "utf8") + 1024) * 3.75 + 4096 * 15) / 1_000_000;
    expect(() => setup(bound * 0.999).scope().beforeSend(body())).toThrow(/budget|cap/i);
    expect(() => setup(bound * 1.001).scope().beforeSend(body())).not.toThrow();
});

  function refused(code: string): Error {
    const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    error.cause = Object.assign(new Error(`connect ${code}`), { code });
    return error;
  }

  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])("releases a hold whose send failed with %s before any connection", code => {
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

  it.each([[503, 0], [529, 0], [500, 1], [502, 1], [504, 1]])("status %s releases (0) or retains (1) the hold", (status, retained) => {
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
});
