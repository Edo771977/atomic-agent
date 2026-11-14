import type { CompletionRequest, CompletionRequestBudget, CompletionResult, CompletionUsage } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import { completionCostUsd, longContextRates, reportedCostUsd } from "../llm/provider/usage-cost.js";
import { readErrnoCode } from "../llm/errno-code.js";
import { modelParamProfile } from "../llm/provider/openai/model-params.js";
import { formatUsd, type FusionTurnBudget } from "../tools/fusion/turn-budget.js";

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

/**
 * Tiers the configured base rates bound from above, lower-cased: the
 * standard tier under its OpenAI (`default`) and Anthropic (`standard`,
 * `standard_only`) names, the request-side `auto`, and the cheaper
 * OpenAI `flex`.
 */
const BASE_SERVICE_TIERS = new Set(["default", "auto", "standard", "standard_only", "flex"]);

/** The configured multiplier for `tier`, matched without regard to case. */
function configuredTierMultiplier(tier: string, pricing: ModelPricing): number | undefined {
  const tiers = pricing.serviceTierMultipliers;
  if (tiers === undefined) return undefined;
  const wanted = tier.toLowerCase();
  for (const [name, multiplier] of Object.entries(tiers)) {
    if (name.toLowerCase() === wanted) return multiplier;
  }
  return undefined;
}

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
 * Price multiplier of the body's `service_tier`, matched without regard
 * to case. A configured multiplier wins; otherwise absent, `null` and
 * the `BASE_SERVICE_TIERS` are the base rates; any other tier (OpenAI
 * `priority` bills about 2x) needs a configured multiplier, so an
 * unknown modifier refuses instead of being under-reserved.
 */
function serviceTierMultiplier(body: Record<string, unknown>, pricing: ModelPricing): number {
  const tier = body.service_tier;
  if (tier === undefined || tier === null) return 1;
  if (typeof tier === "string") {
    const configured = configuredTierMultiplier(tier, pricing);
    if (configured !== undefined) return configured;
    if (BASE_SERVICE_TIERS.has(tier.toLowerCase())) return 1;
  }
  throw new Error(`turn budget cannot price service_tier ${JSON.stringify(tier)}; declare it in the model's pricing.serviceTierMultipliers or remove it`);
}

/**
 * Settlement multiplier for a completion the service says was served at
 * `served`: its configured multiplier, `1` for a `BASE_SERVICE_TIERS`
 * name, and `undefined` for a tier with no known price (the caller then
 * charges the whole hold). A response that names no tier keeps the
 * requested multiplier.
 */
function servedTierMultiplier(served: string | undefined, requested: number, pricing: ModelPricing): number | undefined {
  if (served === undefined) return requested;
  const configured = configuredTierMultiplier(served, pricing);
  if (configured !== undefined) return configured;
  return BASE_SERVICE_TIERS.has(served.toLowerCase()) ? 1 : undefined;
}

/**
 * Assumed reply size of a send with no explicit output ceiling (no request,
 * provider-entry or body cap). The hold is soft: settlement charges real
 * usage, so the cap can be exceeded by at most one reply's output beyond it.
 */
export const SOFT_OUTPUT_RESERVE_TOKENS = 8192;

/**
 * How a USD cap is enforced for one request: `hard` reserves an explicit
 * output ceiling written into the body, `soft` reserves an assumed reply
 * without writing a ceiling, `meter` reserves nothing and charges reported
 * cost (or a usage estimate when pricing is known) after the reply, and
 * `unbilled` is an explicit local runner or subscription plan.
 */
export type RequestBudgetMode = "hard" | "soft" | "meter" | "unbilled";

/** Input estimate: serialized body bytes per token, plus a fixed framing allowance. */
const BODY_BYTES_PER_TOKEN = 3;
const FRAMING_TOKENS = 1024;
/** Smallest output a clamped ceiling or shrunk soft bound may leave. */
const MIN_OUTPUT_TOKENS = 1024;

type Hold = ReturnType<FusionTurnBudget["reserveRequest"]>;

function isCapRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("turn budget cannot cover this request");
}

/**
 * Reserves `upperUsd(output)` for the largest output in
 * [min(MIN_OUTPUT_TOKENS, output), output] that the remaining allowance
 * covers. Reservation is synchronous, so the search cannot race another
 * request. Refuses with the full bound's error when even the smallest
 * output does not fit.
 */
function reserveFitting(budget: FusionTurnBudget, sessionId: string, output: number, upperUsd: (output: number) => number): { hold: Hold; output: number } {
  const attempt = (tokens: number): Hold | undefined => {
    try { return budget.reserveRequest(sessionId, upperUsd(tokens)); } catch (error) {
      if (isCapRefusal(error)) return undefined;
      throw error;
    }
  };
  const full = attempt(output);
  if (full !== undefined) return { hold: full, output };
  const floor = Math.min(MIN_OUTPUT_TOKENS, output);
  const smallest = floor < output ? attempt(floor) : undefined;
  if (smallest === undefined) return { hold: budget.reserveRequest(sessionId, upperUsd(output)), output };
  smallest.release();
  let fits = floor;
  let misses = output;
  while (misses - fits > 1) {
    const middle = Math.floor((fits + misses) / 2);
    const probe = attempt(middle);
    if (probe === undefined) misses = middle;
    else { probe.release(); fits = middle; }
  }
  return { hold: budget.reserveRequest(sessionId, upperUsd(fits)), output: fits };
}

