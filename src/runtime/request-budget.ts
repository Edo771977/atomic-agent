import type { CompletionRequest, CompletionRequestBudget, CompletionResult } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import { completionCostUsd, reportedCostUsd } from "../llm/provider/usage-cost.js";
import type { FusionTurnBudget } from "../tools/fusion/turn-budget.js";

export interface RequestBudgetScope extends CompletionRequestBudget {
  signal?: AbortSignal;
  finish(result?: CompletionResult): void;
}

/** A scope survives retries; each physical send acquires a separate hold. */
export function createRequestBudgetScope(
  budget: FusionTurnBudget | undefined,
  request: CompletionRequest,
  provider: LlmProvider,
  entry: LlmProviderConfigEntry | undefined,
  model: ResolvedModel | undefined,
): RequestBudgetScope | undefined {
  const sessionId = request.budgetOwnerSessionId ?? request.sessionId;
  if (budget === undefined || sessionId === undefined) return undefined;
  const limits = budget.requestLimits(sessionId);
  if (limits === undefined) return undefined;
  // A loopback/private URL can be a forwarding gateway to a paid service.
  // Only an explicit runner/plan kind is free without configured zero rates.
  const unbilled = entry?.kind === "subscription-cli" || entry?.kind === "llama-server";
  const priceRequired = limits.usd !== undefined && !unbilled;
  const pricing = model?.pricing;
  if (priceRequired && (pricing === undefined || ![pricing.input, pricing.output, pricing.cacheWrite ?? 0, pricing.cacheRead ?? 0].every(rate => Number.isFinite(rate) && rate >= 0))) {
    throw new Error(`turn budget cannot verify pricing for paid provider ${provider.id}; configure model pricing before sending`);
  }
  if (priceRequired && provider.supportsRequestBudget !== true) throw new Error(`turn budget cannot authorize physical requests for provider ${provider.id}`);
  const caps = [request.maxTokens, request.maxOutputTokens, entry?.maxOutputTokens].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const outputCap = caps.length > 0 ? Math.min(...caps) : model?.source !== "default" ? model?.contextWindow : undefined;
  if (priceRequired && (outputCap === undefined || !Number.isFinite(outputCap) || outputCap <= 0)) throw new Error("turn budget needs a verified output ceiling before sending");
  const timeLeft = budget.requestTimeLeftMs(sessionId);
  if (timeLeft !== undefined && timeLeft <= 0) throw new Error("the turn time cap has been reached before this request");
  let held = !priceRequired && limits.usd !== undefined ? budget.reserveRequest(sessionId, 0) : undefined;
  const deadline = new AbortController();
  const signal = request.signal === undefined ? deadline.signal : AbortSignal.any([request.signal, deadline.signal]);
  const timer = timeLeft === undefined ? undefined : setTimeout(() => deadline.abort(new DOMException("the turn time cap stopped this request", "AbortError")), timeLeft);
  timer?.unref?.();
  let done = false;
  return {
    signal,
    beforeSend(body) {
      if (done) throw new Error("request budget scope is already closed");
      if (signal.aborted) throw signal.reason;
      if (!priceRequired) return;
      // A retry after an ambiguous dispatch can have been billed too.
      held?.settle();
      held = undefined;
      if (request.signal?.aborted) throw request.signal.reason;
      const wireCaps = [body.max_tokens, body.max_completion_tokens].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
      const ceiling = Math.floor(Math.min(outputCap!, ...wireCaps));
      // Runs after extraBody/model-parameter conversion, immediately before
      // serialization. Those overrides cannot raise this enforced ceiling.
      if (body.max_completion_tokens !== undefined) body.max_completion_tokens = ceiling;
      if (body.max_tokens !== undefined || body.max_completion_tokens === undefined) body.max_tokens = ceiling;
      // Every tokenizer emits at most one token per UTF-8 byte of text, so
      // the serialized body bounds the prompt; JSON keys/escaping and a fixed
      // framing allowance deliberately overestimate the server's template.
      // The context window is not a floor: it would reserve a full window
      // for every short request and starve parallel workers.
      const inputTokens = Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
      const inputRate = Math.max(pricing!.input, pricing!.cacheWrite ?? pricing!.input, pricing!.cacheRead ?? pricing!.input);
      const copies = [body.n, body.best_of].filter(value => value !== undefined);
      if (!copies.every(value => typeof value === "number" && Number.isInteger(value) && value > 0)) throw new Error("turn budget cannot verify the request's completion count");
      const outputCopies = Math.max(1, ...(copies as number[]));
      const upperUsd = ((inputTokens * inputRate + ceiling * pricing!.output) * outputCopies) / 1_000_000;
      held = budget.reserveRequest(sessionId, upperUsd);
    },
    onResponse(status) {
      // These statuses explicitly reject the request before generation.
      // 408/5xx/network deaths remain ambiguous and retain their bound.
      if ([400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(status)) {
        held?.release();
        held = undefined;
      }
    },
    finish(result) {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      const usage = result?.usage;
      held?.settle(usage === undefined ? (priceRequired ? undefined : 0) : reportedCostUsd(usage) ??
        (!priceRequired ? 0 : usage.incomplete === true ? undefined : completionCostUsd(usage, pricing)));
      held = undefined;
    },
  };
}
