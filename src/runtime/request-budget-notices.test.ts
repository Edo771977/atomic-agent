import { describe, expect, it } from "vitest";
import { RequestBudgetNotices } from "./request-budget-notices.js";
import { createRequestBudgetScope } from "./request-budget.js";
import { createDailySpendBudget } from "./daily-spend-budget.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import type { DailySpendStore } from "../session/daily-spend.js";
import { createFallbackCompleter, createFallbackStreamer } from "./llm-fallback-seam.js";
import { ProviderFallbackChain, DEFAULT_FALLBACK_TIMING } from "../llm/fallback/index.js";
import { fakeProvider, fakeAnswer } from "../llm/provider/fake-provider.fixture.js";

const provider = { id: "cloud", supportsRequestBudget: true } as LlmProvider;
const model = { id: "m", source: "user", contextWindow: 32_000, pricing: { input: 1, output: 3 } } as ResolvedModel;
const entry = { id: "cloud", kind: "openai-compatible" as const, baseUrl: "https://paid.invalid" };
const body = () => ({ model: "m", messages: [{ role: "user", content: "hi" }] });

function fixture() {
  const events: Array<{ sessionId: string; event: AgentLoopEvent }> = [];
  const reporter = new RequestBudgetNotices((sessionId, event) => { events.push({ sessionId, event }); });
  const daily = createDailySpendBudget({ today: () => ({ usd: 0 }), add: () => {} } as unknown as DailySpendStore, () => ({ dailyLimitUsd: 1 }));
  const scope = (sessionId: string, priced: ResolvedModel = model) => createRequestBudgetScope(undefined, { sessionId, prompt: "hi" }, provider, entry, priced, daily)!;
  return { events, reporter, scope, daily };
}

