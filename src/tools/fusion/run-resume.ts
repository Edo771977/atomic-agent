import {
  checkpointHasFileMutations,
  type CheckpointTask,
  type FusionRunCheckpoint,
} from "./run-checkpoint.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";
import { UNTRACKED_WRITE_TOOLS } from "./worker-changes.js";

/**
 * Resuming a fusion run that did not end (ATO-617).
 *
 * The orchestrator resumes with `fusion.delegate { resume: "<runId>" }`:
 * the call's arguments come from the checkpoint, tasks that finished
 * before the restart are reported from it, and only the rest is sent to
 * workers again. A task whose worker had already run something with
 * effects outside its files (`toolHasSideEffects`) is not re-run on its
 * own: it comes back `needs_orchestrator`, the orchestrator asks the
 * person, and a yes is `confirm: ["<taskId>"]` on the next resume call —
 * the same rule as resuming a chat turn, where repeating a command the
 * person never saw twice is the risk.
 */

export interface ResumeRequest {
  runId: string;
  /** Task ids the person agreed to run again despite their side effects. */
  confirm: string[];
}

/**
 * `resume` / `confirm` off a `fusion.delegate` call: `null` when the call
 * is not a resume, a string when it is a malformed one.
 */
export function readResumeRequest(
  raw: Record<string, unknown>,
): ResumeRequest | string | null {
  if (raw.resume === undefined || raw.resume === null) {
    return raw.confirm === undefined
      ? null
      : "confirm is only read together with resume";
  }
  if (typeof raw.resume !== "string" || raw.resume.trim().length === 0) {
    return "resume must be the id of an unfinished fusion run (fr-…)";
  }
  let confirm: string[] = [];
  if (raw.confirm !== undefined) {
    if (
      !Array.isArray(raw.confirm) ||
      !raw.confirm.every((id) => typeof id === "string")
    ) {
      return "confirm must be an array of task ids";
    }
    confirm = raw.confirm as string[];
  }
  return { runId: raw.resume.trim(), confirm };
}

/**
 * A finished task stands. Cancelled, never-served queued and explicitly
 * not-started rows are unfinished; their side-effect confirmation guard
 * still applies before another attempt.
 */
export function isSettledForResume(task: CheckpointTask): boolean {
  return task.result !== undefined && task.result.status !== "cancelled" &&
    task.result.status !== "queued" && !(task.result.error ?? "").startsWith("not started:");
}

export interface ResumePlan {
  runId: string;
  /** Finished before the restart: reported from the checkpoint, never re-run. */
  carried: WorkerTaskResult[];
  /** Ran side effects before the restart and were not confirmed: not re-run. */
  needsConfirmation: WorkerTaskResult[];
  /** Sent to workers again. */
  rerun: string[];
  /** The spend recorded so far, counted toward this turn's cap. */
  carriedSpendUsd: number;
}

export const CARRIED_NOTE =
  "finished before the restart: reported from the run's checkpoint, not run again";

/** Split a checkpoint into what stands, what needs a yes, and what runs again. */
export function planResume(
  checkpoint: FusionRunCheckpoint,
  confirm: readonly string[] = [],
): ResumePlan {
  const confirmed = new Set(confirm);
  const carried: WorkerTaskResult[] = [];
  const needsConfirmation: WorkerTaskResult[] = [];
  const rerun: string[] = [];
  for (const task of checkpoint.tasks) {
    if (isSettledForResume(task)) {
      carried.push(carriedResult(task));
    } else if (task.sideEffects && !confirmed.has(task.id)) {
      needsConfirmation.push(
        confirmationResult(task, checkpoint.runId),
      );
    } else {
      rerun.push(task.id);
    }
  }
  return {
    runId: checkpoint.runId,
    carried,
    needsConfirmation,
    rerun,
    carriedSpendUsd: checkpoint.spentUsd,
  };
}

function carriedResult(task: CheckpointTask): WorkerTaskResult {
  const r = task.result!;
  // Older rows kept tool names but not the shell-coverage flag. An old
  // verify.run also cannot prove that its execution was isolated.
  const legacyWrites = checkpointHasFileMutations(r.tools) || r.shellRan === true ||
    Object.keys(r.tools.byTool).some((tool) => UNTRACKED_WRITE_TOOLS.has(tool) || tool === "verify.run");
  const incomplete = r.artifactMetadata === "incomplete" ||
    (r.artifactMetadata === undefined && legacyWrites);
  const coverageError = incomplete && r.status === "ok"
    ? "checkpoint artifact coverage is incomplete; verify the changed files before replanning this task"
    : undefined;
  return {
    id: task.id,
    title: task.title,
    status: coverageError === undefined ? r.status : "needs_orchestrator",
    reply: r.reply,
    stepCount: r.stepCount,
    durationMs: r.durationMs,
    queueWaitMs: null,
    tools: r.tools,
    ...((coverageError ?? r.error) === undefined ? {} : { error: coverageError ?? r.error }),
    ...(r.changes === undefined ? {} : { changes: r.changes }),
    ...(r.shellRan === true ? { shellRan: true } : {}),
    ...(r.artifactManifest === undefined ? {} : { artifactManifest: r.artifactManifest }),
    notes: [...(r.notes ?? []), CARRIED_NOTE],
  };
}

function confirmationResult(
  task: CheckpointTask,
  runId: string,
): WorkerTaskResult {
  const tools = task.sideEffectTools.join(", ") || "a tool with side effects";
  const row = new WorkerRunCollector().finish({
    id: task.id,
    title: task.title,
    reason: "cancelled",
    stepCount: 0,
    durationMs: 0,
    error:
      `not started: before the restart this worker ran ${tools}, which may already have changed things outside its files. ` +
      `Ask the person whether to run it again; on a yes call fusion.delegate {"resume":"${runId}","confirm":["${task.id}"]}`,
  });
  return { ...row, status: "needs_orchestrator", queueWaitMs: null };
}

/** One line for the person: what is left of an unfinished run. */
export function describeResumableRun(checkpoint: FusionRunCheckpoint): string {
  const total = checkpoint.tasks.length;
  const done = checkpoint.tasks.filter(isSettledForResume).length;
  const asking = checkpoint.tasks.filter(
    (t) => !isSettledForResume(t) && t.sideEffects,
  ).length;
  const waves =
    checkpoint.waveCount > 1
      ? `, stopped after wave ${checkpoint.wavesDone} of ${checkpoint.waveCount}`
      : "";
  const ask =
    asking === 0
      ? ""
      : ` (${asking} ran commands before it stopped and will be asked about first)`;
  return `unfinished Fusion run ${checkpoint.runId}: ${done} of ${total} task${total === 1 ? "" : "s"} done${waves}; ${total - done} left${ask}`;
}

/**
 * The message `/fusion resume` sends as the person's turn: the
 * orchestrator is told exactly which call continues the run.
 */
export function renderResumeRequest(checkpoint: FusionRunCheckpoint): string {
  const lines = [
    `Continue the Fusion run that was cut off by a restart (${describeResumableRun(checkpoint)}).`,
    `Call fusion.delegate with {"resume":"${checkpoint.runId}"} and nothing else: finished tasks are reported from the checkpoint and only the rest runs again.`,
    `A task that ran commands before the restart comes back needs_orchestrator: ask me before running it again.`,
  ];
  if (checkpoint.originalRequest !== undefined) {
    lines.push("", "The original request was:", checkpoint.originalRequest);
  }
  return lines.join("\n");
}
