import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

/**
 * Automatic replanning after a fan-out (ATO-941).
 *
 * Until now a failed part ended the planner's turn as often as not: the
 * orchestrator replied with what stood and the person typed "continue"
 * to get the rest. With `llm.runMode.fusion.autoReplan: N` the fan-out's
 * result names every task that did not close, from the facts (its
 * status, its error, its failed checks and judge findings, all already
 * on the row), with how many replans it has left this turn; the loop
 * then holds the planner's next step to `fusion.delegate`
 * (`src/agent/fusion-replan.ts`). A task that used its N replans is
 * listed as exhausted, for the planner to report, not to retry.
 *
 * A replan may keep a task's id or split it into continuation ids
 * (`t3.a`, `t3.b`: the failed id, a dot, a suffix). Continuations count
 * on the task they continue (`FusionTurnBudget.noteRoundAttempts`): one
 * attempt per round for the whole family, and they share its replans,
 * so a split never buys more than the cap. Only an open task has
 * continuations: once a family closed green (`noteRoundOutcomes`), a
 * dotted id after it is new work with its own replans. Each pending task carries
 * the fix its status calls for (`replanFix`).
 */

/** Statuses that leave a task open. `cancelled` only when it was held. */
const OPEN_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  "failed",
  "needs_orchestrator",
  // Open until the orchestrator answers and sends it again (ATO-945).
  "needs_input",
  "no_changes",
  "max_steps",
  "timeout",
  "queued",
]);

export const HELD_FOR_REPLAN = "not started: held for the replan";

/** The fix for a task that stopped to ask (ATO-945). */
export const NEEDS_INPUT_FIX =
  "answer its question in the brief and send it again; if only the person can answer, ask them in your reply";

export interface ReplanTask {
  id: string;
  status: WorkerTaskStatus;
  /** The row's own error, or its status when it has none. */
  why: string;
  /** Replans left after this one is sent back; 0 for an exhausted task. */
  replansLeft: number;
  /** What the next brief should change, when the status says. */
  fix?: string;
}

export interface ReplanReport {
  pending: ReplanTask[];
  exhausted: ReplanTask[];
  /**
   * Still open after two or more runs, one of them on the orchestrator's
   * model this turn: past what another round fixes, so reported to the
   * person like an exhausted task, whatever replans are left.
   */
  failedOnOrchestrator: ReplanTask[];
  max: number;
}

/** Whether a row leaves its task open: for the planner to replan or report. */
export function isOpenResult(result: WorkerTaskResult): boolean {
  if (OPEN_STATUSES.has(result.status)) return true;
  return (
    result.status === "cancelled" &&
    (result.error ?? "").startsWith(HELD_FOR_REPLAN)
  );
}

/**
 * The fix a pending task's status calls for. A task that is still open
 * after two runs is past what a re-brief fixes on the worker: it goes to
 * the orchestrator's model (a task that already ran there this turn is
 * not pending at all: `describeReplan` reports it). Otherwise by status:
 * out of steps or time is too big, so split it; no change at all means
 * the brief did not say what to change.
 */
export function replanFix(
  id: string,
  status: WorkerTaskStatus,
  attempts: number,
  ranOnOrchestrator: boolean,
  orchestratorAvailable = true,
): string | undefined {
  // A question is not a failure (ATO-945): another model will not
  // answer it, the orchestrator (or the person) does.
  if (status === "needs_input") return NEEDS_INPUT_FIX;
  if (
    attempts >= 2 &&
    status !== "cancelled" &&
    !ranOnOrchestrator &&
    orchestratorAvailable
  ) {
    return 'it failed twice on a worker: send it with `model: "orchestrator"`';
  }
  if (status === "max_steps" || status === "timeout") {
    return `split it into smaller tasks, as continuation ids \`${id}.a\`, \`${id}.b\` (they share its replans)`;
  }
  if (status === "no_changes") {
    return "name the file and the exact edit in the brief";
  }
  return undefined;
}

/**
 * Which tasks go back to the planner. `attempts(id)` is how many times
 * the task (its continuation family) was run this turn, this call
 * included; a task run `max + 1` times has used every replan.
 * `ranOnOrchestrator(id)` says the task's family already ran on the
 * orchestrator leg this turn, in any round: its fix is never "send it
 * there", and once it has run twice it is listed in
 * `failedOnOrchestrator`, for the planner to report to the person.
 * `orchestratorAvailable` is false when the target is off or this
 * turn's `maxOrchestratorTasksPerTurn` is used: then no fix names it.
 */