describe("request budget notices", () => {
  it.each([false, true])("observes final-body hints before a unary/streaming provider sends (%s)", async stream => {
    const f = fixture();
    const close = f.reporter.begin("chat");
    const base = fakeProvider("cloud", "native_tools", async request => {
      request.requestBudget?.beforeSend(body());
      expect(f.events).toHaveLength(1);
      return fakeAnswer("cloud");
    });
    const serving = { ...base, supportsRequestBudget: true };
    const deps = { fallbackChain: new ProviderFallbackChain({ resolve: () => ({ chain: ["cloud"], timing: DEFAULT_FALLBACK_TIMING }) }),
      resolveSlice: () => ({ provider: serving, transport: "native_tools" as const }),
      requestBudget: (id: string, request: Parameters<typeof createRequestBudgetScope>[1]) => f.reporter.observeScope(id, request,
        createRequestBudgetScope(undefined, request, serving, entry, model, f.daily)),
      recordUnaryUsage: () => {}, recordStreamUsage: () => {} };
    const request = { sessionId: "chat", prompt: "hi", slotId: -1, grammar: 'root ::= "ok"' };
    if (stream) { for await (const _chunk of createFallbackStreamer(deps)(request)) { /* drain */ } }
    else await createFallbackCompleter(deps)(request);
    expect(f.events).toHaveLength(1);
    close();
  });

  it("reports the final output clamp and keeps a hard affordable request silent", () => {
    const f = fixture();
    const close = f.reporter.begin("chat");
    const expensive = { ...model, pricing: { input: 0, output: 500 } };
    const request = { sessionId: "chat", prompt: "hi", maxOutputTokens: 4096 };
    const scope = f.reporter.observeScope("cloud", request, createRequestBudgetScope(undefined, request, provider, entry, expensive, f.daily))!;
    const wire = { ...body(), max_tokens: 4096 };
    scope.beforeSend(wire);
    expect(wire.max_tokens).toBe(2000);
    expect(f.events[0]?.event).toMatchObject({ reason: "clamp", text: expect.stringContaining("reply capped at 2000") });
    scope.onResponse(429); scope.finish();
    close();
    const closeNext = f.reporter.begin("chat");
    const hard = f.reporter.observeScope("cloud", request, createRequestBudgetScope(undefined, request, provider, entry, model, f.daily))!;
    hard.beforeSend({ ...body(), max_tokens: 4096 }); hard.onResponse(429); hard.finish();
    expect(f.events).toHaveLength(1);
    closeNext();
  });
  it("reports a soft ceiling before sending and only once per provider/turn despite retries", () => {
    const f = fixture();
    const close = f.reporter.begin("chat");
    const scope = f.reporter.observeScope("cloud", { sessionId: "chat", prompt: "hi" }, f.scope("chat"))!;
    expect(f.events).toEqual([]); // the final wire body decides soft versus hard
    scope.beforeSend(body());
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ sessionId: "chat", event: { type: "budget_notice", sessionId: "chat", providerId: "cloud", reason: "soft", text: expect.stringContaining("no maxOutputTokens") } });
    scope.onResponse(429);
    scope.beforeSend(body());
    expect(f.events).toHaveLength(1);
    scope.finish();
    close();
  });

  it("reports metered unknown prices immediately without claiming a hard cap", () => {
    const f = fixture();
    const close = f.reporter.begin("chat");
    const scope = f.reporter.observeScope("cloud", { sessionId: "chat", prompt: "hi" }, f.scope("chat", { ...model, pricing: undefined }))!;
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.event).toMatchObject({ reason: "meter", text: expect.stringContaining("no verified pricing") });
    scope.finish(); close();
  });

  it("uses the explicit budget owner rather than the subcall's routing partition", () => {
    const f = fixture();
    const close = f.reporter.begin("chat");
    const request = { sessionId: "risk:chat", budgetOwnerSessionId: "chat", prompt: "hi" };
    const scope = f.reporter.observeScope("cloud", request, f.scope("risk:chat"))!;
    scope.beforeSend(body());
    expect(f.events.map(event => event.sessionId)).toEqual(["chat"]);
    scope.finish(); close();
  });

  it("routes workers to their captured parent and keeps concurrent chats separate", () => {
    const f = fixture();
    const closeA = f.reporter.begin("a"), closeB = f.reporter.begin("b");
    const unbind = f.reporter.bind("worker", "a");
    for (const sessionId of ["worker", "b"]) {
      const scope = f.reporter.observeScope("cloud", { sessionId, prompt: "hi" }, f.scope(sessionId))!;
      scope.beforeSend(body()); scope.finish();
    }
    expect(f.events.map(event => event.sessionId)).toEqual(["a", "b"]);
    unbind(); closeA(); closeB();
  });

  it("drops a late scope from a closed generation and permits the next turn's notice", () => {
    const f = fixture();
    const closeOld = f.reporter.begin("chat");
    const stale = f.reporter.observeScope("cloud", { sessionId: "chat", prompt: "hi" }, f.scope("chat"))!;
    closeOld();
    const closeNew = f.reporter.begin("chat");
    // A stale cleanup cannot close the replacement generation either.
    closeOld();
    stale.beforeSend(body()); stale.finish();
    expect(f.events).toEqual([]);
    const fresh = f.reporter.observeScope("cloud", { sessionId: "chat", prompt: "hi" }, f.scope("chat"))!;
    fresh.beforeSend(body()); fresh.finish();
    expect(f.events).toHaveLength(1);
    closeNew();
  });

  it("keeps independent background requests out of the selected chat", () => {
    const f = fixture();
    const close = f.reporter.begin("chat");
    const scope = f.reporter.observeScope("cloud", { sessionId: "naming:chat", prompt: "hi" }, f.scope("naming:chat"))!;
    scope.beforeSend(body()); scope.finish();
    expect(f.events).toEqual([]);
    close();
  });

  it("isolates renderer exceptions from admission and releases reservations normally", () => {
    const daily = createDailySpendBudget({ today: () => ({ usd: 0 }), add: () => {} } as unknown as DailySpendStore, () => ({ dailyLimitUsd: 1 }));
    const reporter = new RequestBudgetNotices(() => { throw new Error("renderer failed"); });
    const close = reporter.begin("chat");
    const scope = reporter.observeScope("cloud", { sessionId: "chat", prompt: "hi" }, createRequestBudgetScope(undefined, { sessionId: "chat", prompt: "hi" }, provider, entry, model, daily))!;
    expect(() => scope.beforeSend(body())).not.toThrow();
    expect(daily.remainingUsd()).toBeLessThan(1);
    scope.onResponse(429); scope.finish();
    expect(daily.remainingUsd()).toBe(1);
    close();
  });
});
