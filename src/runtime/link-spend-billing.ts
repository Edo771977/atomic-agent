import type { ResolvedModel } from "../llm/provider/model-resolver.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import { isLocalServerUrl } from "../llm/provider/openai/local-server-url.js";

export type ModelPricing = NonNullable<ResolvedModel["pricing"]>;

function validRate(rate: unknown): boolean {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
}

/** Every rate the reservation or settlement may read is finite and >= 0. */
export function verifiablePricing(pricing: ModelPricing | undefined): pricing is ModelPricing {
  if (pricing === undefined) return false;
  if (![pricing.input, pricing.output, pricing.cacheWrite ?? 0, pricing.cacheRead ?? 0].every(validRate)) return false;
  const long = pricing.longContext;
  if (long !== undefined && !(typeof long.thresholdTokens === "number" && long.thresholdTokens > 0 && [long.input, long.output, long.cacheWrite ?? 0, long.cacheRead ?? 0].every(validRate))) return false;
  const tiers = pricing.serviceTierMultipliers;
  return tiers === undefined || Object.values(tiers).every(validRate);
}

/**
 * How a link bills for the turn budget, the day total and the daily
 * ceiling (ATO-649): `plan` for a subscription CLI, `local` for a link
 * that bills nothing, `billed` for the rest.
 *
 * `llama-server` is always local. Any other kind on a loopback or private
 * URL (`isLocalServerUrl`: Ollama, LM Studio, vLLM on this machine or the
 * LAN) is local too, unless the operator gave its model verified pricing:
 * a priced one is a forwarding gateway to a paid service (LiteLLM, a team
 * proxy, a Tailscale address) and is counted and capped like any paid link.
 * Without that exception an unpriced Ollama was refused at the limit (so
 * `onDailyLimit: "local"` could not land on it) and added an unpriced call
 * to the day for every reply.
 */
export function linkSpendBilling(
  entry: Pick<LlmProviderConfigEntry, "kind" | "baseUrl" | "url"> | undefined,
  pricing: ModelPricing | undefined,
): "local" | "plan" | "billed" {
  if (entry?.kind === "subscription-cli") return "plan";
  if (entry?.kind === "llama-server") return "local";
  if (entry !== undefined && isLocalServerUrl(entry.baseUrl ?? entry.url) && !verifiablePricing(pricing)) return "local";
  return "billed";
}