export function describeReplan(
  results: readonly WorkerTaskResult[],
  attempts: (taskId: string) => number,
  max: number,
  ranOnOrchestrator: (taskId: string) => boolean = () => false,
  orchestratorAvailable = true,
): ReplanReport {
  const pending: ReplanTask[] = [];
  const exhausted: ReplanTask[] = [];
  const failedOnOrchestrator: ReplanTask[] = [];
  for (const result of results) {
    if (!isOpenResult(result)) continue;
    const runs = attempts(result.id);
    const used = Math.max(0, runs - 1);
    const left = max - used;
    const onOrchestrator = ranOnOrchestrator(result.id);
    // A question asked again on the orchestrator's model is still a
    // question to answer, not a failure past what a round fixes.
    const stop = left > 0 && runs >= 2 && onOrchestrator && result.status !== "needs_input";
    const fix =
      left > 0 && !stop
        ? replanFix(
            result.id,
            result.status,
            runs,
            onOrchestrator,
            orchestratorAvailable,
          )
        : undefined;
    const task: ReplanTask = {
      id: result.id,
      status: result.status,
      why: whyOf(result),
      replansLeft: Math.max(0, left - 1),
      ...(fix === undefined ? {} : { fix }),
    };
    if (stop) failedOnOrchestrator.push({ ...task, replansLeft: 0 });
    else if (left > 0) pending.push(task);
    else exhausted.push(task);
  }
  return { pending, exhausted, failedOnOrchestrator, max };
}

/**
 * A row's error, or its status when it has none, with the worker's
 * question after it: for `needs_input` the question is the whole point.
 */
function whyOf(result: WorkerTaskResult): string {
  const base = (result.error ?? result.status).replace(/\s+/g, " ").slice(0, 300);
  if (result.question === undefined) return base;
  return `${base}; asks: ${result.question.replace(/\s+/g, " ")}`;
}

export function renderReplanBlock(report: ReplanReport): string {
  const parts: string[] = [];
  if (report.pending.length > 0 && report.pending.every((t) => t.status === "needs_input")) {
    // Nothing failed: the loop does not hold the next step to the
    // delegate (`fusion-replan.ts`), so the planner may ask the person.
    parts.push(
      [
        `ANSWER REQUIRED — these tasks stopped to ask. Answer each question in its brief and send it again with \`fusion.delegate\` (same id), or, when only the person can answer, ask them in your reply:`,
        ...report.pending.map(
          (t) =>
            `- ${t.id} (${t.status}): ${t.why} — ${t.replansLeft} more replan${t.replansLeft === 1 ? "" : "s"} after this one`,
        ),
      ].join("\n"),
    );
  } else if (report.pending.length > 0) {
    parts.push(
      [
        `REPLAN REQUIRED — these tasks did not close. Your next step must be \`fusion.delegate\` again: rewrite each brief from the facts above (the error, the failed checks, the judge's findings), keep each task's id or split it into continuation ids (\`<id>.a\`, \`<id>.b\`, sharing its replans), and include anything held for them.`,
        ...report.pending.map(
          (t) =>
            `- ${t.id} (${t.status}): ${t.why} — ${t.replansLeft} more replan${t.replansLeft === 1 ? "" : "s"} after this one${t.fix === undefined ? "" : `; fix: ${t.fix}`}`,
        ),
      ].join("\n"),
    );
  }
  if (report.exhausted.length > 0) {
    parts.push(
      [
        `NO REPLANS LEFT (${report.max} used) — do not send these again this turn; tell the person plainly what failed and why:`,
        ...report.exhausted.map((t) => `- ${t.id} (${t.status}): ${t.why}`),
      ].join("\n"),
    );
  }
  if (report.failedOnOrchestrator.length > 0) {
    parts.push(
      [
        `FAILED ON THE ORCHESTRATOR'S MODEL TOO — these already ran on \`model: "orchestrator"\` this turn; do not send them again: tell the person plainly what failed and why, and ask how to continue:`,
        ...report.failedOnOrchestrator.map(
          (t) => `- ${t.id} (${t.status}): ${t.why}`,
        ),
      ].join("\n"),
    );
  }
  return parts.length === 0 ? "" : `\n\n${parts.join("\n\n")}`;
}
