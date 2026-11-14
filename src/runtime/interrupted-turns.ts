import {
  interruptedChatTurn,
  interruptedTurnResumeMessage,
  type InterruptedChatTurn,
} from "../session/interrupted-chat-turn.js";
import type { SessionStore } from "../session/session-store.js";

/**
 * The runtime's side of continuing a chat turn a restart cut off
 * (ATO-448), shared by every frontend: the TUI's `/resume`, and the
 * desktop or an HTTP client when they offer the same.
 *
 * Never continues a turn on its own. `pending` says whether there is
 * one; `resumeMessage` hands back the message of the turn that
 * continues it and marks it "resume queued", so a second call says
 * there is nothing to resume. The caller sends that message as the
 * person's turn through `runTurn`, like any other.
 *
 * The progress marker itself is not dropped here: the continuing turn
 * replaces it when it really starts (`SessionStore.beginTurn`). Until
 * then the "queued" mark lives only in memory, so a message that never
 * runs (the person cleared the queue, stopped the run, switched away)
 * is given back with `release`, and a process that quits first leaves
 * the turn offered at the next start.
 */
/**
 * What a resume request gets back: the message to send, or a line saying
 * a resume of the same turn or Fusion run is already queued (so a second
 * one is not sent beside it).
 */
export type ResumeOffer = { text: string } | { alreadyQueued: string };

export interface InterruptedTurns {
  pending(sessionId: string): InterruptedChatTurn | null;
  /** `resume`'s text, or `null` when there is none or one is already queued. */
  resumeMessage(sessionId: string): string | null;
  /** `/resume`: the cut-off turn's continuing message, marked queued. */
  resume(sessionId: string): ResumeOffer | null;
  /**
   * `/fusion resume`: a resumable run's message (the newest without
   * `runId`), marked queued under the same mark `/resume` uses for a
   * cut-off Fusion turn, so the two never queue one run twice.
   */
  fusionResume(sessionId: string, runId?: string): ResumeOffer | null;
  /**
   * The continuing message was dropped before its turn started: offer
   * the turn (or run) again. With `dropped`, only the marks whose exact
   * text is one of those strings (a note-led resend or a Fusion run's
   * resume text alike); without it, every mark of the session.
   */
  release(sessionId: string, dropped?: readonly string[]): void;
}

/**
 * The slice of `AgentRuntime.fusionRuns` a resume needs (structural,
 * so this module does not import the runtime contract).
 */
export interface ResumableFusionRuns {
  listResumable(sessionId: string): readonly { runId: string; updatedAt: number }[];
  resumeMessage(sessionId: string, runId?: string): string | null;
}

const runQueuedLine = (runId: string): string =>
  `a resume of fusion run ${runId} is already queued; it runs when the current turn ends`;
const TURN_QUEUED_LINE = "a resume of the cut-off turn is already queued; it runs when the current turn ends";

/**
 * A cut-off Fusion orchestrator turn is continued from its run's
 * checkpoints, not by re-sending its request: that would start a fresh
 * fan-out, paying the workers again and ignoring what they finished.
 * When the session has a resumable run written during the cut-off turn
 * (`updatedAt` at or after the turn's start), `resume` returns that
 * run's resume message — the same one `/fusion resume` sends, under the
 * same queued mark. A run mark holds while the run's checkpoint is
 * unchanged: once the resumed run writes it (it started), the mark is
 * stale and the run is offered again if it is cut off again.
 */
export function createInterruptedTurns(
  store: Pick<SessionStore, "load" | "readTurnProgress">,
  fusionRuns?: ResumableFusionRuns,
): InterruptedTurns {
  const resumableRuns = (sessionId: string): readonly { runId: string; updatedAt: number }[] => {
    if (fusionRuns === undefined) return [];
    try {
      return fusionRuns.listResumable(sessionId);
    } catch {
      // Unreadable checkpoints: fall back to re-sending the request.
      return [];
    }
  };
  /** Session id -> the cut-off turn a resume is queued for, and its exact text. */
  const queued = new Map<string, { startedAt: number; text: string }>();
  /** Session id -> run id -> the run's checkpoint stamp and text when its resume was queued. */
  const queuedRuns = new Map<string, Map<string, { updatedAt: number; text: string }>>();
  const runQueued = (sessionId: string, run: { runId: string; updatedAt: number }): boolean => {
    const marks = queuedRuns.get(sessionId);
    const mark = marks?.get(run.runId);
    if (mark === undefined) return false;
    if (mark.updatedAt === run.updatedAt) return true;
    marks!.delete(run.runId);
    return false;
  };
  const queueRun = (sessionId: string, run: { runId: string; updatedAt: number }): ResumeOffer | null => {
    if (runQueued(sessionId, run)) return { alreadyQueued: runQueuedLine(run.runId) };
    let text: string | null;
    try {
      text = fusionRuns?.resumeMessage(sessionId, run.runId) ?? null;
    } catch {
      text = null;
    }
    if (text === null) return null;
    const marks = queuedRuns.get(sessionId) ?? new Map<string, { updatedAt: number; text: string }>();
    marks.set(run.runId, { updatedAt: run.updatedAt, text });
    queuedRuns.set(sessionId, marks);
    return { text };
  };
  const read = (sessionId: string): InterruptedChatTurn | null => {
    const state = store.load(sessionId);
    if (state === null) return null;
    return interruptedChatTurn(state, store.readTurnProgress(sessionId));
  };
  const pending = (sessionId: string): InterruptedChatTurn | null => {
    const turn = read(sessionId);
    const queuedFor = queued.get(sessionId);
    if (queuedFor === undefined) return turn;
    // Still the same cut-off turn: its resume is queued, not yet started.
    if (turn !== null && turn.startedAt === queuedFor.startedAt) return null;
    // The continuing turn started (it replaced the marker) or the row
    // changed under us: the queued mark has done its job.
    queued.delete(sessionId);
    return turn;
  };
  const resume = (sessionId: string): ResumeOffer | null => {
    const turn = pending(sessionId);
    if (turn === null) {
      return queued.has(sessionId) ? { alreadyQueued: TURN_QUEUED_LINE } : null;
    }
    const run = resumableRuns(sessionId).find((r) => r.updatedAt >= turn.startedAt);
    const offer = run === undefined ? null : queueRun(sessionId, run);
    if (offer !== null && "alreadyQueued" in offer) return offer;
    const text = offer?.text ?? interruptedTurnResumeMessage(turn);
    queued.set(sessionId, { startedAt: turn.startedAt, text });
    return { text };
  };
  return {
    pending,
    resume,
    resumeMessage(sessionId) {
      const offer = resume(sessionId);
      return offer !== null && "text" in offer ? offer.text : null;
    },
    fusionResume(sessionId, runId) {
      const runs = resumableRuns(sessionId);
      const run = runId === undefined ? runs[0] : runs.find((r) => r.runId === runId);
      return run === undefined ? null : queueRun(sessionId, run);
    },
    release(sessionId, dropped) {
      const entry = queued.get(sessionId);
      if (entry !== undefined && (dropped === undefined || dropped.includes(entry.text))) {
        queued.delete(sessionId);
      }
      const marks = queuedRuns.get(sessionId);
      if (marks === undefined) return;
      for (const [runId, mark] of marks) {
        if (dropped === undefined || dropped.includes(mark.text)) marks.delete(runId);
      }
      if (marks.size === 0) queuedRuns.delete(sessionId);
    },
  };
}
