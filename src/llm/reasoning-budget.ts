import type { ReasoningEffort } from "./provider/completion-types.js";

/**
 * The think-block budget of a local reasoning model, and its units (F49).
 *
 * A grammar-served reasoning model (`qwen-think`, `gemma4-think`) thinks
 * inside a GBNF prelude before the tool-call array. Unbounded, that
 * prelude is where a small model spends most of a step: the fusion bench
 * measured 500–7,152 reasoning tokens per tool step at 4.5 tok/s, 84–96 %
 * of every completion, one step of 22 minutes. `localModels.
 * reasoningBudgetTokens` bounds it. The grammar has no tokenizer, so the
 * bound is stated in characters at a fixed ratio; the same ratio prices
 * the reasoning a completion actually carried, so a step that hit the
 * bound shows `reasoningTokens` at about the configured budget in its
 * trace. About, not at least: the count is an estimate from the text,
 * and a `<`-led grammar unit spans more than one character.
 *
 * llama.cpp caps one GBNF quantifier at 1,999 repetitions (#600). Until
 * ATO-607 that clamped the whole bound to 499 tokens, so a budget of
 * 1,500 cut thinking at about 2,000 characters. The grammar now chains
 * quantifiers that each stay under the cap (`buildReasoningPreludeRules`),
 * so the configured budget is the bound the model gets.
 */

/**
 * `localModels.reasoningBudgetTokens` when the file predates the field:
 * `0`, no bound (config v78). The old 1,500 was clamped to 499 by the
 * llama.cpp repeat cap of the time (lifted in ATO-607) and cut thinking
 * models off mid-thought.
 */
export const DEFAULT_REASONING_BUDGET_TOKENS = 0;

/**
 * Characters per budget token. Deliberately on the generous side of an
 * English tokenizer (~4.5 chars/token for prose, fewer for code), so a
 * budget cuts later, not earlier, than its name suggests.
 */
export const REASONING_CHARS_PER_TOKEN = 4;

/** The character bound the grammar enforces for `budgetTokens`; `0` stays `0` (unbounded). */
export function reasoningBudgetChars(budgetTokens: number): number {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return Math.floor(budgetTokens) * REASONING_CHARS_PER_TOKEN;
}

/**
 * The reasoning a completion carried, in budget tokens — the text before
 * the close sentinel priced at `REASONING_CHARS_PER_TOKEN`. An estimate
 * in the budget's own units, not the server's token count: that is what
 * makes a cut visible as reaching the budget whatever the tokenizer did.
 */
export function estimateReasoningTokens(reasoningText: string): number {
  if (reasoningText.length === 0) return 0;
  return Math.ceil(reasoningText.length / REASONING_CHARS_PER_TOKEN);
}

/**
 * The budget a grammar-served model really gets for `budgetTokens`, in
 * tokens: `0` (unbounded) stays `0`, anything else is the configured
 * budget, floored. No longer capped by llama.cpp's per-quantifier limit
 * (ATO-607); kept as the one place callers ask, so a future engine
 * limit lands here and not at every call site.
 */
export function effectiveReasoningBudgetTokens(budgetTokens: number): number {
  return reasoningBudgetChars(budgetTokens) / REASONING_CHARS_PER_TOKEN;
}

/**
 * The think-block bound of a fusion worker on a local (grammar) leg,
 * per `llm.runMode.fusion.workerReasoning` level. A local llama-server
 * has no reasoning-effort parameter, so the level is spelled as this
 * per-request grammar bound (`withReasoningBudget`); a cloud leg keeps
 * reading the effort from the body builder instead.
 *
 * Placed against the fusion bench above, which recorded a range of
 * 500–7,152 reasoning tokens per tool step and no per-step distribution
 * (no median or percentile): `low` sits at about the bench's low end,
 * `medium` at about three times it, well under the top, so the long
 * steps that made workers miss their time limit are cut, and `high`
 * leaves about four-sevenths of the longest recorded step. Steps that
 * needed more than a level allows are cut mid-thought; the bench cannot
 * say how many that is.
 */
export const LOCAL_WORKER_REASONING_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  low: 512,
  medium: 1_536,
  high: 4_096,
};

/**
 * The bound a local worker gets when `workerReasoning` is unset: the
 * `medium` level. A worker runs under a time limit at local speed, so
 * the unbounded default of an ordinary turn
 * (`DEFAULT_REASONING_BUDGET_TOKENS`) is what cut its answers.
 */
export const DEFAULT_LOCAL_WORKER_REASONING_BUDGET_TOKENS = LOCAL_WORKER_REASONING_BUDGET_TOKENS.medium;

/**
 * The reasoning bound, in budget tokens, for every step of a fusion
 * worker on a local leg; `0` is no bound.
 *
 * - An explicit `workerReasoning` level wins, over a stricter configured
 *   bound too (`low` is 512 with `localModels.reasoningBudgetTokens: 256`):
 *   it is the fusion worker's own setting, the more specific of the two,
 *   and a level that meant different things on different machines would
 *   not be a level.
 * - `unbounded` is the opt-out: `0`, whatever the config says. It is the
 *   only way to an unbounded worker, since a configured `0` is also the
 *   default (config v78) and cannot say it was chosen.
 * - Unset, a positive `localModels.reasoningBudgetTokens` is used as set,
 *   not capped at the default: since v78 migrated the old written default
 *   away, a positive value is a choice the person made for their model,
 *   larger ones included. Otherwise the worker default.
 */
export function localWorkerReasoningBudgetTokens(
  level: ReasoningEffort | "unbounded" | undefined,
  configuredBudgetTokens: number,
): number {
  if (level === "unbounded") return 0;
  if (level !== undefined) return LOCAL_WORKER_REASONING_BUDGET_TOKENS[level];
  const configured = effectiveReasoningBudgetTokens(configuredBudgetTokens);
  return configured > 0 ? configured : DEFAULT_LOCAL_WORKER_REASONING_BUDGET_TOKENS;
}
