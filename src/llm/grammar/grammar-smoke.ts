/**
 * One cheap completion that says whether a local server and model can
 * produce the agent's tool-call format at all, before a fusion fan-out
 * sends workers there.
 *
 * The field case behind it: a worker leg whose model (or server) did not
 * fit the tool-call protocol was only found out after a worker had run —
 * the failure breaker's "protocol mismatch" trips on the first such row,
 * but that row had already spent the worker's time. This asks the same
 * question with a few dozen tokens instead.
 *
 * What is sent is the workers' own per-request grammar in its
 * thinking-off variant: the base grammar without its reasoning prelude
 * (`withoutReasoningPrelude`), narrowed to `reply`
 * (`buildGrammarForTools`), with the prompt framed the way context
 * compaction frames its own thinking-off call — the profile's turn
 * framing, or its disabled-thinking marker, or the server's template
 * with `enable_thinking: false`. The answer is read with the step's own
 * final parser (`parseToolCalls`, the profile's reasoning tags, JSON
 * repair on), so profile, grammar and parser agree exactly as on a
 * worker step. The prompt lives on its own partition (`sessionId`),
 * slot `-1` and `cache_prompt: false`: no session's cached prefix is
 * touched.
 *
 * Only a completion that came back and does not parse — or a server that
 * rejected the grammar — is a failure. A timeout, a cancel, a reply cut
 * at the token cap or a server that could not be reached says nothing
 * about the format and is `inconclusive`: the caller dispatches as
 * before and other checks (local-leg health, the breaker) apply.
 */

import {
  getReasoningTurnFraming,
  type ModelProfile,
} from "../model-profile.js";
import type {
  CompletionRequest,
  CompletionResult,
} from "../provider/completion-types.js";
import { buildGrammarForTools } from "./build-grammar.js";
import { withoutReasoningPrelude } from "./reasoning-prelude.js";
import { parseToolCalls } from "./tool-call-grammar.js";

/** Room for `[{"tool":"reply","args":{"text":"ok"}}]` and a little slack. */
export const GRAMMAR_SMOKE_MAX_TOKENS = 48;

/**
 * The whole check's budget. The prompt is under a hundred tokens, so an
 * idle server answers well inside it. A server that does not is busy or
 * stuck, and waiting longer only delays the fan-out's approval prompt:
 * the check ends without a verdict and the dispatch's own deadlines
 * apply.
 */
export const GRAMMAR_SMOKE_TIMEOUT_MS = 10_000;

/** The one tool the check's grammar admits. */
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
  /** `error` starts with {@link GRAMMAR_SMOKE_MISMATCH}. */
  | { kind: "fail"; error: string }
  | {
      kind: "inconclusive";
      reason: "timeout" | "cancelled" | "truncated" | "unreachable";
      detail: string;
    };

export interface GrammarSmokeInput {
  profile: ModelProfile;
  /** The runtime's base grammar (the one every step narrows per request). */
  baseGrammar: string;
  /** `resolveServerTemplatePolicy(...).useServerTemplate` for this profile. */
  serverTemplate: boolean;
  /** One unary completion on the leg's provider. */
  complete: (request: CompletionRequest) => Promise<CompletionResult>;
  /** The caller's cancellation; an abort ends the check as `cancelled`. */
  signal?: AbortSignal;
  /** Defaults to {@link GRAMMAR_SMOKE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Suffix for the request's partition, e.g. the leg's provider id. */
  partition?: string;
}

/** The request the check sends, without its signal. */
export function buildGrammarSmokeRequest(
  input: Pick<GrammarSmokeInput, "profile" | "baseGrammar" | "serverTemplate" | "partition">,
): CompletionRequest {
  const { profile } = input;
  const plain = `${GRAMMAR_SMOKE_SYSTEM}\n\n${GRAMMAR_SMOKE_INSTRUCTION}`;
  const framing = getReasoningTurnFraming(profile);
  const raw = framing
    ? `${framing.systemOpen}${plain}${framing.turnClose}${framing.assistantOpen}`
    : `${plain}${profile.reasoningStyle !== "none" ? (profile.promptThinkingDisabledMarker ?? "") : ""}`;
  return {
    prompt: input.serverTemplate ? plain : raw,
    ...(input.serverTemplate
      ? {
          chat: {
            system: GRAMMAR_SMOKE_SYSTEM,
            user: GRAMMAR_SMOKE_INSTRUCTION,
            prefixHash: "grammar-smoke",
            enableThinking: false,
          },
        }
      : {}),
    grammar: buildGrammarForTools(withoutReasoningPrelude(input.baseGrammar), [GRAMMAR_SMOKE_TOOL]),
    slotId: -1,
    cachePrompt: false,
    temperature: 0,
    maxTokens: GRAMMAR_SMOKE_MAX_TOKENS,
    maxOutputTokens: GRAMMAR_SMOKE_MAX_TOKENS,
    disableThinking: true,
    sessionId: `${GRAMMAR_SMOKE_SESSION_PREFIX}${input.partition ?? "local"}`,
  };
}

/** What a completion that came back says about the format. */
export function judgeGrammarSmokeCompletion(
  completion: Pick<CompletionResult, "content" | "truncated" | "finishReason" | "stopType">,
  profile: ModelProfile,
): GrammarSmokeVerdict {
  const content = typeof completion.content === "string" ? completion.content : "";
  const tags =
    profile.reasoningStyle === "none"
      ? {}
      : { openTag: profile.reasoningOpenTag, closeTag: profile.reasoningCloseTag };
  try {
    const batch = parseToolCalls(content, tags, { repairJson: true });
    if (batch.calls.length > 0) return { kind: "pass" };
  } catch (err) {
    // A reply cut at the cap may be a fine call that ran long: no verdict.
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
    return {
      kind: "fail",
      error: `${GRAMMAR_SMOKE_MISMATCH}: ${err instanceof Error ? err.message : String(err)} (reply began ${JSON.stringify(content.slice(0, 80))})`,
    };
  }
  return { kind: "fail", error: `${GRAMMAR_SMOKE_MISMATCH}: the reply carried no tool call` };
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
    return judgeGrammarSmokeCompletion(completion, input.profile);
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
        error: `${GRAMMAR_SMOKE_MISMATCH}: the local server rejected the tool-call grammar (${message.slice(0, 160)})`,
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
