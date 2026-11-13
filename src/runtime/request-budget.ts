import type { CompletionRequest, CompletionRequestBudget, CompletionResult, CompletionUsage } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import { completionCostUsd, longContextRates, reportedCostUsd } from "../llm/provider/usage-cost.js";
import { readErrnoCode } from "../llm/errno-code.js";
import { modelParamProfile } from "../llm/provider/openai/model-params.js";
import type { FusionTurnBudget } from "../tools/fusion/turn-budget.js";

// Explicit rejections before generation. 529 is Anthropic's overload answer
// returned instead of generating. 503 stays charged like 500/502/504:
// proxies (Envoy "upstream reset before headers", Heroku H12) return it after
// the request was delivered and generation was billed.
const RELEASED_STATUSES = new Set([400, 401, 402, 403, 404, 405, 413, 415, 422, 429, 529]);
// Failures before a connection exists (refused, unresolved, no route, no
// usable local address): no request byte reached a server. A reset,
// timeout or TLS/socket error can follow a delivered body and stays charged.
const UNSENT_ERRNOS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

/**
 * True when the provider can add prompt input the serialized body does not
 * contain: OpenRouter `plugins` (e.g. web) or `:online` models, OpenAI
 * `web_search_options`, or any tool that is not a client-side function.
 */
function addsProviderSideInput(body: Record<string, unknown>): boolean {
  const plugins = body.plugins;
  if (plugins !== undefined && plugins !== null && !(Array.isArray(plugins) && plugins.length === 0)) return true;
  if (typeof body.model === "string" && body.model.endsWith(":online")) return true;
  if (body.web_search_options !== undefined && body.web_search_options !== null) return true;
  const tools = body.tools;
  if (tools === undefined || tools === null) return false;
  if (!Array.isArray(tools)) return true;
  return tools.some(tool => typeof tool !== "object" || tool === null || (tool as { type?: unknown }).type !== "function");
}

type ModelPricing = NonNullable<ResolvedModel["pricing"]>;

/** Tiers billed at the configured base rates. */
const BASE_SERVICE_TIERS = new Set(["default", "auto"]);

function validRate(rate: unknown): boolean {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
}

/** Every rate the reservation or settlement may read is finite and >= 0. */
function verifiablePricing(pricing: ModelPricing | undefined): pricing is ModelPricing {
  if (pricing === undefined) return false;
  if (![pricing.input, pricing.output, pricing.cacheWrite ?? 0, pricing.cacheRead ?? 0].every(validRate)) return false;
  const long = pricing.longContext;
  if (long !== undefined && !(typeof long.thresholdTokens === "number" && long.thresholdTokens > 0 && [long.input, long.output, long.cacheWrite ?? 0, long.cacheRead ?? 0].every(validRate))) return false;
  const tiers = pricing.serviceTierMultipliers;
  return tiers === undefined || Object.values(tiers).every(validRate);
}

/**
 * Price multiplier of the body's `service_tier`. Absent, `null`,
 * `default` and `auto` are the base rates; any other tier (OpenAI
 * `priority` bills about 2x) needs a configured multiplier, so an
 * unknown modifier refuses instead of being under-reserved.
 */
