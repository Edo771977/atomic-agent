import {
  isStoppedTurnMarker,
  type ConversationTurn,
} from "../session/conversation-turn.js";

/**
 * The operator's request stays in view across repairs.
 *
 * The packer keeps the last user turn and the current task's opening
 * turn; an earlier task's request can be dropped. During a repair that
 * is exactly the turn that carried the spec — "four older turns were
 * dropped, including the user message" — and the model then repaired
 * against a summary line. The runtime already records the request per
 * turn for the workers' briefs (`pickOriginalRequest`); this renders
 * the same record as `### request`, immediately before
 * `### conversation`, only when the packer has dropped the user turn
 * that carried it. While the carrier is in view it costs nothing.
 */

/**
 * How much of the operator's request a local worker's brief quotes
 * (`worker-prompt.ts`, ~1.5K tokens). Here so the orchestrator's
 * `### fusion` block can name it.
 */
export const LOCAL_WORKER_REQUEST_CHAR_BUDGET = 6_000;

/** Same 16,000-char clip as a cloud worker's quoted request (`worker-prompt.ts`). */
export const REQUEST_SECTION_CHAR_BUDGET = 16_000;

/**
 * The line `pickOriginalRequest` puts between the previous user message
 * and a short follow-up that started the turn. Split on it to find the
 * turn that actually carried the request.
 */
export const REQUEST_FOLLOW_UP_MARKER =
  "[the operator's latest message, which started this turn]";

/**
 * The lines a worker's brief quotes the operator's request between
 * (`worker-prompt.ts`). A worker's own pinned request is its whole brief
 * — the brief is the message that started its turn — so the block
 * between these is where the operator's words are in it.
 */
export const ORIGINAL_REQUEST_BEGIN_MARKER = "----- BEGIN ORIGINAL REQUEST -----";
export const ORIGINAL_REQUEST_END_MARKER = "----- END ORIGINAL REQUEST -----";

/**
 * `text` with every copy of the two markers defused, for anything a
 * brief carries other than the markers themselves: the orchestrator's
 * task, instructions, contract (a `shape`), and the quoted request. The
 * brief's own markers are then the only ones in it, so the first BEGIN
 * and the first END after it (`quotedRequestText`, the `### request`
 * clip) are the real quote's. Otherwise a marker in the instructions,
 * which come before the quote, would move the block's start: the
 * orchestrator's words read as the operator's (consent to replace an
 * input), and a clip cutting the rules instead of the quote.
 */
export function neutraliseRequestMarkers(text: string): string {
  return text
    .replaceAll(ORIGINAL_REQUEST_BEGIN_MARKER, "[begin original request]")
    .replaceAll(ORIGINAL_REQUEST_END_MARKER, "[end original request]");
}

/**
 * The operator's words in a pinned request: the quoted block when the
 * text is a worker's brief, the text itself otherwise. What the input
 * guard (`fs-input-guard.ts`) reads, so a file a task's instructions
 * name as an output is not mistaken for one the operator provided.
 */
export function quotedRequestText(request: string): string {
  const begin = request.indexOf(ORIGINAL_REQUEST_BEGIN_MARKER);
  if (begin === -1) return request;
  const start = begin + ORIGINAL_REQUEST_BEGIN_MARKER.length;
  const end = request.indexOf(ORIGINAL_REQUEST_END_MARKER, start);
  return end === -1 ? request.slice(start) : request.slice(start, end);
}

/**
 * What a worker turn records as its request when its brief has no
 * ORIGINAL REQUEST block (a fan-out started with no operator message on
 * record). Without the block the brief is the orchestrator's words
 * only, so nothing in it may stand for the operator agreeing to a
 * replacement (ATO-860): the input guard still reads it for the files
 * it names, never for consent.
 */
export const NO_OPERATOR_WORDS_MARKER =
  "[a worker brief without an ORIGINAL REQUEST block: no operator words]";

/**
 * The record `executeTurn` keeps for a worker turn, from its brief.
 *
 * `operatorRequest` is the request the brief quotes, unclipped
 * (`FusionWorkerMeta.operatorRequest`): a local brief quotes only its
 * head, so a file named past the cap would be missing from the quote
 * and lose the input guard's refusal. With it, the record's ORIGINAL
 * REQUEST block holds the whole request; the rest of the brief is kept.
 */
export function workerRequestRecord(
  brief: string,
  operatorRequest?: string,
): string {
  const begin = brief.indexOf(ORIGINAL_REQUEST_BEGIN_MARKER);
  if (begin === -1) return `${NO_OPERATOR_WORDS_MARKER}\n${brief}`;
  const full = neutraliseRequestMarkers(operatorRequest?.trim() ?? "");
  if (full.length === 0) return brief;
  const start = begin + ORIGINAL_REQUEST_BEGIN_MARKER.length;
  const end = brief.indexOf(ORIGINAL_REQUEST_END_MARKER, start);
  return end === -1
    ? `${brief.slice(0, start)}\n${full}\n${ORIGINAL_REQUEST_END_MARKER}`
    : `${brief.slice(0, start)}\n${full}\n${brief.slice(end)}`;
}

/**
 * The two readings of a pinned request the input guard needs: `names`,
 * the text whose file names are inputs, and `consent`, the operator's
 * own words that may ask for one to be replaced. The same text, except
 * for a worker brief without a quoted request (`workerRequestRecord`):
 * its names still count, its words do not.
 */
