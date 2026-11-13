import type { CompletionResult, CompletionUsage } from "../completion-types.js";
import type { ReasoningFormat } from "../llm-provider.js";
import { createReasoningExtractor } from "./reasoning-extractor.js";
import { readServiceTier } from "./parse-sse-chunk.js";

export function normaliseOpenAiChatResponse(
  json: Record<string, unknown>,
  defaultChatModel: string,
  reasoningFormat: ReasoningFormat = "auto",
): CompletionResult {
  const choice =
    (json.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const toolCalls = message.tool_calls as CompletionResult["toolCalls"];
  const content = normaliseMessageContent(message.content);
  // Reasoning models served over OpenAI-compatible APIs return their CoT
  // in a dedicated field alongside `content` — `reasoning_content`
  // (Qwen with preserve_thinking, DeepSeek-R1), `reasoning` (OpenRouter)
  // or `thinking`. Same extractor as the stream consumer, so the unary
  // and streamed paths cannot disagree about where reasoning lives.
  const reasoningContent = createReasoningExtractor(
    reasoningFormat,
  ).extractFromMessage(message);
  // The tier that served the request rides on the usage it priced.
  const usage = {
    ...normaliseOpenAiUsage(json.usage as Record<string, unknown> | undefined),
    ...readServiceTier(json.service_tier),
  };
  return {
    content,
    reasoningContent,
    stop: true,
    truncated: choice.finish_reason === "length",
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: usage.promptTokens,
      predictedTokens: usage.completionTokens,
    },
    cacheHitTokens: usage.cachedTokens ?? 0,
    slotId: -1,
    modelId: typeof json.model === "string" ? json.model : defaultChatModel,
    ...(typeof json.id === "string" && json.id.length > 0
      ? { generationId: json.id }
      : {}),
    usage,
    toolCalls,
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
  };
}

/**
 * One reading of an OpenAI-shaped `usage` block for both paths.
 *
 * `prompt_tokens_details.cached_tokens` is where OpenAI, OpenRouter and
 * Gemini's compatibility layer report the prompt tokens served from a
 * prompt cache (Anthropic through OpenRouter lands there too; a shim
 * that speaks Anthropic's own `cache_read_input_tokens` is read as a
 * fallback). It is the only evidence a turn has that its caching
 * arrangement is working, so it rides on `usage` as `cachedTokens` —
 * absent, not zero, when the service did not say — and on
 * `cacheHitTokens`, which the trace already records per completion.
 */
export function normaliseOpenAiUsage(
  raw: Record<string, unknown> | undefined,
): CompletionUsage {
  const usage = raw ?? {};
  const details = usage.prompt_tokens_details;
  const hasDetails = details !== null && typeof details === "object";
  const cached = hasDetails
    ? (details as Record<string, unknown>).cached_tokens
    : usage.cache_read_input_tokens;
  // Kimi reports cache writes beside the hits (ATO-912); they are billed
  // at their own rate, so keep the count for the cost estimate. An
  // Anthropic-shaped block names them `cache_creation_input_tokens`.
  const written = hasDetails
    ? (details as Record<string, unknown>).cache_write_tokens
    : usage.cache_creation_input_tokens;
  const reportedPrompt = Number(usage.prompt_tokens ?? 0);
  const reportedCompletion = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? 0);
  const output = readOutputTokens(usage, reportedPrompt, reportedCompletion, totalTokens);
  const promptTokens = hasDetails
    ? reportedPrompt
    : reportedPrompt + anthropicCacheOutsidePrompt(cached, written, reportedPrompt, reportedCompletion, totalTokens);
  return {
    ...([usage.prompt_tokens, usage.completion_tokens].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
      ? {} : { incomplete: true as const }),
    promptTokens,
    completionTokens: output.completionTokens,
    totalTokens,
    ...(output.unreported > 0 ? { unreportedOutputTokens: output.unreported } : {}),
    ...(typeof cached === "number" && Number.isFinite(cached) && cached >= 0
      ? { cachedTokens: cached }
      : {}),
    ...(typeof written === "number" && Number.isFinite(written) && written > 0
      ? { cacheWriteTokens: written }
      : {}),
    // OpenRouter reports the call's own charge in credits (USD) as
    // `usage.cost`; it beats a price-table estimate (ATO-569).
    ...(typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
      ? { costUsd: usage.cost }
      : {}),
  };
}