function serviceTierMultiplier(body: Record<string, unknown>, pricing: ModelPricing): number {
  const tier = body.service_tier;
  if (tier === undefined || tier === null) return 1;
  if (typeof tier === "string" && BASE_SERVICE_TIERS.has(tier)) return 1;
  const tiers = pricing.serviceTierMultipliers;
  if (typeof tier === "string" && tiers !== undefined && Object.hasOwn(tiers, tier)) return tiers[tier]!;
  throw new Error(`turn budget cannot price service_tier ${JSON.stringify(tier)}; declare it in the model's pricing.serviceTierMultipliers or remove it`);
}

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
  if (priceRequired && !verifiablePricing(pricing)) {
    throw new Error(`turn budget cannot verify pricing for paid provider ${provider.id}; configure model pricing before sending`);
  }
  if (priceRequired && provider.supportsRequestBudget !== true) throw new Error(`turn budget cannot authorize physical requests for provider ${provider.id}`);
  const caps = [request.maxTokens, request.maxOutputTokens, entry?.maxOutputTokens].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  // No context-window fallback: providers reject a window-sized output
  // limit, and reserving one would hold dollars per request.
  const outputCap = caps.length > 0 ? Math.min(...caps) : undefined;
  const timeLeft = budget.requestTimeLeftMs(sessionId);
  if (timeLeft !== undefined && timeLeft <= 0) throw new Error("the turn time cap has been reached before this request");
  let held = !priceRequired && limits.usd !== undefined ? budget.reserveRequest(sessionId, 0) : undefined;
  const deadline = new AbortController();
  const signal = request.signal === undefined ? deadline.signal : AbortSignal.any([request.signal, deadline.signal]);
  const timer = timeLeft === undefined ? undefined : setTimeout(() => deadline.abort(new DOMException("the turn time cap stopped this request", "AbortError")), timeLeft);
  timer?.unref?.();
  let done = false;
  // Multiplier of the most recent physical send; settlement prices usage with it.
  let tierMultiplier = 1;
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
      const explicitCaps = outputCap === undefined ? wireCaps : [outputCap, ...wireCaps];
      if (explicitCaps.length === 0) {
        throw new Error(`turn budget needs a verified output ceiling before sending; set \`maxOutputTokens\` on provider entry ${entry?.id ?? provider.id}`);
      }
      const ceiling = Math.floor(Math.min(...explicitCaps));
      // Runs after extraBody/model-parameter conversion, immediately before
      // serialization. Those overrides cannot raise this enforced ceiling.
      // Clamp the field(s) the body already uses. With neither, write the
      // field the wire model's profile expects: OpenAI reasoning models
      // reject `max_tokens`.
      const present = (["max_tokens", "max_completion_tokens"] as const).filter(field => body[field] !== undefined);
      const fields = present.length > 0 ? present : [typeof body.model === "string" ? modelParamProfile(body.model).capField : "max_tokens"];
      for (const field of fields) body[field] = ceiling;
      // Every tokenizer emits at most one token per UTF-8 byte of text, so
      // the serialized body bounds the prompt; JSON keys/escaping and a fixed
      // framing allowance deliberately overestimate the server's template.
      // The context window is not a floor for ordinary bodies: it would
      // reserve a full window for every short request and starve parallel
      // workers. It is the floor when the provider adds input of its own
      // (web search results, server tools) that the body cannot bound.
      const bodyTokens = Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
      let inputTokens = bodyTokens;
      if (addsProviderSideInput(body)) {
        if (model?.source === "default" || !Number.isFinite(model?.contextWindow) || model!.contextWindow <= 0) {
          throw new Error("turn budget cannot bound provider-side input (web search plugins or server tools) without a verified model context window");
        }
        inputTokens = Math.max(bodyTokens, model!.contextWindow);
      }
      const multiplier = serviceTierMultiplier(body, pricing!);
      // The bound can cross a long-context threshold the real prompt does
      // not: reserving the higher tier then only overestimates.
      const long = pricing!.longContext !== undefined && inputTokens > pricing!.longContext.thresholdTokens ? longContextRates(pricing!) : undefined;
      const inputRates = [pricing!.input, pricing!.cacheWrite ?? pricing!.input, pricing!.cacheRead ?? pricing!.input];
      // Missing long cache rates are derived exactly as settlement derives them.
      if (long !== undefined) inputRates.push(long.input, long.cacheWrite, long.cacheRead);
      const inputRate = Math.max(...inputRates);
      const outputRate = long === undefined ? pricing!.output : Math.max(pricing!.output, long.output);
      const copies = [body.n, body.best_of].filter(value => value !== undefined);
      if (!copies.every(value => typeof value === "number" && Number.isInteger(value) && value > 0)) throw new Error("turn budget cannot verify the request's completion count");
      const outputCopies = Math.max(1, ...(copies as number[]));
      const upperUsd = ((inputTokens * inputRate + ceiling * outputRate) * outputCopies * multiplier) / 1_000_000;
      held = budget.reserveRequest(sessionId, upperUsd);
      tierMultiplier = multiplier;
    },
    onResponse(status) {
      // 408, other 5xx and network deaths remain ambiguous and retain their bound.
      if (RELEASED_STATUSES.has(status)) {
        held?.release();
        held = undefined;
      }
    },
    onSendFailed(error) {
      const code = readErrnoCode(error);
      if (code !== undefined && UNSENT_ERRNOS.has(code)) {
        held?.release();
        held = undefined;
      }
    },
    finish(result) {
      // Reported cost has already won above; only the estimate takes the tier.
      const estimatedCostUsd = (usage: CompletionUsage): number | undefined => {
        const usd = completionCostUsd(usage, pricing);
        return usd === undefined ? undefined : usd * tierMultiplier;
      };
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      const usage = result?.usage;
      held?.settle(usage === undefined ? (priceRequired ? undefined : 0) : reportedCostUsd(usage) ??
        (!priceRequired ? 0 : usage.incomplete === true ? undefined : estimatedCostUsd(usage)));
      held = undefined;
    },
  };
}
