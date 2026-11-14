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
export interface InterruptedTurns {
  pending(sessionId: string): InterruptedChatTurn | null;
  resumeMessage(sessionId: string): string | null;
  /**
   * The continuing message was dropped before its turn started: offer
   * the turn again. With `dropped`, only when one of those strings is
   * exactly the message `resumeMessage` handed out (a note-led resend or
   * a Fusion run's resume text alike); without it, unconditionally.
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

/**
 * A cut-off Fusion orchestrator turn is continued from its run's
 * checkpoints, not by re-sending its request: that would start a fresh
 * fan-out, paying the workers again and ignoring what they finished.
 * When the session has a resumable run written during the cut-off turn
 * (`updatedAt` at or after the turn's start), `resumeMessage` returns
 * that run's resume message — the same one `/fusion resume` sends.
 */
export function createInterruptedTurns(
  store: Pick<SessionStore, "load" | "readTurnProgress">,
  fusionRuns?: ResumableFusionRuns,
): InterruptedTurns {
  const fusionResumeFor = (sessionId: string, turn: InterruptedChatTurn): string | null => {
    if (fusionRuns === undefined) return null;
    try {
      const run = fusionRuns
        .listResumable(sessionId)
        .find((r) => r.updatedAt >= turn.startedAt);
      return run === undefined ? null : fusionRuns.resumeMessage(sessionId, run.runId);
    } catch {
      // Unreadable checkpoints: fall back to re-sending the request.
      return null;
    }
  };
  /** Session id -> the cut-off turn a resume is queued for, and its exact text. */
  const queued = new Map<string, { startedAt: number; text: string }>();
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
  return {
    pending,
    resumeMessage(sessionId) {
      const turn = pending(sessionId);
      if (turn === null) return null;
      const message = fusionResumeFor(sessionId, turn) ?? interruptedTurnResumeMessage(turn);
      queued.set(sessionId, { startedAt: turn.startedAt, text: message });
      return message;
    },
    release(sessionId, dropped) {
      const entry = queued.get(sessionId);
      if (entry === undefined) return;
      if (dropped === undefined || dropped.includes(entry.text)) queued.delete(sessionId);
    },
  };
}
