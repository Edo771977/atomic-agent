/**
 * One short completion under a fusion worker's per-request grammar,
 * before a fan-out sends workers to a local server: does the server
 * take the workers' grammar, and does what comes back read with the
 * step's own parser?
 *
 * The field case behind it: a worker leg whose model (or server) did not
 * fit the tool-call protocol was only found out after a worker had run —
 * the failure breaker's "protocol mismatch" trips on the first such row,
 * but that row had already spent the worker's time.
 *
 * What it can and cannot tell. The completion is sampled under the
 * grammar, so a server that applies it returns something the grammar
 * admits; what the check really measures is (1) whether the server
 * accepts the workers' grammar at all, and (2) whether the step's parser
 * — profile reasoning tags, the open-tag prefill the prompt carried,
 * JSON repair — reads what the server returned under it: the profile,
 * the framing, the grammar and the parser agreeing, the seam the root
 * instructions require. It does not show that a model does useful work.
 *
 * What is sent is the request a worker step sends, as far as fits in a
 * few dozen tokens:
 *
 * - the same thinking decision as the step (`thinkingDisabledOnBuiltPrompt`
 *   on the built prompt, the server template's own switch otherwise):
 *   with thinking on, the base grammar keeps its reasoning prelude — the
 *   open sentinel where the model emits it, the bounded body, the close
 *   sentinel and the bounded whitespace into the call array — and the
 *   prompt ends as a worker's does (the open-tag prefill, or Gemma's
 *   turn framing with its system token); with thinking off, the prelude
 *   is dropped and the prompt ends with the template's disabled marker;
 * - the think bound tightened to {@link GRAMMAR_SMOKE_THINK_TOKENS}
 *   (`withReasoningBudget`), the one deliberate difference: a worker's
 *   own bound (`localWorkerReasoningBudgetTokens`, 1,536 tokens by
 *   default) cannot fit the check's cap, and past the bound the grammar
 *   admits only the close sentinel, so a short bound still drives the
 *   close-tag transition a long think ends on;
 * - narrowed to the worker's own tool set (`workerStepToolNames`, the
 *   names `stepGrammarToolNames` keeps for a worker turn), so every
 *   tool rule a worker's grammar carries is in it.
 *
 * The answer is read the way the step reads a grammar completion:
 * `parseToolCalls` with the profile's tags, the open tag re-added where
 * the prompt prefilled it (`completionAssumesOpenReasoning`), JSON
 * repair on.
 *
 * Only two things are a failure, both definite: the server answered 4xx
 * naming the grammar (it rejected the workers' grammar), or a completion
 * that finished on its own did not parse. A timeout, a cancel, a reply
 * cut at the token cap or a stop word, or a server that could not be
 * reached says nothing about the format and is `inconclusive`: the
 * caller dispatches as before and other checks (local-leg health, the
 * breaker) apply.
 *
 * The request lives on its own partition (`sessionId`) with
 * `cache_prompt: false`; which slot it lands on is the caller's
 * (`slotId`, see `fusion-format-check.ts`).
 */

import {
  getReasoningTurnFraming,
  reasoningOpenEmittedByModel,
  type ModelProfile,
} from "../model-profile.js";
import type {
  CompletionRequest,
  CompletionResult,
} from "../provider/completion-types.js";
import { reasoningBudgetChars } from "../reasoning-budget.js";
import {
  thinkingDisabledOnBuiltPrompt,
  type ServerTemplatePolicy,
  type ThinkingSetting,
} from "../server-template-policy.js";
import { buildGrammarForTools } from "./build-grammar.js";
import { withReasoningBudget, withoutReasoningPrelude } from "./reasoning-prelude.js";
import { parseToolCalls } from "./tool-call-grammar.js";

/**
 * The check's think bound, in budget tokens (64 characters): short
 * enough that the bound, the close sentinel and a `reply` call fit in
 * {@link GRAMMAR_SMOKE_MAX_TOKENS}.
 */
export const GRAMMAR_SMOKE_THINK_TOKENS = 16;

/**
 * Room for a think cut at {@link GRAMMAR_SMOKE_THINK_TOKENS}, its close
 * sentinel and `[{"tool":"reply","args":{"text":"ok"}}]`, with slack.
 */
export const GRAMMAR_SMOKE_MAX_TOKENS = 96;

/**
 * The whole check's budget. The prompt is under a hundred tokens, so an
 * idle server answers well inside it. A server that does not is busy or
 * stuck, and waiting longer only delays the fan-out's approval prompt:
 * the check ends without a verdict and the dispatch's own deadlines
 * apply.
 */