export interface RequestBudgetScope extends CompletionRequestBudget {
  signal?: AbortSignal;
  /** Enforcement of the USD cap; `undefined` without one. `hard` may become `soft` at the first send. */
  mode?: RequestBudgetMode;
  /** True once a send reserved an assumed reply instead of an explicit ceiling. */
  softBound: boolean;
  /**
   * One-line advice when the cap is not hard-enforced (`soft` or `meter`).
   * The scope does no logging; a caller that reports it should do so once
   * per `hintKey` (session and provider).
   */
  hint?: string;
  hintKey?: string;
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
  const pricing = model?.pricing;
  const priced = verifiablePricing(pricing);
  const entryId = entry?.id ?? provider.id;
  const capText = limits.usd === undefined ? "" : formatUsd(limits.usd);
  // Without verified pricing or per-send authorization the cap cannot be
  // enforced ahead of time: meter the reply instead of refusing every request.
  let mode: RequestBudgetMode | undefined = limits.usd === undefined ? undefined
    : unbilled ? "unbilled"
    : !priced || provider.supportsRequestBudget !== true ? "meter"
    : "hard";
  let hint = mode !== "meter" ? undefined : !priced
    ? `turn budget: no verified pricing for provider ${provider.id}; the ${capText} cap is only checked after each reply (configure model pricing to enforce it before sending)`
    : `turn budget: provider ${provider.id} cannot authorize each physical send; the ${capText} cap is only checked after each reply`;
  const priceRequired = mode === "hard";
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
  const scope: RequestBudgetScope = {
    signal,
    ...(mode === undefined ? {} : { mode }),
    softBound: false,
    ...(hint === undefined ? {} : { hint, hintKey: `${sessionId}:${provider.id}` }),
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
      const soft = explicitCaps.length === 0;
      let ceiling: number;
      let fields: readonly ("max_tokens" | "max_completion_tokens")[] = [];
      if (soft) {
        // No explicit ceiling: assume a bounded reply, leave the body alone
        // and settle on real usage afterwards.
        const window = model?.contextWindow;
        ceiling = typeof window === "number" && Number.isFinite(window) && window > 0
          ? Math.min(SOFT_OUTPUT_RESERVE_TOKENS, Math.floor(window)) : SOFT_OUTPUT_RESERVE_TOKENS;
        if (!scope.softBound) {
          scope.softBound = true;
          mode = "soft";
          scope.mode = mode;
          hint = `turn budget: provider entry ${entryId} has no maxOutputTokens; each request reserves an assumed ${ceiling}-token reply, so the ${capText} cap can be exceeded by one reply's extra output (set maxOutputTokens for a hard cap)`;
          scope.hint = hint;
          scope.hintKey = `${sessionId}:${provider.id}`;
        }
      } else {
        ceiling = Math.floor(Math.min(...explicitCaps));
        // Runs after extraBody/model-parameter conversion, immediately before
        // serialization. Those overrides cannot raise this enforced ceiling.
        // Clamp the field(s) the body already uses. With neither, write the
        // field the wire model's profile expects: OpenAI reasoning models
        // reject `max_tokens`.
        const present = (["max_tokens", "max_completion_tokens"] as const).filter(field => body[field] !== undefined);
        fields = present.length > 0 ? present : [typeof body.model === "string" ? modelParamProfile(body.model).capField : "max_tokens"];
        for (const field of fields) body[field] = ceiling;
      }
      // A planning estimate, not a hard bound: about one token per three
      // UTF-8 bytes of the serialized body (JSON keys and escaping included)
      // plus a framing allowance. Settlement charges real usage, so an
      // underestimate costs at most one request's difference. Multi-byte
      // scripts stay sane: a 3-byte CJK character counts as one token.
      // The context window is not a floor for ordinary bodies: it would
      // reserve a full window for every short request and starve parallel
      // workers. It is the floor when the provider adds input of its own
      // (web search results, server tools) that the body cannot bound.
      const serialized = JSON.stringify(body);
      const bodyTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / BODY_BYTES_PER_TOKEN) + FRAMING_TOKENS;
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
      // Input is priced at the input rate; the cache-write premium applies
      // only when the body places explicit `cache_control` breakpoints.
      // Settlement prices the reported cache reads/writes.
      const cacheBreakpoints = serialized.includes('"cache_control"');
      const inputRates = [pricing!.input];
      if (cacheBreakpoints) inputRates.push(pricing!.cacheWrite ?? pricing!.input);
      // Missing long cache rates are derived exactly as settlement derives them.
      if (long !== undefined) inputRates.push(long.input, ...(cacheBreakpoints ? [long.cacheWrite] : []));
      const inputRate = Math.max(...inputRates);
      const outputRate = long === undefined ? pricing!.output : Math.max(pricing!.output, long.output);
      const copies = [body.n, body.best_of].filter(value => value !== undefined);
      if (!copies.every(value => typeof value === "number" && Number.isInteger(value) && value > 0)) throw new Error("turn budget cannot verify the request's completion count");
      const outputCopies = Math.max(1, ...(copies as number[]));
      const upperUsd = (output: number) => ((inputTokens * inputRate + output * outputRate) * outputCopies * multiplier) / 1_000_000;
      const fitting = reserveFitting(budget, sessionId, ceiling, upperUsd);
      held = fitting.hold;
      if (fitting.output < ceiling) {
        // Clamp a written ceiling to what the allowance covers; a soft
        // bound only assumes the smaller reply.
        for (const field of fields) body[field] = fitting.output;
      }
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
      // Reported cost has already won above; only the estimate takes the
      // tier, the one the response says served the request when it names
      // one (an `auto` request can be served at a project's priority tier).
      // A served tier with no known price settles at the whole hold.
      const estimatedCostUsd = (usage: CompletionUsage): number | undefined => {
        if (!priced) return undefined;
        const multiplier = servedTierMultiplier(usage.serviceTier, tierMultiplier, pricing);
        const usd = completionCostUsd(usage, pricing);
        return usd === undefined || multiplier === undefined ? undefined : usd * multiplier;
      };
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      const usage = result?.usage;
      // A metered request holds nothing, so a missing estimate charges zero.
      held?.settle(usage === undefined ? (priceRequired ? undefined : 0) : reportedCostUsd(usage) ??
        (mode === "unbilled" ? 0 : usage.incomplete === true ? undefined : estimatedCostUsd(usage)));
      held = undefined;
    },
  };
  return scope;
}
