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
 */
export function estimateUsageCostUsd(
  usage: CompletionUsage,
  pricing: NonNullable<ResolvedModel["pricing"]> | undefined,
): number {
  const reported = reportedCostUsd(usage);
  if (reported !== undefined) return reported;
  if (pricing === undefined) return 0;
  const cached = Math.min(
    Math.max(0, usage.cachedTokens ?? 0),
    Math.max(0, usage.promptTokens),
  );
  const cacheReadRate = pricing.cacheRead ?? pricing.input;
  // Disjoint from the cached share: hits, writes and the uncached rest
  // sum to the prompt (Kimi documents it so).
  const written = Math.min(
    Math.max(0, usage.cacheWriteTokens ?? 0),
    Math.max(0, usage.promptTokens - cached),
  );
  const cacheWriteRate = pricing.cacheWrite ?? pricing.input;
  const uncached = usage.promptTokens - cached - written;
  return (
    (uncached / 1_000_000) * pricing.input +
    (cached / 1_000_000) * cacheReadRate +
    (written / 1_000_000) * cacheWriteRate +
    ((usage.completionTokens + Math.max(0, usage.unreportedOutputTokens ?? 0)) /
      1_000_000) *
      pricing.output
  );
}

/**
 * A spend estimate in plain dollars: two decimals, or four below one
 * cent so a cheap run does not read as `$0.00`.
 */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