/** A token count the service reported: finite and not negative, else 0. */
function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The Anthropic-shaped cache counts (`cache_read_input_tokens`,
 * `cache_creation_input_tokens`) to add to `prompt_tokens`, or 0 when
 * they are already inside it. Anthropic's own `input_tokens` excludes
 * both, so they are outside unless `total_tokens` is reported and is
 * smaller than prompt + completion + cache (it then counts them once,
 * inside the prompt). The whole prompt is what a long-context threshold
 * and the cache shares are measured against (`CompletionUsage` keeps
 * the cache counts a subset of `promptTokens`).
 */
function anthropicCacheOutsidePrompt(
  cached: unknown,
  written: unknown,
  prompt: number,
  completion: number,
  total: number,
): number {
  const cache = countOf(cached) + countOf(written);
  if (cache === 0) return 0;
  const totalReported = Number.isFinite(total) && total > 0;
  if (totalReported && total < prompt + completion + cache && cache <= prompt) return 0;
  return cache;
}

/**
 * Usage keys that say `total_tokens` counts something besides prompt and
 * completion: cache reads or writes billed outside `prompt_tokens`
 * (`cache_read_input_tokens`, `cache_creation_input_tokens`), and audio,
 * image, citation or search tokens. Beside any of them an excess of the
 * total is not evidence of hidden output.
 */
const NON_OUTPUT_USAGE_KEY = /cache|_input_tokens|audio|image|citation|search/;

function hasNonOutputUsageKey(usage: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(usage)) {
    if (NON_OUTPUT_USAGE_KEY.test(key)) return true;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (Object.keys(value).some((k) => NON_OUTPUT_USAGE_KEY.test(k))) return true;
    }
  }
  return false;
}

/**
 * The output side of an OpenAI-shaped `usage` block.
 *
 * `completion_tokens_details.reasoning_tokens` is read first. On OpenAI
 * it is a subset of `completion_tokens`, so it is added only when it is
 * evidently outside: larger than `completion_tokens`, or the only way
 * `total_tokens` adds up (prompt + completion + reasoning). Either way it
 * settles the question, and the total is not read further.
 *
 * Without it, some services still leave hidden thinking out of
 * `completion_tokens` while counting it in `total_tokens`. That excess is
 * an inference, so it is used only when both `prompt_tokens` and
 * `completion_tokens` are reported and no usage key says the total counts
 * something else (`NON_OUTPUT_USAGE_KEY`). It comes back as `unreported`
 * (`CompletionUsage.unreportedOutputTokens`): billed at the output rate,
 * but kept out of `completionTokens`, which feeds the predicted token
 * count (tok/s) and the truncation-recovery cap, both of which should
 * read what the service reported rather than a guess.
 */
function readOutputTokens(
  usage: Record<string, unknown>,
  promptTokens: number,
  reportedCompletion: number,
  totalTokens: number,
): { completionTokens: number; unreported: number } {
  const details = usage.completion_tokens_details;
  const reasoning =
    details !== null && typeof details === "object"
      ? Number((details as Record<string, unknown>).reasoning_tokens)
      : Number.NaN;
  if (Number.isFinite(reasoning) && reasoning > 0) {
    const outside =
      reasoning > reportedCompletion ||
      (totalTokens > promptTokens + reportedCompletion &&
        totalTokens === promptTokens + reportedCompletion + reasoning);
    return {
      completionTokens: outside ? reportedCompletion + reasoning : reportedCompletion,
      unreported: 0,
    };
  }
  const bothReported =
    typeof usage.prompt_tokens === "number" &&
    typeof usage.completion_tokens === "number";
  const excess = totalTokens - promptTokens - reportedCompletion;
  const unreported =
    bothReported && Number.isFinite(excess) && excess > 0 && !hasNonOutputUsageKey(usage)
      ? excess
      : 0;
  return { completionTokens: reportedCompletion, unreported };
}

/**
 * `message.content` is a plain string on most servers, but multimodal
 * responses may carry an array of content parts. Join the text parts so
 * the runtime never mistakes a parts-array response for an empty one.
 */
export function normaliseMessageContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}
