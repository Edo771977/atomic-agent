import type { CompletionUsage } from "./completion-types.js";
import type { ResolvedModel } from "./model-resolver.js";

/**
 * What the service itself billed for a completion (OpenRouter
 * `usage.cost`), when it reported a usable figure: finite and not
 * negative. `undefined` otherwise.
 */
export function reportedCostUsd(usage: CompletionUsage): number | undefined {
  const cost = usage.costUsd;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * Spend of one completion, in USD, or `undefined` when there is nothing
 * to price it with: the service's own bill (`usage.costUsd`) when it
 * reported one, even for a model the price table does not know; else
 * the estimate at `pricing`; else `undefined` (an unpriced model).
 */
export function completionCostUsd(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]> | undefined,
): number | undefined {
  const reported = reportedCostUsd(usage);
  if (reported !== undefined) return reported;
  return pricing === undefined ? undefined : estimateUsageCostUsd(usage, pricing);
}

/**
 * Spend of one completion, in USD. The service's own bill
 * (`usage.costUsd`) wins when it reported one, priced model or not, so
 * spend caps see an unpriced model's real cost. Otherwise it is
 * estimated from the usage and the model's per-million-token prices;
 * an unpriced model with no reported bill counts `0`.
 *
 * Cached prompt tokens are a subset of `promptTokens`: they are billed at
 * the model's `cacheRead` rate when the catalog or the operator names
 * one, and at the plain input rate otherwise (an unknown discount is not
 * assumed).
 *
 * Prompt tokens written to the cache are priced at the model's
 * `cacheWrite` rate when the service reports them (`cacheWriteTokens`,
 * Kimi's `prompt_tokens_details.cache_write_tokens`) and a rate is
 * known; otherwise they stay in the plain-input share, as before. A
 * service that reports no write count is billed exactly as it was
 * (ATO-912).
 *
 * Output tokens the service left out of `completion_tokens` but counted
 * in its total (`unreportedOutputTokens`) are billed at the output rate.
 *
 * When `pricing.longContext` is set and the prompt is strictly larger
 * than its `thresholdTokens`, every share uses that block's rates. The
 * usage must be ONE completion's: a sum goes to
 * `estimateSummedUsageCostUsd`.
 * The threshold is compared with `promptTokens`, the whole prompt: the
 * OpenAI-compatible normaliser folds Anthropic-shaped cache counts
 * reported outside `prompt_tokens` into it (`normaliseOpenAiUsage`).
 * `serviceTierMultipliers` are not applied here: the usage does not say
 * which tier was requested (the request budget applies them).
 */
export function estimateUsageCostUsd(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]> | undefined,
): number {
  return estimate(usage, pricing, true);
}

/**
 * `estimateUsageCostUsd` for a SUM of completions (a worker's steps, a
 * split task's rows). The long-context threshold is per request: a sum
 * above it says nothing about any one prompt, so the sum is priced at
 * the base rates. A caller that may hold long-context completions
 * prices those per call before summing (`WorkerRunCollector`) and
 * passes only the rest here.
 */
export function estimateSummedUsageCostUsd(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]> | undefined,
): number {
  return estimate(usage, pricing, false);
}

/** True when one completion's prompt is billed at `pricing.longContext`. */
export function isLongContextUsage(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]> | undefined,
): boolean {
  const long = pricing?.longContext;
  return long !== undefined && usage.promptTokens > long.thresholdTokens;
}

/** Every rate of one share of a completion, USD per million tokens. */
export interface UsageRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The long-context block's rates, or `undefined` without one. A cache
 * rate the block leaves out keeps the base model's ratio to its input
 * (`long.input x base.cacheWrite / base.input`): vendors scale the cache
 * rates with the input rate. With no base cache rate (or a free base
 * input, where no ratio exists) it is the long input rate, or the base
 * cache rate when that is higher.
 */
export function longContextRates(
  pricing: NonNullable<ResolvedModel["pricing"]>,
): UsageRates | undefined {
  const long = pricing.longContext;
  if (long === undefined) return undefined;
  const scaled = (base: number | undefined): number => {
    if (base === undefined) return long.input;
    return pricing.input > 0 ? (long.input * base) / pricing.input : Math.max(long.input, base);
  };
  return {
    input: long.input,
    output: long.output,
    cacheRead: long.cacheRead ?? scaled(pricing.cacheRead),
    cacheWrite: long.cacheWrite ?? scaled(pricing.cacheWrite),
  };
}

function estimate(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]> | undefined,
  oneCompletion: boolean,
): number {
  const reported = reportedCostUsd(usage);
  if (reported !== undefined) return reported;
  if (pricing === undefined) return 0;
  // A prompt above the long-context threshold is billed entirely at the
  // long-context rates (`longContextRates`).
  const long = longContextRates(pricing);
  const rates =
    long !== undefined && oneCompletion && isLongContextUsage(usage, pricing)
      ? long
      : { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead ?? pricing.input, cacheWrite: pricing.cacheWrite ?? pricing.input };
  const cached = Math.min(
    Math.max(0, usage.cachedTokens ?? 0),
    Math.max(0, usage.promptTokens),
  );
  // Disjoint from the cached share: hits, writes and the uncached rest
  // sum to the prompt (Kimi documents it so).
  const written = Math.min(
    Math.max(0, usage.cacheWriteTokens ?? 0),
    Math.max(0, usage.promptTokens - cached),
  );
  const uncached = usage.promptTokens - cached - written;
  return (
    (uncached / 1_000_000) * rates.input +
    (cached / 1_000_000) * rates.cacheRead +
    (written / 1_000_000) * rates.cacheWrite +
    ((usage.completionTokens + Math.max(0, usage.unreportedOutputTokens ?? 0)) /
      1_000_000) *
      rates.output
  );
}

/**
 * A spend estimate in plain dollars: two decimals, or four below one
 * cent so a cheap run does not read as `$0.00`.
 */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
