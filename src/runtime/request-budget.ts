import type { CompletionRequest, CompletionRequestBudget, CompletionResult, CompletionUsage } from "../llm/provider/completion-types.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import { completionCostUsd, longContextRates, reportedCostUsd } from "../llm/provider/usage-cost.js";
import { readErrnoCode } from "../llm/errno-code.js";
import { modelParamProfile } from "../llm/provider/openai/model-params.js";
import { formatUsd, type FusionTurnBudget } from "../tools/fusion/turn-budget.js";
import { DailySpendLimitError } from "../llm/reliability/spend-limit-error.js";
import type { DailySpendBudget, DailySpendHold } from "./daily-spend-budget.js";
import { linkSpendBilling, verifiablePricing, type ModelPricing } from "./link-spend-billing.js";

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

/**
 * Price multiplier of the body's `service_tier`, matched without regard
 * to case. A configured multiplier wins; otherwise absent, `null` and
 * the `BASE_SERVICE_TIERS` are the base rates; any other tier (OpenAI
 * `priority` bills about 2x) needs a configured multiplier, so an
 * unknown modifier refuses instead of being under-reserved.
 */
function serviceTierMultiplier(body: Record<string, unknown>, pricing: ModelPricing, label: string): number {
  const tier = body.service_tier;
  if (tier === undefined || tier === null) return 1;
  if (typeof tier === "string") {
    const configured = configuredTierMultiplier(tier, pricing);
    if (configured !== undefined) return configured;
    if (BASE_SERVICE_TIERS.has(tier.toLowerCase())) return 1;
  }
  throw new Error(`${label} cannot price service_tier ${JSON.stringify(tier)}; declare it in the model's pricing.serviceTierMultipliers or remove it`);
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

/** The holds one physical send takes: the turn's and the day's. */
interface SendHolds {
  turn?: Hold;
  daily?: DailySpendHold;
}

function releaseHolds(holds: SendHolds): void {
  holds.turn?.release();
  holds.daily?.release();
}

function isCapRefusal(error: unknown): boolean {
  return error instanceof DailySpendLimitError ||
    (error instanceof Error && error.message.startsWith("turn budget cannot cover this request"));
}

/**
 * Reserves `upperUsd(output)` for the largest output in
 * [min(MIN_OUTPUT_TOKENS, output), output] that the remaining allowance
 * (turn and day) covers. Reservation is synchronous, so the search cannot
 * race another request. Refuses with the full bound's error when even the
 * smallest output does not fit.
 */
function reserveFitting(reserve: (usd: number) => SendHolds, output: number, upperUsd: (output: number) => number): { holds: SendHolds; output: number } {
  const attempt = (tokens: number): SendHolds | undefined => {
    try { return reserve(upperUsd(tokens)); } catch (error) {
      if (isCapRefusal(error)) return undefined;
      throw error;
    }
  };
  const full = attempt(output);
  if (full !== undefined) return { holds: full, output };
  const floor = Math.min(MIN_OUTPUT_TOKENS, output);
  const smallest = floor < output ? attempt(floor) : undefined;
  if (smallest === undefined) return { holds: reserve(upperUsd(output)), output };
  releaseHolds(smallest);
  let fits = floor;
  let misses = output;
  while (misses - fits > 1) {
    const middle = Math.floor((fits + misses) / 2);
    const probe = attempt(middle);
    if (probe === undefined) misses = middle;
    else { releaseHolds(probe); fits = middle; }
  }
  return { holds: reserve(upperUsd(fits)), output: fits };
}

export interface RequestBudgetScope extends CompletionRequestBudget {
  signal?: AbortSignal;
  /** Enforcement of the USD cap; `undefined` without one. `hard` may become `soft` at the first send. */
  mode?: RequestBudgetMode;
  /** True once a send reserved an assumed reply instead of an explicit ceiling. */
  softBound: boolean;
  /**
   * One-line advice for soft/meter enforcement or an output clamp.
   * The scope does no logging; runtime observes changes once per
   * provider/reason/owning turn, including changes at physical admission.
   */
  hint?: string;
  hintKey?: string;
  hintReason?: "soft" | "meter" | "clamp";
  /**
   * Settle the scope. `streamed.outputBytes` is the reply text a stream
   * delivered before it ended without a result (a cancel): the day's
   * ledger prices it on top of the input bound.
   */
  finish(result?: CompletionResult, streamed?: { outputBytes: number }): void;
}

/**
 * A scope survives retries; each physical send acquires a separate hold.
 *
 * Two ledgers share one scope: the turn budget (`budget`, when the owning
 * session has request limits) and the day's spend (`daily`, ATO-649,
 * whenever the runtime keeps a day total). Both hold the same upper bound
 * before a send, release it on the same explicit rejections and settle the
 * same amount in `finish`, so a call is counted once and a retried send
 * that may have been billed is charged on both.
 */
export function createRequestBudgetScope(
  budget: FusionTurnBudget | undefined,
  request: CompletionRequest,
  provider: LlmProvider,
  entry: LlmProviderConfigEntry | undefined,
  model: ResolvedModel | undefined,
  daily?: DailySpendBudget,
): RequestBudgetScope | undefined {
  const sessionId = request.budgetOwnerSessionId ?? request.sessionId;
  const limits = budget === undefined || sessionId === undefined ? undefined : budget.requestLimits(sessionId);
  // An explicit runner or plan, or an unpriced loopback/LAN server; a
  // priced one may be a forwarding gateway to a paid service and is billed.
  const unbilled = linkSpendBilling(entry, model?.pricing) !== "billed";
  // Unbilled links are not spend: the day never sees them.
  const day = unbilled ? undefined : daily;
  if (limits === undefined && day === undefined) return undefined;
  const pricing = model?.pricing;
  const priced = verifiablePricing(pricing);
  const entryId = entry?.id ?? provider.id;
  const capText = limits?.usd === undefined ? "" : formatUsd(limits.usd);
  // How this link's spend can be bounded: ahead of each send (`hard`),
  // only after the reply (`meter`), or not at all (`unbilled`). Without
  // verified pricing or per-send authorization a cap cannot be enforced
  // ahead of time: meter the reply instead of refusing every request.
  const billing: RequestBudgetMode = unbilled ? "unbilled"
    : !priced || provider.supportsRequestBudget !== true ? "meter"
    : "hard";
  let mode: RequestBudgetMode | undefined = limits?.usd === undefined ? undefined : billing;
  const dayLimit = day?.limitUsd() ?? null;
  const dayText = dayLimit === null ? "" : formatUsd(dayLimit);
  let hint = mode === "meter" ? !priced
    ? `turn budget: no verified pricing for provider ${provider.id}; the ${capText} cap is only checked after each reply (configure model pricing to enforce it before sending)`
    : `turn budget: provider ${provider.id} cannot authorize each physical send; the ${capText} cap is only checked after each reply`
    : dayLimit !== null && billing === "meter" ? !priced
    ? `daily spend limit: no verified pricing for provider ${provider.id}; its calls count toward the ${dayText} daily limit only by reported cost, and the limit is only checked after each reply (configure model pricing to enforce it before sending)`
    : `daily spend limit: provider ${provider.id} cannot authorize each physical send; the ${dayText} daily limit is only checked after each reply`
    : undefined;
  // Which ledgers hold an upper bound before each send.
  const turnPriced = mode === "hard";
  const dayPriced = day !== undefined && dayLimit !== null && billing === "hard";
  const priceRequired = turnPriced || dayPriced;
  const label = turnPriced ? "turn budget" : "daily spend limit";
  const caps = [request.maxTokens, request.maxOutputTokens, entry?.maxOutputTokens].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  // No context-window fallback: providers reject a window-sized output
  // limit, and reserving one would hold dollars per request.
  const outputCap = caps.length > 0 ? Math.min(...caps) : undefined;
  // The cap the provider writes itself: what this call asked for, else
  // the turn's ceiling, else the entry's (`openai-build-body.ts`).
  const providerCap = caps.length > 0 ? caps[0] : undefined;
  const timeLeft = limits === undefined ? undefined : budget!.requestTimeLeftMs(sessionId!);
  if (timeLeft !== undefined && timeLeft <= 0) throw new Error("the turn time cap has been reached before this request");
  // A metered day holds nothing; the zero hold still refuses once today's
  // total is at the ceiling. Taken before the turn's, so a refusal leaves
  // no turn hold behind.
  let dayHeld = day !== undefined && !dayPriced ? day.reserve(entryId, 0) : undefined;
  let held: Hold | undefined;
  try { held = !turnPriced && limits?.usd !== undefined ? budget!.reserveRequest(sessionId!, 0) : undefined; } catch (error) {
    dayHeld?.release();
    throw error;
  }
  const deadline = new AbortController();
  const signal = request.signal === undefined ? deadline.signal : AbortSignal.any([request.signal, deadline.signal]);
  const timer = timeLeft === undefined ? undefined : setTimeout(() => deadline.abort(new DOMException("the turn time cap stopped this request", "AbortError")), timeLeft);
  timer?.unref?.();
  let done = false;
  // Multiplier of the most recent physical send; settlement prices usage with it.
  let tierMultiplier = 1;
  // The latest priced send's input bound and per-output-token rate (USD),
  // and its whole hold: what an abandoned send is charged on the day.
  let sendInputUsd = 0;
  let sendOutputUsdPerToken = 0;
  let sendHoldUsd = 0;
  const hintKey = `${sessionId ?? ""}:${provider.id}`;
  const reserveBoth = (usd: number): SendHolds => {
    const turn = turnPriced ? budget!.reserveRequest(sessionId!, usd) : undefined;
    let dailyHold: DailySpendHold | undefined;
    try { dailyHold = dayPriced ? day!.reserve(entryId, usd) : undefined; } catch (error) {
      turn?.release();
      throw error;
    }
    return { ...(turn === undefined ? {} : { turn }), ...(dailyHold === undefined ? {} : { daily: dailyHold }) };
  };
  const scope: RequestBudgetScope = {
    signal,
    ...(mode === undefined ? {} : { mode }),
    softBound: false,
    ...(hint === undefined ? {} : { hint, hintKey, hintReason: "meter" as const }),
    beforeSend(body) {
      if (done) throw new Error("request budget scope is already closed");
      if (signal.aborted) throw signal.reason;
      if (!priceRequired) return;
      // A retry after an ambiguous dispatch can have been billed too.
      if (turnPriced) { held?.settle(); held = undefined; }
      if (dayPriced) { dayHeld?.settle(); dayHeld = undefined; }
      if (request.signal?.aborted) throw request.signal.reason;
      const wireCaps = [body.max_tokens, body.max_completion_tokens].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
      // A turn cap enforces the tightest configured ceiling over any body
      // override. A daily limit alone bounds the reply the provider will
      // actually send: the body's cap (after extraBody and model params),
      // else the provider's own rule. Taking the minimum there would cut
      // a truncation step-up (16000 asked, entry 4096) or an extraBody
      // cap down although the day has room for it.
      const explicitCaps = turnPriced
        ? (outputCap === undefined ? wireCaps : [outputCap, ...wireCaps])
        : wireCaps.length > 0 ? wireCaps : providerCap === undefined ? [] : [providerCap];
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
          if (turnPriced) {
            mode = "soft";
            scope.mode = mode;
            hint = `turn budget: provider entry ${entryId} has no maxOutputTokens; each request reserves an assumed ${ceiling}-token reply, so the ${capText} cap can be exceeded by one reply's extra output (set maxOutputTokens for a hard cap)`;
          } else {
            hint = `daily spend limit: provider entry ${entryId} has no maxOutputTokens; each request reserves an assumed ${ceiling}-token reply, so the ${dayText} daily limit can be exceeded by one reply's extra output (set maxOutputTokens for a hard limit)`;
          }
          scope.hint = hint;
          scope.hintKey = hintKey;
          scope.hintReason = "soft";
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
          throw new Error(`${label} cannot bound provider-side input (web search plugins or server tools) without a verified model context window`);
        }
        inputTokens = Math.max(bodyTokens, model!.contextWindow);
      }
      const multiplier = serviceTierMultiplier(body, pricing!, label);
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
      if (!copies.every(value => typeof value === "number" && Number.isInteger(value) && value > 0)) throw new Error(`${label} cannot verify the request's completion count`);
      const outputCopies = Math.max(1, ...(copies as number[]));
      const upperUsd = (output: number) => ((inputTokens * inputRate + output * outputRate) * outputCopies * multiplier) / 1_000_000;
      const dayLeft = dayPriced ? day!.remainingUsd() : null;
      const fitting = reserveFitting(reserveBoth, ceiling, upperUsd);
      sendInputUsd = upperUsd(0);
      sendOutputUsdPerToken = upperUsd(1) - sendInputUsd;
      sendHoldUsd = upperUsd(fitting.output);
      if (turnPriced) held = fitting.holds.turn;
      if (dayPriced) dayHeld = fitting.holds.daily;
      if (fitting.output < ceiling) {
        // Clamp a written ceiling to what the allowance covers; a soft
        // bound only assumes the smaller reply.
        for (const field of fields) body[field] = fitting.output;
        if (fields.length > 0) {
          hint = dayLeft !== null && upperUsd(ceiling) > dayLeft
            ? `daily spend limit: reply capped at ${fitting.output} tokens (from ${ceiling}) to fit the remaining daily allowance (${formatUsd(dayLeft)} left)`
            : `turn budget: reply capped at ${fitting.output} tokens (from ${ceiling}) to fit the remaining ${capText} turn allowance`;
          scope.hint = hint;
          scope.hintKey = hintKey;
          scope.hintReason = "clamp";
        }
      }
      tierMultiplier = multiplier;
    },
    onResponse(status) {
      // 408, other 5xx and network deaths remain ambiguous and retain their bound.
      if (RELEASED_STATUSES.has(status)) {
        // A metered hold (turn or day) is the scope's zero hold, not this
        // send's: it stays so a retried reply is still settled against it.
        if (turnPriced) { held?.release(); held = undefined; }
        if (dayPriced) { dayHeld?.release(); dayHeld = undefined; }
      }
    },
    onSendFailed(error) {
      const code = readErrnoCode(error);
      if (code !== undefined && UNSENT_ERRNOS.has(code)) {
        if (turnPriced) { held?.release(); held = undefined; }
        if (dayPriced) { dayHeld?.release(); dayHeld = undefined; }
      }
    },
    finish(result, streamed) {
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
      // One settled amount for both ledgers.
      const settledUsd = usage === undefined ? undefined : reportedCostUsd(usage) ??
        (billing === "unbilled" ? 0 : usage.incomplete === true ? undefined : estimatedCostUsd(usage));
      // A metered request holds nothing, so a missing estimate charges zero.
      held?.settle(usage === undefined ? (turnPriced ? undefined : 0) : settledUsd);
      held = undefined;
      // A send abandoned after it left (a cancel or the turn deadline,
      // or a reply with no usage block): the provider may bill the prompt
      // and whatever it generated, but charging the whole output ceiling
      // would put money never spent on today's total, and each Esc would
      // eat into the day. The day counts it as a priced call at the input
      // bound plus the output known to have arrived (streamed or returned
      // text, at the bound's bytes-per-token), never more than the hold.
      // The turn ledger keeps its conservative whole-hold charge.
      const abandonedUsd = (outputBytes: number): number =>
        Math.min(sendHoldUsd, sendInputUsd + Math.ceil(outputBytes / BODY_BYTES_PER_TOKEN) * sendOutputUsdPerToken);
      const returnedBytes = (reply: CompletionResult): number =>
        Buffer.byteLength(reply.content ?? "", "utf8") + Buffer.byteLength(reply.reasoningContent ?? "", "utf8") +
        (reply.toolCalls === undefined ? 0 : Buffer.byteLength(JSON.stringify(reply.toolCalls), "utf8"));
      if (day !== undefined) {
        if (dayHeld !== undefined) {
          // No reply on a metered day: nothing is known to have been billed.
          if (usage === undefined && !dayPriced) dayHeld.release();
          else if (dayPriced && usage === undefined && signal.aborted) dayHeld.settle(abandonedUsd(streamed?.outputBytes ?? 0));
          else if (dayPriced && usage?.incomplete === true && reportedCostUsd(usage) === undefined) dayHeld.settle(abandonedUsd(returnedBytes(result!)));
          else dayHeld.settle(settledUsd);
        } else if (usage !== undefined) {
          // A reply whose send took no hold (released on a rejection the
          // provider then retried past, or a provider that never calls
          // beforeSend): still today's spend.
          day.charge(settledUsd);
        }
        dayHeld = undefined;
      }
    },
  };
  return scope;
}
