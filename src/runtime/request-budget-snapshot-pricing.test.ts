import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestBudgetScope } from "./request-budget.js";
import { createDailySpendBudget } from "./daily-spend-budget.js";
import { linkSpendBilling, verifiedAdmissionPricing } from "./link-spend-billing.js";
import { hasPricedCloudLink, resolveModelPricingFor } from "./resolve-model-pricing.js";
import { DailySpendStore } from "../session/daily-spend.js";
import { FusionTurnBudget } from "../tools/fusion/turn-budget.js";
import type { CompletionRequest } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";

/**
 * The bundled models.dev snapshot is a community price list frozen at
 * generation time: good enough to estimate spend, never good enough to
 * refuse a request ahead of sending it. A preset priced only by the
 * snapshot must stay metered under a turn cap or a daily limit.
 */
const resolved = {
  activeTextProvider: "anthropic",
  activeEmbeddingProvider: "anthropic",
  toolTransport: "auto",
  providers: [
    { id: "anthropic", kind: "openai-compatible", baseUrl: "https://api.anthropic.com", defaultChatModel: "claude-haiku-4-5" },
  ],
} as unknown as ResolvedLlmConfig;
const entry = resolved.providers[0]!;
const provider = { id: "anthropic", supportsRequestBudget: true } as LlmProvider;
// ~1M tokens of prompt: far above a $1 cap at the snapshot's input rate.
const huge = "x".repeat(3_000_000);

function turn(usd = 1) {
  const budget = new FusionTurnBudget();
  budget.begin("p", 0, { usd });
  const scope = () => createRequestBudgetScope(
    budget,
    { sessionId: "p", prompt: "hi", maxOutputTokens: 64_000 } as CompletionRequest,
    provider,
    entry,
    resolveModelPricingFor(resolved, "claude-haiku-4-5"),
  )!;
  return { budget, scope };
}

describe("snapshot-only pricing is an estimate, not admission pricing", () => {
  it("resolves the preset model from the snapshot under its own source", () => {
    const model = resolveModelPricingFor(resolved, "claude-haiku-4-5");
    expect(model?.source).toBe("snapshot");
    expect(model?.pricing).toMatchObject({ input: 1, output: 5 });
    expect(verifiedAdmissionPricing(model)).toBeUndefined();
    expect(linkSpendBilling(entry, verifiedAdmissionPricing(model))).toBe("billed");
  });

  it("keeps an Anthropic preset in meter mode under a $1 turn cap and never refuses it", () => {
    const { scope } = turn(1);
    const s = scope();
    expect(s.mode).toBe("meter");
    const body = { model: "claude-haiku-4-5", messages: [{ role: "user", content: huge }], max_tokens: 64_000 };
    expect(() => s.beforeSend(body)).not.toThrow();
    expect(body.max_tokens).toBe(64_000);
  });

  it("admits web_search_options and a non-base service_tier under the cap", () => {
    const { scope } = turn(1);
    const web = { model: "claude-haiku-4-5", messages: [], web_search_options: {} };
    expect(() => scope().beforeSend(web)).not.toThrow();
    const tier = { model: "claude-haiku-4-5", messages: [], service_tier: "on_demand" };
    expect(() => scope().beforeSend(tier)).not.toThrow();
  });

  it("meters a daily limit too: no refusal ahead of sending", () => {
    const store = new DailySpendStore({ path: join(mkdtempSync(join(tmpdir(), "snapshot-day-")), "daily-spend.json") });
    const daily = createDailySpendBudget(store, () => ({ dailyLimitUsd: 1 }));
    const s = createRequestBudgetScope(undefined, { prompt: "hi" } as CompletionRequest, provider, entry,
      resolveModelPricingFor(resolved, "claude-haiku-4-5"), daily)!;
    expect(() => s.beforeSend({ model: "claude-haiku-4-5", messages: [{ role: "user", content: huge }], web_search_options: {} })).not.toThrow();
    expect(s.hint).toMatch(/daily spend limit/);
  });

  it("still settles an estimate from the snapshot when the reply reports no cost", () => {
    const { budget, scope } = turn(10);
    const s = scope();
    s.beforeSend({ model: "claude-haiku-4-5", messages: [] });
    s.finish({ usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 } } as never);
    expect(budget.check("p", { usd: 0 })!.spentUsd).toBeCloseTo(1, 9);
  });

  it("counts the link as priced for the spend readout (the total is an estimate)", () => {
    expect(hasPricedCloudLink(resolved)).toBe(true);
  });
});
