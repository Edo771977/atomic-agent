/**
 * ATO-321. Recall-time name check for notes and lessons.
 *
 * `name-grounding.ts` keeps a profile name nobody typed out of the
 * prompt, but a note or lesson that says the same thing ("I am Alex",
 * "The user is Alex", "Пользователь Анна") still reached `### recalled`,
 * `### memory-index` and `### lessons`. Field case: notes left by old QA
 * runs on one machine, for a user who never wrote "Alex".
 *
 * This guard applies the same rule to those surfaces: a row that claims
 * a name for the user stays out of the prompt unless some stored user
 * message carries that name. Rows are never changed or deleted; they
 * stay readable by id (`memory.notes.recall { id }`) and in the memory
 * view.
 *
 *   - Verdicts are cached in memory per name (lower-cased) for the life
 *     of the process. A name the user types later in the same process
 *     is picked up on that turn: `noteUserMessagesTo` (the outermost
 *     memory context provider) hands the turn's own user message — not
 *     the rewriter's model-written query — to `noteUserMessage`, which turns a cached
 *     `ungrounded` verdict the message carries into `grounded` (same
 *     matcher as the store scan, no re-walk), drops `failed` verdicts so
 *     they are re-checked, and is consulted when a running check
 *     settles, so a check that started before the message cannot cache
 *     a stale `ungrounded`.
 *   - `grounded` and `unverifiable` (another script, nothing to compare)
 *     let the row through — the same "a name we cannot compare fails
 *     open" rule as reflection.
 *   - A name not checked yet holds the row out and starts a background
 *     check (one per name), so the next turn has the verdict. The boot
 *     `prefetch` checks the names in recent notes and active lessons
 *     before the first turn usually needs them.
 *   - A check that throws holds the row out until the next user
 *     message, then is retried.
 *
 * Rows that claim no name — nearly all of them — cost one regex pass.
 * Logs carry counts only, never names.
 */

import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../agent/agent-contract.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

import {
  nameGroundingAcrossSessions,
  type GroundingConversationSource,
} from "./name-grounding.js";
import type { NameGroundingStatus } from "./profile-name-keys.js";
import {
  claimedUserNames,
  nameGroundingIn,
  type ScriptLetterCounts,
} from "./reflection/reflection-grounding.js";

type Verdict = NameGroundingStatus | "failed";

/** User messages noted this process that a settling check consults. */
const MAX_NOTED_MESSAGES = 64;

/** Compare as Latin / Cyrillic, as the store scan does per conversation. */
const COMPARABLE: ScriptLetterCounts = { other: 0, comparable: 1 };

export interface RecallNameGuard {
  /** Whether a row with this text may be rendered into the prompt. */
  allows(text: string): boolean;
  /**
   * The user just wrote `text` (a real turn's message). Names it carries
   * count as grounded from now on, and failed checks are retried.
   * Optional so a plain `allows` stub stays a valid guard.
   */
  noteUserMessage?(text: string): void;
}

export interface RecallNameGuardHandle extends RecallNameGuard {
  noteUserMessage(text: string): void;
  /** Check every name these texts claim. Resolves when all are known. */
  prefetch(texts: Iterable<string>): Promise<RecallNamePrefetchReport>;
}

export interface RecallNamePrefetchReport {
  names: number;
  grounded: number;
  ungrounded: number;
  unverifiable: number;
  failed: number;
}

export function createRecallNameGuard(args: {
  source: GroundingConversationSource;
  logger?: StructuredLogger;
}): RecallNameGuardHandle {
  const verdicts = new Map<string, Verdict>();
  const inFlight = new Map<string, Promise<Verdict>>();
  /** Original spelling per lower-cased key, for re-matching. */
  const spelled = new Map<string, string>();
  const noted: string[] = [];

  const groundedByNoted = (name: string, texts: readonly string[]): boolean =>
    texts.length > 0 &&
    nameGroundingIn(name, texts, { letters: COMPARABLE }) === "grounded";

  const check = (name: string): Promise<Verdict> => {
    const key = name.toLowerCase();
    const known = verdicts.get(key);
    if (known !== undefined) return Promise.resolve(known);
    const running = inFlight.get(key);
    if (running) return running;
    spelled.set(key, name);
    const started = nameGroundingAcrossSessions(name, args.source)
      .then(
        (verdict): Verdict => verdict,
        (err: unknown): Verdict => {
          args.logger?.warn("recall name check failed; the row stays out of the prompt", {
            error: err instanceof Error ? err.message : String(err),
          });
          return "failed";
        },
      )
      .then((scanned): Verdict => {
        inFlight.delete(key);
        // A message noted while the scan ran may carry the name.
        const verdict: Verdict =
          scanned !== "grounded" && groundedByNoted(name, noted) ? "grounded" : scanned;
        verdicts.set(key, verdict);
        return verdict;
      });
    inFlight.set(key, started);
    return started;
  };

  return {
    allows(text) {
      const names = claimedUserNames(text);
      if (names.length === 0) return true;
      let allowed = true;
      for (const name of names) {
        const verdict = verdicts.get(name.toLowerCase());
        if (verdict === "grounded" || verdict === "unverifiable") continue;
        allowed = false;
        // Not checked yet: start the check, hold the row out this turn.
        if (verdict === undefined) void check(name);
      }
      return allowed;
    },
    noteUserMessage(text) {
      if (text.trim().length === 0) return;
      noted.push(text);
      if (noted.length > MAX_NOTED_MESSAGES) noted.shift();
      for (const [key, verdict] of verdicts) {
        if (verdict !== "ungrounded" && verdict !== "failed") continue;
        if (groundedByNoted(spelled.get(key) ?? key, [text])) {
          verdicts.set(key, "grounded");
        } else if (verdict === "failed") {
          // Re-checked by the next `allows` / `prefetch`.
          verdicts.delete(key);
        }
      }
    },
    async prefetch(texts) {
      const names = new Map<string, string>();
      for (const text of texts) {
        for (const name of claimedUserNames(text)) {
          names.set(name.toLowerCase(), name);
        }
      }
      const report: RecallNamePrefetchReport = {
        names: names.size,
        grounded: 0,
        ungrounded: 0,
        unverifiable: 0,
        failed: 0,
      };
      for (const name of names.values()) {
        report[await check(name)] += 1;
      }
      if (report.names > 0) {
        args.logger?.info("note and lesson names checked against the user's messages", {
          names: report.names,
          grounded: report.grounded,
          ungrounded: report.ungrounded,
          unverifiable: report.unverifiable,
          failed: report.failed,
        });
      }
      return report;
    },
  };
}

/**
 * ATO-321. Wrap the OUTERMOST memory context provider so the guard sees
 * each real turn's user message before any row is filtered. Outermost
 * because the query rewriter replaces `userMessage` with model-written
 * text for the inner providers, and only the user's own words may
 * ground a name. A guard that throws never takes recall down.
 */
export function noteUserMessagesTo(
  guard: RecallNameGuard,
  inner: MemoryContextProvider,
): MemoryContextProvider {
  return {
    async buildMemoryContext(input: MemoryContextProviderInput): Promise<MemoryContext> {
      if (input.userMessage) {
        try {
          guard.noteUserMessage?.(input.userMessage);
        } catch {
          // Fail open, like the provider's own guard calls.
        }
      }
      return inner.buildMemoryContext(input);
    },
  };
}