export const GRAMMAR_SMOKE_TIMEOUT_MS = 10_000;

/** The tool the check asks for; always in the grammar. */
export const GRAMMAR_SMOKE_TOOL = "reply";

export const GRAMMAR_SMOKE_SYSTEM =
  "You are taking a format check. Answer with exactly one tool call and nothing else.";
export const GRAMMAR_SMOKE_INSTRUCTION =
  'Call the `reply` tool once, with the text "ok".';

/** The partition the check's request is filed under; never a real session. */
export const GRAMMAR_SMOKE_SESSION_PREFIX = "grammar-smoke:";

/** Words the failure breaker classifies as a tool-protocol blocker. */
export const GRAMMAR_SMOKE_MISMATCH = "tool-call protocol mismatch";

export type GrammarSmokeVerdict =
  | { kind: "pass" }
  /**
   * `error` starts with {@link GRAMMAR_SMOKE_MISMATCH}; `cause` says
   * which of the two definite failures it was.
   */
  | { kind: "fail"; cause: "grammar-rejected" | "reply-unparsed"; error: string }
  | {
      kind: "inconclusive";
      reason: "timeout" | "cancelled" | "truncated" | "unreachable";
      detail: string;
    };

export interface GrammarSmokeInput {
  profile: ModelProfile;
  /** The runtime's base grammar (the one every step narrows per request). */
  baseGrammar: string;
  /** `resolveServerTemplatePolicy(localModels, profile)`, as the step reads it. */
  serverTemplate: Pick<ServerTemplatePolicy, "useServerTemplate" | "enableThinking">;
  /** `localModels.thinking`; defaults to `auto`. */
  thinking?: ThinkingSetting;
  /**
   * The worker step's tool names (`workerStepToolNames`); `reply` is
   * always added. Absent: `reply` alone.
   */
  toolNames?: readonly string[];
  /** One unary completion on the leg's provider. */
  complete: (request: CompletionRequest) => Promise<CompletionResult>;
  /** The caller's cancellation; an abort ends the check as `cancelled`. */
  signal?: AbortSignal;
  /** Defaults to {@link GRAMMAR_SMOKE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Suffix for the request's partition, e.g. the leg's provider id. */
  partition?: string;
}

type RequestInput = Pick<
  GrammarSmokeInput,
  "profile" | "baseGrammar" | "serverTemplate" | "thinking" | "toolNames" | "partition"
>;

/** Thinking off on the built prompt: the step's own rule (F49). */
export function grammarSmokeThinkingOff(
  input: Pick<GrammarSmokeInput, "profile" | "serverTemplate" | "thinking">,
): boolean {
  return (
    !input.serverTemplate.useServerTemplate &&
    thinkingDisabledOnBuiltPrompt(input.thinking ?? "auto", input.profile)
  );
}

/** The request the check sends, without its signal. */
export function buildGrammarSmokeRequest(input: RequestInput): CompletionRequest {
  const { profile } = input;
  const thinkingOff = grammarSmokeThinkingOff(input);
  const plain = `${GRAMMAR_SMOKE_SYSTEM}\n\n${GRAMMAR_SMOKE_INSTRUCTION}`;
  const framing = getReasoningTurnFraming(profile);
  const reasons = profile.reasoningStyle !== "none";
  // How the built prompt ends (`build-prompt.ts`): Gemma's turn framing
  // with its system token inside the system turn; else the template's
  // disabled marker under thinking off, or the open-tag prefill.
  const raw = framing
    ? `${framing.systemOpen}${reasons && profile.reasoningSystemToken !== undefined ? profile.reasoningSystemToken : ""}${plain}${framing.turnClose}${framing.assistantOpen}`
    : reasons && profile.requiresPromptThinkPrefix
      ? thinkingOff
        ? `${plain}\n${profile.promptThinkingDisabledMarker ?? ""}`
        : `${plain}\n${profile.reasoningOpenTag.trimEnd()}\n`
      : plain;
  const base = thinkingOff
    ? withoutReasoningPrelude(input.baseGrammar)
    : withReasoningBudget(input.baseGrammar, reasoningBudgetChars(GRAMMAR_SMOKE_THINK_TOKENS));
  const enableThinking = input.serverTemplate.enableThinking;
  return {
    prompt: input.serverTemplate.useServerTemplate ? plain : raw,
    ...(input.serverTemplate.useServerTemplate
      ? {
          chat: {
            system: GRAMMAR_SMOKE_SYSTEM,
            user: GRAMMAR_SMOKE_INSTRUCTION,
            prefixHash: "grammar-smoke",
            ...(enableThinking === undefined ? {} : { enableThinking }),
          },
        }
      : {}),
    grammar: buildGrammarForTools(base, input.toolNames ?? [GRAMMAR_SMOKE_TOOL]),
    slotId: -1,
    cachePrompt: false,
    temperature: 0,
    maxTokens: GRAMMAR_SMOKE_MAX_TOKENS,
    maxOutputTokens: GRAMMAR_SMOKE_MAX_TOKENS,
    sessionId: `${GRAMMAR_SMOKE_SESSION_PREFIX}${input.partition ?? "local"}`,
  };
}

