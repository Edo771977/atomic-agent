/**
 * Merge only green tasks (branch isolation, ATO-946).
 *
 * A weak worker's mistake must not reach the person's folder until it is
 * verified. Under `isolation: "worktree"` every task already works in a
 * workspace of its own; this gate runs before its merge, inside that
 * workspace: the task's OWN contract checks (`check.task` is the task),
 * then, with `judge: "on"`, the judge on what the task changed. A red
 * task is held back (`runIsolatedWave` keeps its changes as a patch and
 * leaves the folder as it was); a green one merges.
 *
 * Not gated, and run after the merge on the merged folder as before:
 * checks with no owning task (cross-task), and a task's own check whose
 * spec names a path a concurrent task writes (`concurrentPaths`): the
 * workspace has none of its siblings' files, so such a check could only
 * fail there. A split's subtasks are not gated either: their own
 * contract is checked after their merge (`expandSplits`).
 *
 * What the gate decided is recorded in `MergeGateState`, so the
 * after-the-waves contract pass does not run those checks a second time
 * and the judge block reads the verdicts instead of judging again.
 */
import type { KnownSecret } from "../../error-reporting/secret-detector.js";
import {
  rebaseScope,
  rebaseText,
  type GateVerdict,
  type MergeGate,
} from "./branch-merge.js";
import type { WorkspaceChange } from "./branch-diff.js";
import type { BranchMergeOutcome } from "./branch-merge.js";
import {
  applyCheckOutcomes,
  inspectContractProvides,
  runContractChecks,
  type ContractCheckOutcome,
  type ContractCheckRunner,
  type ContractFinding,
} from "./contract-checks.js";
import type { ContractCheck, DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import type { AcceptanceItem, JudgeFacts, JudgeVerdict } from "./judge.js";
import { runSyntaxPass, type SyntaxCheckRunner } from "./syntax-pass.js";
import { concurrentPaths, mentionsPath } from "./worker-self-check.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * What the gates of one fan-out decided, for the passes after the waves.
 *
 * A gate's verdict holds for the files as the gate saw them. It goes
 * stale when what reached the folder differs: the task's own merge
 * needed a three-way `merge-file` (or left a conflict), a task merged
 * after it changed one of its files (its merged paths and its declared
 * files), or a wave ran in place, writing who knows what. A stale
 * task's gated checks and syntax pass run again on the merged folder;
 * every other gate verdict is reused.
 */
export class MergeGateState {
  /** Own-check outcomes by index into `contract.checks`. */
  readonly checkOutcomes = new Map<number, ContractCheckOutcome>();
  /** The judge's verdict per task, from its latest gate. */
  readonly verdicts = new Map<string, JudgeVerdict>();
  /** Tasks whose syntax pass ran in their workspace and gave a verdict. */
  readonly syntaxGated = new Set<string>();
  /** Merged tasks' files (relative to the working directory). */
  private readonly mergedFiles = new Map<string, Set<string>>();
  private readonly stale = new Set<string>();

  /** The gate ruled on the task afresh (a retry): its old staleness is gone. */
  gated(taskId: string): void {
    this.stale.delete(taskId);
  }

  /**
   * One merge reached the folder. `declared` are the task's declared
   * files relative to the working directory.
   */
  noteMerge(outcome: BranchMergeOutcome, declared: readonly string[]): void {
    for (const [other, files] of this.mergedFiles) {
      if (other !== outcome.taskId && outcome.applied.some((p) => files.has(p))) {
        this.stale.add(other);
      }
    }
    if (
      (outcome.threeWay?.length ?? 0) > 0 ||
      outcome.conflicts.length > 0 ||
      outcome.refused.length > 0 ||
      (outcome.lost?.length ?? 0) > 0
    ) {
      this.stale.add(outcome.taskId);
    }
    this.mergedFiles.set(outcome.taskId, new Set([...outcome.applied, ...declared]));
  }

  /** A wave ran in the folder itself: no earlier verdict can be trusted. */
  noteInPlace(): void {
    for (const id of this.mergedFiles.keys()) this.stale.add(id);
  }

  isStale(taskId: string): boolean {
    return this.stale.has(taskId);
  }

  /** Gated checks whose task went stale: re-run them on the folder. */
  staleCheckIndices(): Set<number> {
    const out = new Set<number>();
    for (const [index, outcome] of this.checkOutcomes) {
      if (outcome.task !== undefined && this.stale.has(outcome.task)) out.add(index);
    }
    return out;
  }

  /** The stale tasks were re-checked on the folder. */
  settle(taskIds: Iterable<string>): void {
    for (const id of taskIds) this.stale.delete(id);
  }
}

/** The judge as the gate calls it: spend accounting is the caller's. */
export type GateJudge = (input: {
  task: DelegateTask;
  items: readonly AcceptanceItem[];
  facts: JudgeFacts;
  reply: string;
  contract: DelegateContract | undefined;
  workingDir: string;
  changes: readonly WorkspaceChange[];
}) => Promise<JudgeVerdict>;

export interface MergeGateInput {
  /** The call's contract, whose `checks` indices the state records. */
  contract: DelegateContract | undefined;
  /** The orchestrator's own tasks; anything else (a split's subtask) merges ungated. */
  tasks: readonly DelegateTask[];
  /** Every task id of this run of tasks (a wave, a retry). */
  concurrent: readonly string[];
  runChecks: ContractCheckRunner | undefined;
  knownSecrets?: readonly KnownSecret[];
  signal: AbortSignal;
  state: MergeGateState;
  /**
   * The delegate's syntax pass (`syntax-pass.ts`), run on the task's
   * changed (else declared) files in its workspace; `roots` is the
   * session's read scope as the folder spells it.
   */
  syntax?: { runner: SyntaxCheckRunner | undefined; roots: readonly string[] };
  judge?: {
    items: (taskId: string) => readonly AcceptanceItem[] | undefined;
    judgeable: (row: WorkerTaskResult) => boolean;
    run: GateJudge;
    /** Keep a red task's workspace for the retry (the first round only). */
    keepForRetry: boolean;
  };
}

/** `value` with every spelling of the working directory pointed at `dir`. */
function rebased<T>(value: T, roots: readonly string[], dir: string): T {
  return JSON.parse(rebaseText(JSON.stringify(value), roots, dir)) as T;
}

/** The task's own checks the gate runs, with their contract index. */
export function gatedChecks(
  contract: DelegateContract | undefined,
  taskId: string,
  concurrent: readonly string[],
): Array<{ check: ContractCheck; index: number }> {
  const siblings = concurrentPaths(contract, taskId, concurrent);
  const out: Array<{ check: ContractCheck; index: number }> = [];
  (contract?.checks ?? []).forEach((check, index) => {
    if (check.task !== taskId) return;
    const { task: _task, ...spec } = check;
    const text = JSON.stringify(spec);
    if (siblings.some((path) => mentionsPath(text, path))) return;
    out.push({ check, index });
  });
  return out;
}

export function buildMergeGate(input: MergeGateInput): MergeGate {
  return async (row, workspace): Promise<GateVerdict> => {
    const task = input.tasks.find((t) => t.id === row.id);
    if (task === undefined) return { row, merge: true };
    const contract =
      input.contract === undefined
        ? undefined
        : rebased(input.contract, workspace.roots, workspace.dir);
    let gated = row;
    const own = gatedChecks(input.contract, row.id, input.concurrent);
    const ran = new Set<number>();
    if (own.length > 0) {
      const checks = await runContractChecks(
        own.map(({ index }) => contract!.checks![index]!),
        input.runChecks,
        {
          workingDir: workspace.dir,
          signal: input.signal,
          ...(input.knownSecrets === undefined ? {} : { knownSecrets: input.knownSecrets }),
        },
      );
      // Not run (no runner, a cancelled turn): the pass after the merge
      // says so, as it always did.
      if (checks.outcomes.length === own.length) {
        input.state.gated(row.id);
        own.forEach(({ index }, i) => {
          input.state.checkOutcomes.set(index, checks.outcomes[i]!);
          ran.add(index);
        });
        gated = applyCheckOutcomes([row], checks.outcomes)[0]!;
      }
    }
    const checksRed = gated.status === "failed";
    const ownTask = rebased(task, workspace.roots, workspace.dir);
    // A syntax-only failure must not reach the folder either: the pass
    // after the merge stays for waves that ran in place.
    if (!checksRed && gated.status === "ok" && input.syntax?.runner !== undefined) {
      const [checked] = await runSyntaxPass([gated], [ownTask], {
        runner: input.syntax.runner,
        workingDir: workspace.dir,
        roots: rebaseScope(input.syntax.roots, workspace.roots, workspace.dir),
        signal: input.signal,
        ...(input.knownSecrets === undefined ? {} : { knownSecrets: input.knownSecrets }),
      });
      if (checked !== undefined) {
        gated = checked;
        if (checked.syntax !== undefined && checked.syntax.error === undefined) {
          input.state.syntaxGated.add(row.id);
        }
        if (checked.status === "failed") {
          return {
            row: checked,
            merge: false,
            reason: (checked.error ?? "syntax failed").split("; ")[0]!,
          };
        }
      }
    }
    const items = input.judge?.items(row.id) ?? [];
    if (input.judge !== undefined && items.length > 0 && input.judge.judgeable(gated)) {
      // A check item the gate did not run is decided after the merge.
      const judgedItems = items.filter(
        (item) => item.kind !== "check" || ran.has(item.checkIndex ?? -1),
      );
      let findings: ContractFinding[] = [];
      if (contract !== undefined) {
        findings = (
          await inspectContractProvides(
            { ...contract, provides: (contract.provides ?? []).filter((p) => p.task === row.id) },
            [ownTask],
            workspace.dir,
            { results: [gated], signal: input.signal },
          )
        ).findings;
      }
      const verdict = await input.judge.run({
        task: ownTask,
        items: judgedItems,
        facts: {
          checkOutcomes: (input.contract?.checks ?? []).map((_, i) =>
            ran.has(i) ? input.state.checkOutcomes.get(i) : undefined,
          ),
          findings,
        },
        reply: gated.reply,
        contract,
        workingDir: workspace.dir,
        changes: await workspace.changes(),
      });
      input.state.verdicts.set(row.id, verdict);
      if (verdict.green) return { row: gated, merge: true };
      if (verdict.unverified !== undefined) {
        // Not `ok`: its files are not in the folder, so a later wave must
        // not start its dependents (autoReplan holds them) and the
        // orchestrator decides what to do with it.
        return {
          row: { ...gated, status: "needs_orchestrator" },
          merge: false,
          reason: `the judge could not verify it: ${verdict.unverified}`,
        };
      }
      const red = verdict.items.filter((v) => !v.pass && v.by !== "skipped").length;
      return {
        // Red now, so a later wave does not build on it; the judge
        // block folds the verdict in (`applyJudgeVerdict`).
        row: { ...gated, status: "failed" },
        merge: false,
        reason: `judged red: ${red} of ${verdict.items.length} acceptance items not met`,
        keep: input.judge.keepForRetry,
      };
    }
    if (checksRed) {
      return {
        row: gated,
        merge: false,
        reason: `its own checks failed: ${gated.checks?.detail ?? "see the row"}`,
      };
    }
    return { row: gated, merge: true };
  };
}

/**
 * Fold the checks run after the merge into rows the gate may already
 * have folded its own into: the counts add up instead of the later pass
 * replacing the earlier one.
 */
export function applyPostMergeChecks(
  rows: readonly WorkerTaskResult[],
  outcomes: readonly ContractCheckOutcome[],
  /** Gate outcomes the later run supersedes (a stale task's re-run). */
  replaced: readonly ContractCheckOutcome[] = [],
): WorkerTaskResult[] {
  return rows.map((row) => {
    const next = applyCheckOutcomes([row], outcomes)[0]!;
    const gone = replaced.filter((o) => o.task === row.id);
    const prev =
      row.checks === undefined || gone.length === 0
        ? row.checks
        : {
            ...row.checks,
            total: row.checks.total - gone.length,
            failed: row.checks.failed - gone.filter((o) => !o.ok).length,
          };
    if (prev === undefined || prev.total <= 0 || next.checks === undefined || next === row) {
      return next;
    }
    const detail = [prev.detail, next.checks.detail]
      .filter((d): d is string => d !== undefined)
      .join("; ");
    const output = [prev.output, next.checks.output]
      .filter((o): o is string => o !== undefined)
      .join("\n");
    return {
      ...next,
      checks: {
        total: prev.total + next.checks.total,
        failed: prev.failed + next.checks.failed,
        ...(detail.length === 0 ? {} : { detail }),
        ...(output.length === 0 ? {} : { output }),
      },
    };
  });
}
