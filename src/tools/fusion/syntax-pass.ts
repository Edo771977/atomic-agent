import { stat } from "node:fs/promises";

import {
  knownSecretsFromEnv,
  maskSecrets,
  type KnownSecret,
} from "../../error-reporting/secret-detector.js";
import { resolveUserPath } from "../os/expand-home.js";
import { isOutsideReadRoots } from "../read-scope/read-scope.js";
import type { SyntaxFileResult } from "../verify/syntax-check-types.js";
import { VERIFY_SYNTAX_MAX_FILES } from "../verify/verify-syntax.js";
import type { DelegateTask } from "./delegate-args.js";
import { presentChangedPaths } from "./worker-changes.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * The delegate's own syntax pass over a fan-out's green rows.
 *
 * The orchestrator is the expensive model, and its guidance used to
 * send it to `verify.syntax` on the declared files after every fan-out:
 * one more strong step per round, with the checker's output in the
 * strong context. The check is deterministic and costs no tokens, so
 * the delegate runs it itself, through the same checker the tool runs
 * (`verifySyntax`, injected as `SyntaxCheckRunner`), and the row says
 * the verdict. A file that fails demotes its row the way a failed
 * contract check does: the table counts it `failed`, not `ok`.
 */
export type SyntaxCheckRunner = (
  files: readonly string[],
  workingDir: string,
) => Promise<{ results: readonly SyntaxFileResult[] }>;

/** One row's syntax verdict, for the status table and the row's block. */
export interface TaskSyntaxSummary {
  /** Files the checker ruled on (passed or failed). */
  checked: number;
  /** The files that failed, as the row names them. */
  failedFiles: string[];
  /** Files with no verdict (no checker for the extension, checker missing). */
  unchecked: number;
  /** Files outside the session's read scope, not checked. */
  outOfScope?: number;
  /** The failing files' errors, masked, at most `SYNTAX_OUTPUT_CHARS`. */
  output?: string;
  /** Why the pass gave no verdict at all (the checker threw). */
  error?: string;
}

/** How much of the failing files' errors one row carries. */
export const SYNTAX_OUTPUT_CHARS = 600;

/**
 * The files a row is checked on: what its worker's file tools changed
 * and is still there, else (a shell wrote them, or nothing recorded)
 * the task's declared files. A declared file nobody changed is the
 * declared-file check's business, not a syntax verdict on this task.
 */
export function syntaxPassFiles(
  row: WorkerTaskResult,
  task: DelegateTask | undefined,
): string[] {
  const changed = presentChangedPaths(row.changes);
  return changed.length > 0 ? changed : [...(task?.files ?? [])];
}

/**
 * Run the syntax pass over every `ok` row and fold the verdicts in.
 * Never throws: a checker that throws leaves the rows `ok` with the
 * reason on their `syntax` summary, never a pass it did not make.
 * Files outside `roots` (the session's read scope: its working
 * directory, the paths the user named, the fan-out's write scope) are
 * not read; directories and missing paths are skipped (a missing
 * declared file is already the declared-file check's error).
 */
