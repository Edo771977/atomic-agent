import { afterEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../../config/index.js";
import { connectRuntimeFallback } from "./runtime-inference.js";
import { FusionTurnBudget } from "../../tools/fusion/turn-budget.js";
import { OpenAiProvider } from "../../llm/provider/openai/openai-provider.js";
import { ProviderFallbackChain, DEFAULT_FALLBACK_TIMING } from "../../llm/fallback/index.js";
import { DeferredLocalBackendProbes } from "../../llm/local-backend-gate.js";
import { TurnUsageMeter } from "../../analytics/turn-usage-meter.js";
import type { ResolvedModel } from "../../llm/provider/model-resolver.js";
import { createRequestBudgetScope } from "../request-budget.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/registry/provider-types.js";
import { summarizeWithModel } from "../context-compaction-model.js";
import { createCompactionDefaults } from "../../config/agent/compaction-config.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { createModelRiskReviewer } from "../../approval/risk-review.js";
import { createQueryRewriterRunner } from "../../memory/retrieve/query-rewriter-runner.js";
import { createAlwaysGate } from "../../memory/retrieve/rewriter-gate.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";

function jsonResponse(completionTokens = 3) {
  return new Response(JSON.stringify({ model: "priced", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: completionTokens, total_tokens: 1 + completionTokens } }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(options: { cap?: number; baseUrl?: string; unpriced?: boolean; inputRate?: number; outputRate?: number; fetch?: typeof fetch } = {}) {
  const cap = options.cap ?? 1;
  const config = configModule.loadConfig();
  const baseUrl = options.baseUrl ?? "https://paid.invalid";
  const entry: LlmProviderConfigEntry = { id: "cloud", kind: "openai-compatible", baseUrl, defaultChatModel: "priced", maxOutputTokens: 3 };
  const llm = { activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto" as const, providers: [entry], runMode: { mode: "fusion" as const, fusion: { turnBudgetUsd: cap } } };
  config.llm = llm;
  vi.spyOn(configModule, "getConfig").mockReturnValue(config);
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
    sent.push(JSON.parse(String(args[1]?.body)) as Record<string, unknown>);
    return options.fetch ? options.fetch(...args) : jsonResponse();
  });
  const provider = new OpenAiProvider({ id: "cloud", baseUrl, apiKey: "", defaultChatModel: "priced", maxOutputTokens: 3, extraBody: { max_tokens: 999 }, fetchImpl });
  const budget = new FusionTurnBudget();
  // Extra arguments are intentionally ignored by the original implementation.
  (budget.begin as (...args: unknown[]) => void)("parent", 0, { usd: cap });
  const meter = new TurnUsageMeter();
  meter.begin("parent");
  const pricing = options.unpriced ? undefined : { input: options.inputRate ?? 0, output: options.outputRate ?? 250_000 };
  const wired = connectRuntimeFallback({}, {
    fallbackChain: new ProviderFallbackChain({ resolve: () => ({ chain: ["cloud"], timing: DEFAULT_FALLBACK_TIMING }) }),
    resolveActiveLlmSlice: () => ({ provider, transport: "native_tools", adapter: provider.toolCallAdapter, slotAffinity: false, parallelTools: false, strictTools: false, isLlamaServer: false }),
    localBackend: new DeferredLocalBackendProbes({ isActive: () => false, restore: async () => {} }, false),
    profileManager: undefined, costAccumulator: undefined, turnUsageMeter: meter,
    resolveModelPricing: () => ({ id: "priced", contextWindow: 32000, source: "user", pricing } as ResolvedModel),
    ...{ turnBudget: budget },
  });
  const request = { prompt: "hello", grammar: 'root ::= "ok"', slotId: -1, sessionId: "parent", providerId: "cloud", maxOutputTokens: 3 };
  return { budget, wired, request, sent, fetchImpl, meter, config, llm, provider, pricing };
}

describe("physical completion reservations", () => {
  it.each([["unary", 400], ["unary", 502], ["stream", 400], ["stream", 502]] as const)("cancels a stalled %s error body after status %s at the turn deadline", async (mode, status) => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = new AbortController();
    const f = fixture({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller; controller.enqueue(new TextEncoder().encode('{"error":"denied"'));
    } }), { status }) });
    f.budget.begin("parent", 0, { usd: 1, timeMs: 20 });
    let settled = false;
    const pending = (mode === "unary" ? f.wired.llmComplete({ ...f.request, signal: cancel.signal }) : f.wired.llmCompleteStream!({ ...f.request, signal: cancel.signal }).next())
      .catch(error => error as Error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(21);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(Error);
      expect(f.sent).toHaveLength(1);
      if (status === 502) expect(f.budget.check("parent", { usd: 0.75 })).toMatchObject({ conservativeUsd: 0.75 });
    } finally {
      cancel.abort();
      try { body?.close(); } catch { /* already cancelled */ }
      await pending;
    }
  });

  it("bounds error diagnostics instead of draining an oversized response", async () => {
    let pulls = 0;
    const f = fixture({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulls <= 4) controller.enqueue(new TextEncoder().encode("x".repeat(65_536)));
      else controller.close();
    } }), { status: 400 }) });
    await expect(f.wired.llmComplete(f.request)).rejects.toBeInstanceOf(Error);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("cancels a stalled diagnostic body on an internal retry without losing the first dispatch charge", async () => {
    vi.useFakeTimers();
    let count = 0;
    const f = fixture({ cap: 3, fetch: async () => ++count === 1 ? new Response("retry", { status: 502 }) : new Response(new ReadableStream(), { status: 400 }) });
    f.budget.begin("parent", 0, { usd: 3, timeMs: 1000 });
    const pending = f.wired.llmComplete(f.request).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(2);
    expect(f.budget.check("parent", { usd: 0.75 })).toMatchObject({ conservativeUsd: 0.75 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["compaction", "risk", "rewriter"] as const)("charges foreground %s to its explicit owner while preserving the routing partition", async kind => {
    const f = fixture({ cap: 0.75 });
    f.budget.reserveRequest("parent", 0.75).settle(0.75);
    const partitions: string[] = [];
    const complete = async (params: LlmStreamParams) => { partitions.push(params.sessionId); return f.wired.llmComplete(params); };
    if (kind === "compaction") {
      const input: Parameters<typeof buildPrompt>[0] = { session: createEmptySessionState({ id: "parent", workingDir: "/fixture" }), profile: PLAIN_INSTRUCT_PROFILE, toolDescriptors: [], skillCatalog: [], contextWindow: 12000, conversationMaxTokens: 4000, conversationMaxPairs: 200,
        capabilities: { platform: "win32", arch: "x64", browserChannel: "chrome", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
      await summarizeWithModel({ input, prompt: buildPrompt(input), plan: { reason: "manual", from: 0, through: 0, summaryMaxTokens: 250, targetTokens: 2000, tokensBefore: 3000 },
        config: { ...createCompactionDefaults(), mode: "model" }, route: { providerId: "cloud", transport: "native_tools", serverTemplate: false, maxOutputTokens: 3 }, previous: "",
        source: { text: "old history", contextAt: () => "", maxContextTokens: 0 }, signal: new AbortController().signal,
        tally: { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, calls: 0, chunkCount: 0, totalTimeoutMs: 0 }, emit: () => {}, sideCallSlotId: () => -1, complete }).catch(() => undefined);
    } else if (kind === "risk") {
      const reviewer = createModelRiskReviewer({ enabled: () => true, providerId: () => "cloud", transport: () => "native_tools", complete });
      await reviewer.review({ request: { approvalId: "a", sessionId: "parent", tool: "os.shell.run", category: "shell", reason: "inspect files", preview: "ls" } });
    } else {
      const rewriter = createQueryRewriterRunner({ llmComplete: complete, timeoutMs: 1000, gate: createAlwaysGate() });
      await rewriter.maybeRewrite({ sessionId: "parent", userMessage: "what about that", history: [{ role: "user", text: "the project" }], signal: new AbortController().signal });
    }
    expect(partitions).toEqual([`${kind}:parent`]);
    expect(f.sent).toEqual([]);
  });

  it.each(["http://localhost:4000", "http://192.168.1.2:4000", "http://gateway:4000"])("does not infer free inference from compatible gateway %s", async baseUrl => {
    const f = fixture({ baseUrl, cap: 0.01, unpriced: true });
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/pric/i);
    expect(f.sent).toEqual([]);
  });

  it.each(["llama-server", "subscription-cli"])("counts reported dollar charges even from explicitly unbilled %s", async kind => {
    const f = fixture({ cap: 0.01, unpriced: true, fetch: async () => new Response(JSON.stringify({ model: "priced", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { cost: 5 } }), { headers: { "content-type": "application/json" } }) });
    f.llm.providers[0] = { ...f.llm.providers[0]!, kind };
    await f.wired.llmComplete(f.request);
    expect(f.budget.check("parent", { usd: 0.01 })).toMatchObject({ spentUsd: 5 });
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
    expect(f.sent).toHaveLength(1);
  });

  it.each(["unary", "stream"] as const)("keeps absent/incomplete %s usage conservative but trusts reported zero", async mode => {
    for (const usage of [undefined, { prompt_tokens: 0 }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, { cost: 0 }]) {
      const knownZero = usage !== undefined && ("completion_tokens" in usage || "cost" in usage);
      const f = fixture({ cap: 0.75, fetch: async () => {
        if (mode === "unary") return new Response(JSON.stringify({ model: "priced", choices: [{ message: { content: "done" }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) }), { headers: { "content-type": "application/json" } });
        return new Response(`data: ${JSON.stringify({ model: "priced", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      } });
      const call = async () => {
        if (mode === "unary") return f.wired.llmComplete(f.request);
        const stream = f.wired.llmCompleteStream!(f.request);
        for (;;) { const next = await stream.next(); if (next.done) return next.value; }
      };
      await call();
      if (knownZero) { await call(); expect(f.sent).toHaveLength(2); }
      else {
        await expect(call()).rejects.toThrow(/budget|cap/i);
        expect(f.sent).toHaveLength(1);
        expect(f.budget.check("parent", { usd: 0.75 })).toMatchObject({ conservativeUsd: 0.75 });
      }
      vi.restoreAllMocks();
    }
  });

  it("admits only one concurrent $0.75 request under a $1 turn cap", async () => {
    let release!: () => void;
    const latch = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ fetch: async () => { await latch; return jsonResponse(); } });
    const pending = Promise.allSettled([1, 2, 3, 4].map(() => f.wired.llmComplete(f.request)));
    await vi.waitFor(() => expect(f.sent.length).toBeGreaterThan(0));
    release();
    const results = await pending;
    expect(f.sent).toHaveLength(1);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.sent[0]?.max_tokens).toBe(3);
  });

  it("refuses paid requests without verified pricing before sending", async () => {
    const f = fixture({ unpriced: true });
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/pric/i);
    expect(f.sent).toEqual([]);
  });

  it("reserves final messages and tools without assuming a cache discount", async () => {
    const f = fixture({ inputRate: 1_000_000, outputRate: 0 });
    await expect(f.wired.llmComplete({ ...f.request, prompt: "x", tools: [{ type: "function", function: { name: "tool", description: "x".repeat(500) } }] })).rejects.toThrow(/budget|cap/i);
    expect(f.sent).toEqual([]);
  });

  it("retains an ambiguous dispatched failure's bound before allowing a retry", async () => {
    vi.useFakeTimers();
    const f = fixture({ fetch: async () => new Response("provider failed", { status: 502 }) });
    const pending = f.wired.llmComplete(f.request).catch(error => error as Error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1);
  });

  it("releases a definite rejected request so its retry may run", async () => {
    vi.useFakeTimers();
    let count = 0;
    const f = fixture({ fetch: async () => ++count === 1 ? new Response("rate limited", { status: 429 }) : jsonResponse() });
    const pending = f.wired.llmComplete(f.request);
    await vi.runAllTimersAsync();
    await pending;
    expect(f.sent).toHaveLength(2);
    expect(f.sent.every(body => body.max_tokens === 3)).toBe(true);
  });

  it("adds carried spend and new tracked calls without double charging their usage callbacks", async () => {
    const f = fixture({ cap: 13, outputRate: 1_000_000 });
    f.budget.addWorkerSpend("parent", 10);
    await f.wired.llmComplete(f.request);
    // Existing worker usage hooks still update their display counter.
    (f.budget.addWorkerSpend as (...args: unknown[]) => void)("parent", 3, true);
    expect(f.budget.check("parent", { usd: 13 }, f.meter.peekCostUsd("parent"))).toMatchObject({ spentUsd: 13 });
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
    expect(f.sent).toHaveLength(1);
  });

  it("shares the parent allowance with bound workers and clears the binding", async () => {
    const f = fixture();
    f.budget.bindSession("s-w-child", "parent");
    await f.wired.llmComplete({ ...f.request, sessionId: "s-w-child" });
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
    f.budget.unbindSession("s-w-child");
    expect(f.budget.requestLimits("s-w-child")).toBeUndefined();
    expect(f.sent).toHaveLength(1);
  });

  it("counts mixed planner, worker, judge and escalation calls plus carried spend exactly once", async () => {
    const f = fixture({ cap: 8 });
    f.budget.addWorkerSpend("parent", 5);
    await f.wired.llmComplete(f.request);
    f.budget.bindSession("s-w-child", "parent");
    await f.wired.llmComplete({ ...f.request, sessionId: "s-w-child" });
    f.budget.addWorkerSpend("parent", 0.75, true);
    f.budget.unbindSession("s-w-child");
    for (const prompt of ["judge", "escalate"]) {
      const request = { prompt, sessionId: "parent", maxOutputTokens: 3 };
      const scope = createRequestBudgetScope(f.budget, request, f.provider, f.llm.providers[0],
        { id: "priced", contextWindow: 32000, source: "user", pricing: f.pricing } as ResolvedModel)!;
      let result;
      try { result = await f.provider.complete({ ...request, requestBudget: scope, signal: scope.signal }); }
      finally { scope.finish(result); }
      f.budget.addWorkerSpend("parent", 0.75, true);
    }
    expect(f.budget.check("parent", { usd: 8 }, f.meter.peekCostUsd("parent"))).toMatchObject({ spentUsd: 8 });
    expect(f.sent).toHaveLength(4);
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
  });

  it("does not let an old worker bind to a new parent turn", async () => {
    const f = fixture();
    f.budget.bindSession("s-w-child", "parent");
    f.budget.begin("parent", 0, { usd: 1 });
    await expect(f.wired.llmComplete({ ...f.request, sessionId: "s-w-child" })).rejects.toThrow(/turn.*ended/i);
    expect(f.sent).toEqual([]);
    f.budget.unbindSession("s-w-child");
  });

  it("deactivates policy after the parent turn while retaining its settled receipt", async () => {
    const f = fixture({ cap: 0.75 });
    await f.wired.llmComplete(f.request);
    f.budget.bindSession("s-w-child", "parent");
    f.budget.end("parent");
    expect(f.budget.requestLimits("parent")).toBeUndefined();
    expect(f.budget.check("parent", { usd: 0.75 })).toMatchObject({ spentUsd: 0.75 });
    expect(() => f.budget.requestLimits("s-w-child")).toThrow(/turn.*ended/);
    f.budget.unbindSession("s-w-child");
    await f.wired.llmComplete(f.request);
    expect(f.sent).toHaveLength(2);
  });

  it("enforces the turn deadline during an ordinary unary planner request", async () => {
    vi.useFakeTimers();
    const f = fixture({ fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
    f.budget.begin("parent", 0, { timeMs: 100 });
    const pending = f.wired.llmComplete(f.request).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the owner's deadline on an independently partitioned foreground request", async () => {
    vi.useFakeTimers();
    const f = fixture({ fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
    f.budget.begin("parent", 0, { timeMs: 20 });
    const pending = f.wired.llmComplete({ ...f.request, sessionId: "independent-partition", budgetOwnerSessionId: "parent" }).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).not.toHaveProperty("budgetOwnerSessionId");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the turn deadline during a live ordinary planner stream", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const f = fixture({ fetch: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: "priced", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } }) });
    f.budget.begin("parent", 0, { timeMs: 100 });
    const stream = f.wired.llmCompleteStream!(f.request);
    await stream.next();
    const pending = stream.next().catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a cancelled dispatched request's bound and releases its hold", async () => {
    const f = fixture({ fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
    const cancel = new AbortController();
    const pending = f.wired.llmComplete({ ...f.request, signal: cancel.signal }).catch(error => error as Error);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    cancel.abort(new DOMException("cancelled", "AbortError"));
    expect(await pending).toBeInstanceOf(Error);
    expect(f.budget.check("parent", { usd: 0.75 })).toMatchObject({ spentUsd: 0.75, conservativeUsd: 0.75 });
    const remaining = f.budget.reserveRequest("parent", 0.25);
    remaining.release();
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
    expect(f.sent).toHaveLength(1);
  });

  function sseResponse() {
    const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    return new Response(frame({ model: "priced", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }) +
      frame({ model: "priced", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
  }

  it("settles a streamed completion once and returns its unused allowance", async () => {
    const f = fixture({ fetch: async (_url, init) => JSON.parse(String(init?.body)).stream ? sseResponse() : jsonResponse(1) });
    const stream = f.wired.llmCompleteStream!(f.request);
    for (;;) if ((await stream.next()).done) break;
    await f.wired.llmComplete(f.request);
    expect(f.sent).toHaveLength(2);
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
  });

  it("keeps the conservative charge when a live stream is abandoned", async () => {
    const f = fixture({ fetch: async () => sseResponse() });
    const stream = f.wired.llmCompleteStream!(f.request);
    await stream.next();
    await stream.return({} as never);
    expect(f.budget.check("parent", { usd: 0.75 })).toMatchObject({ conservativeUsd: 0.75 });
    await expect(f.wired.llmComplete(f.request)).rejects.toThrow(/budget|cap/i);
    expect(f.sent).toHaveLength(1);
  });

  it("reserves the actual fallback provider's price after a definite primary rejection", async () => {
    const f = fixture({ cap: 2, fetch: async () => new Response("invalid credentials", { status: 403 }) });
    let backupCalls = 0;
    const backup = new OpenAiProvider({ id: "backup", baseUrl: "https://backup.invalid", apiKey: "", defaultChatModel: "priced", maxOutputTokens: 3,
      fetchImpl: async () => { backupCalls++; return jsonResponse(); } });
    f.llm.providers.push({ id: "backup", kind: "openai-compatible", baseUrl: "https://backup.invalid", defaultChatModel: "priced", maxOutputTokens: 3 });
    const wired = connectRuntimeFallback({}, {
      fallbackChain: new ProviderFallbackChain({ resolve: () => ({ chain: ["cloud", "backup"], timing: DEFAULT_FALLBACK_TIMING }) }),
      resolveActiveLlmSlice: id => ({ provider: id === "backup" ? backup : f.provider, transport: "native_tools", adapter: f.provider.toolCallAdapter, slotAffinity: false, parallelTools: false, strictTools: false, isLlamaServer: false }),
      localBackend: new DeferredLocalBackendProbes({ isActive: () => false, restore: async () => {} }, false),
      profileManager: undefined, costAccumulator: undefined, turnUsageMeter: f.meter, turnBudget: f.budget,
      resolveModelPricing: (_model, id) => ({ id: "priced", contextWindow: 32000, source: "user", pricing: { input: 0, output: id === "backup" ? 500_000 : 250_000 } } as ResolvedModel),
    });
    await wired.llmComplete({ ...f.request, providerId: undefined });
    expect(backupCalls).toBe(1);
    expect(f.budget.check("parent", { usd: 1.5 })).toMatchObject({ spentUsd: 1.5 });
    await expect(wired.llmComplete({ ...f.request, providerId: "backup" })).rejects.toThrow(/budget|cap/i);
    expect(backupCalls).toBe(1);
  });

  it("rejects a priced adapter that cannot authorize each physical send", () => {
    const f = fixture();
    const adapter = Object.create(f.provider) as OpenAiProvider;
    Object.defineProperty(adapter, "supportsRequestBudget", { value: false });
    expect(() => createRequestBudgetScope(f.budget, f.request, adapter, f.llm.providers[0],
      { id: "priced", source: "user", contextWindow: 32000, pricing: f.pricing } as ResolvedModel)).toThrow(/physical requests/);
    expect(f.sent).toEqual([]);
  });

  it("keeps subscription requests unpriced while still metering their tokens", async () => {
    const f = fixture();
    f.llm.providers[0] = { id: "cloud", kind: "subscription-cli" };
    await f.wired.llmComplete(f.request);
    expect(f.meter.snapshot("parent")).toMatchObject({ completionTokens: 3 });
    expect(f.budget.check("parent", { usd: 0.5 })).toBeUndefined();
    expect(f.sent[0]?.max_tokens).toBe(999);
  });

  it("keeps the absent-budget request shape unchanged", async () => {
    const f = fixture();
    f.budget.begin("parent");
    await f.wired.llmComplete(f.request);
    expect(f.sent[0]?.max_tokens).toBe(999);
  });
});