/** What a completion that came back says about the format. */
export function judgeGrammarSmokeCompletion(
  completion: Pick<CompletionResult, "content" | "truncated" | "finishReason" | "stopType">,
  profile: ModelProfile,
  options: { thinkingOff?: boolean } = {},
): GrammarSmokeVerdict {
  const content = typeof completion.content === "string" ? completion.content : "";
  const reasons = profile.reasoningStyle !== "none";
  const tags = reasons ? { openTag: profile.reasoningOpenTag, closeTag: profile.reasoningCloseTag } : {};
  // A grammar completion starts mid-think when the prompt prefilled the
  // open tag (`completionAssumesOpenReasoning`, `normalizeContent`).
  const reopen =
    reasons &&
    profile.requiresPromptThinkPrefix &&
    options.thinkingOff !== true &&
    !reasoningOpenEmittedByModel(profile);
  const text = reopen ? `${profile.reasoningOpenTag}${content}` : content;
  let parseError: string;
  try {
    const batch = parseToolCalls(text, tags, { repairJson: true });
    if (batch.calls.length > 0) return { kind: "pass" };
    parseError = "the reply carried no tool call";
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  // A reply that did not finish on its own may be a fine call cut short.
  if (
    completion.truncated === true ||
    completion.finishReason === "length" ||
    completion.stopType === "limit"
  ) {
    return {
      kind: "inconclusive",
      reason: "truncated",
      detail: `the check's reply reached its ${GRAMMAR_SMOKE_MAX_TOKENS}-token cap before it closed`,
    };
  }
  if (completion.stopType === "word") {
    return { kind: "inconclusive", reason: "truncated", detail: "the check's reply stopped on a stop word" };
  }
  return {
    kind: "fail",
    cause: "reply-unparsed",
    error: `${GRAMMAR_SMOKE_MISMATCH}: the reply under the workers' grammar did not parse: ${parseError} (reply began ${JSON.stringify(content.slice(0, 80))})`,
  };
}

/** Run the check once. Never throws. */
export async function runGrammarSmoke(input: GrammarSmokeInput): Promise<GrammarSmokeVerdict> {
  const timeoutMs = input.timeoutMs ?? GRAMMAR_SMOKE_TIMEOUT_MS;
  if (input.signal?.aborted) {
    return { kind: "inconclusive", reason: "cancelled", detail: "cancelled before the check was sent" };
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref?.();
  const signal =
    input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
  try {
    const completion = await input.complete({
      ...buildGrammarSmokeRequest(input),
      signal,
      // Our deadline is the check's; the provider's own timer must not cut it first.
      requestTimeoutMs: timeoutMs + 1_000,
    });
    if (input.signal?.aborted) {
      return { kind: "inconclusive", reason: "cancelled", detail: "cancelled while the check ran" };
    }
    return judgeGrammarSmokeCompletion(completion, input.profile, {
      thinkingOff: grammarSmokeThinkingOff(input),
    });
  } catch (err) {
    if (input.signal?.aborted) {
      return { kind: "inconclusive", reason: "cancelled", detail: "cancelled while the check ran" };
    }
    if (deadline.signal.aborted) {
      return {
        kind: "inconclusive",
        reason: "timeout",
        detail: `no answer within ${Math.round(timeoutMs / 1000)} s`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    // The server refused the grammar itself: no worker could run there.
    if (isClientError(err) && /grammar/i.test(message)) {
      return {
        kind: "fail",
        cause: "grammar-rejected",
        error: `${GRAMMAR_SMOKE_MISMATCH}: the local server rejected the workers' grammar (${message.slice(0, 160)})`,
      };
    }
    return { kind: "inconclusive", reason: "unreachable", detail: message.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function isClientError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}