export async function runSyntaxPass(
  rows: readonly WorkerTaskResult[],
  tasks: readonly DelegateTask[],
  options: {
    runner: SyntaxCheckRunner | undefined;
    workingDir: string;
    roots: readonly string[];
    signal: AbortSignal;
    knownSecrets?: readonly KnownSecret[];
  },
): Promise<WorkerTaskResult[]> {
  if (options.runner === undefined || options.signal.aborted) return [...rows];
  const plans = new Map<string, { files: string[]; outOfScope: number }>();
  const absoluteOf = new Map<string, string>();
  const queued: string[] = [];
  for (const row of rows) {
    if (row.status !== "ok") continue;
    const task = tasks.find((t) => t.id === row.id);
    const files: string[] = [];
    let outOfScope = 0;
    for (const file of syntaxPassFiles(row, task)) {
      let absolute: string;
      try {
        absolute = resolveUserPath(file, options.workingDir);
      } catch {
        continue;
      }
      if (isOutsideReadRoots(absolute, options.roots)) {
        outOfScope += 1;
        continue;
      }
      try {
        if (!(await stat(absolute)).isFile()) continue;
      } catch {
        continue;
      }
      if (files.includes(file)) continue;
      files.push(file);
      absoluteOf.set(file, absolute);
      if (!queued.includes(absolute) && queued.length < VERIFY_SYNTAX_MAX_FILES) {
        queued.push(absolute);
      }
    }
    if (files.length > 0 || outOfScope > 0) plans.set(row.id, { files, outOfScope });
  }
  if (plans.size === 0) return [...rows];
  const known = options.knownSecrets ?? knownSecretsFromEnv();
  let verdicts: Map<string, SyntaxFileResult>;
  let failure: string | undefined;
  try {
    // One run for the whole fan-out: a TypeScript project is checked
    // once, however many rows touched it.
    const { results } =
      queued.length === 0
        ? { results: [] }
        : await options.runner(queued, options.workingDir);
    verdicts = new Map(queued.map((file, i) => [file, results[i]!]));
  } catch (error) {
    verdicts = new Map();
    failure = maskSecrets(
      `the syntax pass did not run: ${error instanceof Error ? error.message : String(error)}`,
      known,
    );
  }
  return rows.map((row) => {
    const plan = plans.get(row.id);
    if (plan === undefined) return row;
    const outOfScope = plan.outOfScope > 0 ? { outOfScope: plan.outOfScope } : {};
    if (failure !== undefined) {
      return {
        ...row,
        syntax: { checked: 0, failedFiles: [], unchecked: plan.files.length, ...outOfScope, error: failure },
      };
    }
    let checked = 0;
    let unchecked = 0;
    const failed: { file: string; error: string }[] = [];
    for (const file of plan.files) {
      const verdict = verdicts.get(absoluteOf.get(file)!);
      if (verdict === undefined || verdict.ok === null) {
        unchecked += 1;
        continue;
      }
      checked += 1;
      if (verdict.ok === false) {
        failed.push({ file, error: maskSecrets(verdict.error ?? "failed", known) });
      }
    }
    const output =
      failed.length === 0 ? undefined : clip(failed.map((f) => `${f.file}: ${f.error}`).join("\n"));
    const syntax: TaskSyntaxSummary = {
      checked,
      failedFiles: failed.map((f) => f.file),
      unchecked,
      ...outOfScope,
      ...(output === undefined ? {} : { output }),
    };
    if (failed.length === 0) return { ...row, syntax };
    const error = describeSyntaxFailure(syntax);
    return {
      ...row,
      status: "failed",
      syntax,
      error: row.error === undefined ? error : `${error}; ${row.error}`,
    };
  });
}

/** `syntax: 2 files failed (a.ts, b.js)` — the row's error. */
function describeSyntaxFailure(syntax: TaskSyntaxSummary): string {
  const n = syntax.failedFiles.length;
  return `syntax: ${n} file${n === 1 ? "" : "s"} failed (${syntax.failedFiles.join(", ")})`;
}

/**
 * The status-table clause: `syntax ok (3 files)`, with what it did not
 * cover; the failure itself when the row's error does not already lead
 * with it; `null` when there is nothing to say.
 */
export function describeSyntax(
  syntax: TaskSyntaxSummary,
  error?: string,
): string | null {
  if (syntax.error !== undefined) return syntax.error;
  const notCovered = [
    ...(syntax.unchecked > 0 ? [`${syntax.unchecked} unchecked`] : []),
    ...((syntax.outOfScope ?? 0) > 0 ? [`${syntax.outOfScope} outside the read scope, not checked`] : []),
  ];
  if (syntax.failedFiles.length > 0) {
    if (error?.startsWith("syntax: ")) return null;
    return [describeSyntaxFailure(syntax), ...notCovered].join(", ");
  }
  if (syntax.checked === 0) {
    return notCovered.length === 0 ? null : `syntax: ${notCovered.join(", ")}`;
  }
  const files = `${syntax.checked} file${syntax.checked === 1 ? "" : "s"}`;
  return `syntax ok (${[files, ...notCovered].join(", ")})`;
}

function clip(text: string): string {
  return text.length > SYNTAX_OUTPUT_CHARS
    ? `${text.slice(0, SYNTAX_OUTPUT_CHARS - 1)}…`
    : text;
}
