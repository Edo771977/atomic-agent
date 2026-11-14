import { describe, expect, it } from "vitest";
import { createDailySpendBudget } from "./daily-spend-budget.js";
import { createRequestBudgetScope } from "./request-budget.js";
import { createFallbackCompleter, createFallbackStreamer } from "./llm-fallback-seam.js";
import { ProviderFallbackChain } from "../llm/fallback/provider-fallback-chain.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import { DailySpendLimitError } from "../llm/reliability/spend-limit-error.js";
import { fakeAnswer, fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import type { DailySpendStore } from "../session/daily-spend.js";
import { FusionTurnBudget } from "../tools/fusion/turn-budget.js";
import { falloverCause } from "../llm/fallback/link-failure-kind.js";
import { formatProviderFalloverNotice } from "../tui/format-provider-fallover.js";
import { classifyFailureCause } from "../llm/reliability/classify-failure-cause.js";
import { falloverSentence } from "../llm/fallback/fallover-sentence.js";

function fixture(spent = 0.99, onLimit: "stop" | "local" = "stop", turnCap?: number) {
  const seen: string[] = [];
  const sent: string[] = [];
  let usd = spent;
  const store = { today: () => ({ usd }), add: (cost: number | undefined) => { usd += cost ?? 0; } } as unknown as DailySpendStore;
  const daily = createDailySpendBudget(store, () => ({ dailyLimitUsd: 1, onDailyLimit: onLimit }));
  const budget = new FusionTurnBudget();
  if (turnCap !== undefined) budget.begin("session", 0, { usd: turnCap });
  const chain = new ProviderFallbackChain({ resolve: () => ({ chain: ["configured", "cheap"], timing: { ...DEFAULT_FALLBACK_TIMING, failureThreshold: 1, probeThrottleMs: 0 } }) });
  chain.setTurnPrimary("session", "expensive");
  const providers = new Map(["expensive", "configured", "cheap"].map(id => {
    const provider = fakeProvider(id, "native_tools", async request => {
      request.requestBudget?.beforeSend({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 4096 });
      sent.push(id);
      return { ...fakeAnswer(id), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    return [id, { ...provider, supportsRequestBudget: true }] as const;
  }));
  const deps = {
    fallbackChain: chain,
    resolveSlice: (id: string) => { seen.push(id); return { provider: providers.get(id)!, transport: "native_tools" as const }; },
    requestBudget: (id: string, request: Parameters<typeof createRequestBudgetScope>[1], provider: Parameters<typeof createRequestBudgetScope>[2]) => {
      const rate = id === "cheap" ? 0.01 : 30;
      return createRequestBudgetScope(turnCap === undefined ? undefined : budget, request, provider,
        { id, kind: "openai-compatible", baseUrl: "https://paid.invalid", maxOutputTokens: 4096 } as LlmProviderConfigEntry,
        { id: "m", source: "user", contextWindow: 200_000, pricing: { input: rate / 3, output: rate } } as ResolvedModel, daily);
    },
    recordUnaryUsage: () => {}, recordStreamUsage: () => {},
  };
  return { deps, seen, sent, daily, chain, budget, usd: () => usd };
}

const request = { sessionId: "session", prompt: "hi", grammar: 'root ::= "ok"', slotId: -1 };

describe("a routed request that cannot fit today's remaining allowance", () => {
  it.each([false, true])("tries only configured links until an affordable one answers (stream=%s)", async stream => {
    const f = fixture();
    if (stream) { for await (const _chunk of createFallbackStreamer(f.deps)(request)) { /* drain */ } }
    else await createFallbackCompleter(f.deps)(request);
    expect(f.seen).toEqual(["expensive", "configured", "cheap"]);
    expect(f.sent).toEqual(["cheap"]);
    expect(f.usd()).toBeLessThan(1);
    expect(f.daily.remainingUsd()).toBeGreaterThan(0);
  });

  it("still stops with no physical sends when today's allowance is exhausted", async () => {
    const f = fixture(1);
    await expect(createFallbackCompleter(f.deps)(request)).rejects.toBeInstanceOf(DailySpendLimitError);
    expect(f.seen).toEqual(["expensive"]);
    expect(f.sent).toEqual([]);
  });

  it("never falls over an explicitly pinned request", async () => {
    const f = fixture();
    await expect(createFallbackCompleter(f.deps)({ ...request, providerId: "expensive" })).rejects.toMatchObject({ wouldExceed: true });
    expect(f.seen).toEqual(["expensive"]);
    expect(f.sent).toEqual([]);
    expect(f.chain.activeOverrideFor("session")).toBeNull();
  });

  it("keeps the budget refusal when every configured link is unaffordable and consumes nothing", async () => {
    const f = fixture(0.999999);
    await expect(createFallbackCompleter(f.deps)(request)).rejects.toMatchObject({ providerId: "expensive", wouldExceed: true });
    expect(f.seen).toEqual(["expensive", "configured", "cheap"]);
    expect(f.sent).toEqual([]);
    expect(f.usd()).toBe(0.999999);
    expect(f.daily.remainingUsd()).toBeCloseTo(0.000001, 9);
  });

  it("does not interpret caller cancellation as permission to try another provider", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(createFallbackCompleter(f.deps)({ ...request, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.seen).toEqual(["expensive"]);
    expect(f.sent).toEqual([]);
    expect(f.usd()).toBe(0.99);
    expect(f.chain.activeOverrideFor("session")).toBeNull();
  });

  it("does not circumvent a turn allowance while seeking a cheaper daily link", async () => {
    const f = fixture(0.99, "stop", 0.000001);
    await expect(createFallbackCompleter(f.deps)(request)).rejects.toThrow(/turn budget cannot cover/);
    expect(f.seen).toEqual(["expensive"]);
    expect(f.sent).toEqual([]);
    expect(f.usd()).toBe(0.99);
  });

  it("does not arm a provider cooldown for an administrative budget refusal", () => {
    const f = fixture();
    const refusal = new DailySpendLimitError({ spentUsd: 0.99, limitUsd: 1, providerId: "expensive", onLimit: "local", wouldExceed: true });
    expect(f.chain.advanceFrom("expensive", refusal, "session")).toBe("configured");
    f.chain.recordSuccess("configured", false, "session");
    // threshold=1 would immediately quarantine a real provider failure.
    expect(f.chain.pickProvider("session")).toEqual({ providerId: "expensive", isProbe: true });
  });

  it("describes an unaffordable request without claiming the entire day or cloud is blocked", () => {
    const refusal = new DailySpendLimitError({ spentUsd: 0.99, limitUsd: 1, providerId: "expensive", onLimit: "stop", wouldExceed: true });
    const cause = falloverCause(refusal);
    expect(cause).toBe("spend-allowance");
    const failure = classifyFailureCause(refusal).cause;
    expect(failure).toBe("daily_allowance_insufficient");
    const text = formatProviderFalloverNotice("expensive", "cheap", refusal.message, cause, falloverSentence("expensive", "cheap", failure));
    expect(text).toContain("remaining daily allowance");
    expect(text).not.toMatch(/until tomorrow|is "local"|recovers/);
  });
});