export function requestWords(request: string): {
  names: string;
  consent: string;
} {
  if (request.startsWith(NO_OPERATOR_WORDS_MARKER)) {
    return { names: request.slice(NO_OPERATOR_WORDS_MARKER.length), consent: "" };
  }
  const quoted = quotedRequestText(request);
  return { names: quoted, consent: quoted };
}

/**
 * The agent's last reply before the user's message that starts this
 * turn, when that message answers it: the final `assistant_reply` of the
 * previous macro-turn, read back past its tool rows. Nothing when a user
 * row comes first (two user messages in a row), when the previous turn
 * was stopped, or for an interim progress note. The input guard reads
 * it to see which file the agent asked about replacing (ATO-860).
 */
export function previousReplyText(
  earlierTurns: readonly ConversationTurn[],
): string | undefined {
  for (let i = earlierTurns.length - 1; i >= 0; i -= 1) {
    const turn = earlierTurns[i]!;
    if (turn.kind === "user") return undefined;
    if (turn.kind !== "assistant_reply" || turn.progressNote === true) continue;
    if (isStoppedTurnMarker(turn)) return undefined;
    const text = turn.text.trim();
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}

/**
 * The user-turn text the request was taken from: the message before a
 * short follow-up when the record combines two, else the record itself.
 */
export function requestCarrierText(request: string): string {
  const marker = `\n\n${REQUEST_FOLLOW_UP_MARKER}\n`;
  const at = request.indexOf(marker);
  return (at === -1 ? request : request.slice(0, at)).trim();
}

/** Whether the turn that carried `request` is among `visibleTurns`. */
export function requestInView(
  request: string,
  visibleTurns: readonly ConversationTurn[],
): boolean {
  const carrier = requestCarrierText(request);
  if (carrier.length === 0) return true;
  return visibleTurns.some(
    (turn) => turn.kind === "user" && turn.text.trim() === carrier,
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The note a worker brief puts right after a clipped quote
 * (`worker-prompt.ts`). Here so `### request` can find it and replace
 * it when it cuts the quote further.
 */
export function quotedRequestTruncationNote(total: number, quoted: number): string {
  return `(truncated: the original request is ${formatCount(total)} chars; only the first ${formatCount(quoted)} are quoted above.)`;
}

/** {@link quotedRequestTruncationNote} on the line after the END marker. */
const BRIEF_TRUNCATION_NOTE =
  /\n\(truncated: the original request is ([\d,]+) chars; only the first [\d,]+ are quoted above\.\)/y;

/**
 * A worker brief over the budget, clipped inside its quoted ORIGINAL
 * REQUEST block: the task, rules and closing reminder around the block
 * are the worker's own instructions and are kept whole. `null` when the
 * text has no complete block, or when what surrounds the block alone is
 * over the budget (then the plain head clip applies: the brief puts the
 * task first, so the head is the part to keep).
 *
 * A brief that already clipped its quote says so after the END marker
 * ("only the first 16,000 are quoted"); that note is taken out, since
 * it no longer holds, and its count of the whole request kept, so the
 * section's one note says how long the request is and how much of it
 * is still quoted.
 */
function clipQuotedRequest(
  text: string,
  budget: number,
): { text: string; total: number; quoted: number } | null {
  const begin = text.indexOf(ORIGINAL_REQUEST_BEGIN_MARKER);
  if (begin === -1) return null;
  const start = begin + ORIGINAL_REQUEST_BEGIN_MARKER.length;
  const end = text.indexOf(ORIGINAL_REQUEST_END_MARKER, start);
  if (end === -1) return null;
  const head = text.slice(0, start);
  const afterEnd = end + ORIGINAL_REQUEST_END_MARKER.length;
  BRIEF_TRUNCATION_NOTE.lastIndex = afterEnd;
  const briefNote = BRIEF_TRUNCATION_NOTE.exec(text);
  const tail =
    briefNote === null
      ? text.slice(end)
      : `${ORIGINAL_REQUEST_END_MARKER}${text.slice(afterEnd + briefNote[0].length)}`;
  const room = budget - head.length - tail.length;
  if (room < 0) return null;
  const quote = text.slice(start, end);
  const kept = quote.slice(0, room);
  const total =
    briefNote === null
      ? quote.trim().length
      : Number(briefNote[1]!.replaceAll(",", ""));
  return { text: `${head}${kept}${tail}`, total, quoted: kept.trim().length };
}

/** The `### request` body: the record, clipped, with a one-line frame. */
export function renderRequestSection(request: string): string {
  const text = request.trim();
  const quotedClip =
    text.length > REQUEST_SECTION_CHAR_BUDGET
      ? clipQuotedRequest(text, REQUEST_SECTION_CHAR_BUDGET)
      : null;
  const clipped =
    quotedClip?.text ??
    (text.length > REQUEST_SECTION_CHAR_BUDGET
      ? text.slice(0, REQUEST_SECTION_CHAR_BUDGET)
      : text);
  const lines = [
    "The operator's request that started this task. The turn that carried it has been dropped from the conversation below; this is what the work must still satisfy.",
    clipped,
  ];
  if (quotedClip !== null) {
    lines.push(
      `(truncated: the original request is ${formatCount(quotedClip.total)} chars; only the first ${formatCount(quotedClip.quoted)} are quoted above; the task and rules are whole.)`,
    );
  } else if (clipped.length < text.length) {
    lines.push(
      `(truncated: the request is ${formatCount(text.length)} chars; only the first ${formatCount(REQUEST_SECTION_CHAR_BUDGET)} are shown.)`,
    );
  }
  return lines.join("\n");
}
