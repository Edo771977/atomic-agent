import {
  CHECK_OUTPUT_CHARS,
  runContractChecks,
  tailClip,
  type ContractCheckOutcome,
  type ContractCheckRunner,
} from "./contract-checks.js";
import type { ContractCheck, DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import { inspectDeclaredFiles, type DegenerateFile } from "./declared-files.js";
import {
  maskSecrets,
  type KnownSecret,
} from "../../error-reporting/secret-detector.js";

/**
 * A worker checks its own work before its reply closes the task.
 *
 * A weak worker's mistakes are cheap to fix with its own tokens and
 * expensive to fix through the orchestrator: every correction the
 * orchestrator has to make costs it a full round. So when a worker
 * replies, the runner asks the disk and the task's own contract checks
 * the questions the fan-out would ask afterwards — is every declared
 * file there, do this task's checks pass in its workspace — and on a
 * "no" gives the worker ONE notice with the specific failure and
 * `SELF_CHECK_GRACE_STEPS` more steps, the way a reply claiming an
 * unrun check is held once (`claim-evidence.ts`).
 *
 * Only absence is asked about, as `applyDeclaredFileReport` does:
 * `task.files` mixes inputs with outputs, and a path that exists but
 * was not touched is right for an input. The post-fan-out checks still
 * run and are the verdict; this run only gives the worker a chance to
 * see what they would see. A task with no declared files and no checks
 * of its own is never checked here.
 */

/** Steps a worker gets to fix what its self-check found. */
export const SELF_CHECK_GRACE_STEPS = 4;
/**
 * The fewest steps worth a grace: one to fix, one to reply. A worker
 * with less of its budget left ends as it always did.
 */
export const SELF_CHECK_MIN_GRACE_STEPS = 2;
/** The longest the in-worker run of a task's own checks may take. */
export const SELF_CHECK_MAX_MS = 120_000;
/** Less of the worker's clock than this left, and nothing is checked. */
export const SELF_CHECK_MIN_REMAINING_MS = 10_000;
/** All failing-check output one notice carries. */
export const SELF_CHECK_OUTPUT_CHARS = 2 * CHECK_OUTPUT_CHARS;
const CHECK_SPEC_CHARS = 200;

/** The contract checks attributed to this task, in contract order. */
export function ownChecks(
  contract: DelegateContract | undefined,
  taskId: string,
): ContractCheck[] {
  return (contract?.checks ?? []).filter((check) => check.task === taskId);
}

export interface SelfCheckFinding {
  /** Declared paths that do not exist. */
  missing: string[];
  /** Declared paths written as a stand-in for a file. */
  degenerate: DegenerateFile[];
  /** This task's checks that failed, each with its spec. */
  failed: { spec: ContractCheck; outcome: ContractCheckOutcome }[];
}

/** Whether the self-check has anything for the worker to fix. */
export function hasFindings(finding: SelfCheckFinding): boolean {
  return (
    finding.missing.length > 0 ||
    finding.degenerate.length > 0 ||
    finding.failed.length > 0
  );
}

/**
 * Ask the disk and the task's own checks. Never throws. A check run
 * that is aborted, exceeds `timeCapMs` or cannot run says nothing
 * either way: no finding comes from it, and `checksNotRun` says why.
 */
export async function runSelfCheck(input: {
  task: DelegateTask;
  contract?: DelegateContract;
  workingDir: string;
  startedAt: number;
  runChecks?: ContractCheckRunner;
  signal: AbortSignal;
  timeCapMs: number;
}): Promise<SelfCheckFinding & { checksNotRun?: string }> {
  const finding: SelfCheckFinding = { missing: [], degenerate: [], failed: [] };
  const files = input.task.files ?? [];
  if (files.length > 0) {
    const report = await inspectDeclaredFiles(files, input.workingDir, input.startedAt);
    finding.missing = report.missing;
    finding.degenerate = report.degenerate ?? [];
  }
  const checks = ownChecks(input.contract, input.task.id);
  if (checks.length === 0 || input.runChecks === undefined) return finding;
  if (input.signal.aborted || input.timeCapMs <= 0) {
    return { ...finding, checksNotRun: "no time left" };
  }
  const cap = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A runner that does not honour its signal must not hold the worker:
  // the race ends at the cap whatever the runner does.
  const capped = new Promise<"cap">((resolve) => {
    timer = setTimeout(() => {
      cap.abort(new Error("self-check time cap"));
      resolve("cap");
    }, input.timeCapMs);
    timer.unref?.();
  });
  let onStop: (() => void) | undefined;
  const stopped = new Promise<"stopped">((resolve) => {
    onStop = () => resolve("stopped");
    input.signal.addEventListener("abort", onStop, { once: true });
  });
  try {
    const run = await Promise.race([
      runContractChecks(checks, input.runChecks, {
        workingDir: input.workingDir,
        signal: AbortSignal.any([input.signal, cap.signal]),
      }),
      capped,
      stopped,
    ]);
    if (run === "cap") {
      return { ...finding, checksNotRun: `not finished within ${Math.round(input.timeCapMs / 1000)}s` };
    }
    if (run === "stopped") return { ...finding, checksNotRun: "the worker was stopped" };
    if (run.checksSkipped !== undefined) return { ...finding, checksNotRun: run.checksSkipped };
    run.outcomes.forEach((outcome, i) => {
      if (!outcome.ok) finding.failed.push({ spec: checks[i]!, outcome });
    });
    return finding;
  } finally {
    clearTimeout(timer);
    if (onStop !== undefined) input.signal.removeEventListener("abort", onStop);
  }
}

function describeSpec(check: ContractCheck): string {
  const { task: _task, ...spec } = check;
  const json = JSON.stringify(spec);
  return json.length > CHECK_SPEC_CHARS ? `${json.slice(0, CHECK_SPEC_CHARS)}…` : json;
}

/**
 * The one notice the worker gets, as the next message of its
 * conversation. Masked whole with the shared detector before it is sent
 * (`known`: the agent's own keys, as the tool registry masks with,
 * ATO-1077): the check ran outside the registry, and its output — a
 * `DATABASE_URL`, a token a test printed — would otherwise reach the
 * worker's model, its session and its trace as it was.
 */
export function renderSelfCheckNotice(
  finding: SelfCheckFinding,
  graceSteps: number,
  known: readonly KnownSecret[] = [],
): string {
  const lines = [
    "Your reply did not close the task: the runtime checked your work and it is not done yet.",
    ...finding.missing.map((path) => `- declared file ${path} does not exist`),
    ...finding.degenerate.map(({ path, reason }) => `- declared file ${path} ${reason}`),
  ];
  const withOutput = finding.failed.filter((f) => f.outcome.output !== undefined).length;
  const share =
    withOutput === 0
      ? 0
      : Math.min(CHECK_OUTPUT_CHARS, Math.floor(SELF_CHECK_OUTPUT_CHARS / withOutput));
  for (const { spec, outcome } of finding.failed) {
    lines.push(`- your check ${describeSpec(spec)} failed: ${outcome.detail}`);
    if (outcome.output !== undefined) {
      lines.push(`  output:\n${tailClip(outcome.output, share).replace(/^/gm, "    ")}`);
    }
  }
  lines.push(
    `Fix exactly this now; you have ${graceSteps} more steps. ${finding.missing.length + finding.degenerate.length > 0 ? "Write each declared file with its full content. " : ""}${finding.failed.length > 0 ? "Re-run the failing check with verify.run until it passes. " : ""}If the cause is a file another task owns, do not write it: say so in your reply. Then reply with what you changed.`,
  );
  return maskSecrets(lines.join("\n"), known);
}

/** The row's note: what the worker was told, so the orchestrator knows it had its second chance. */
export function describeSelfCheck(finding: SelfCheckFinding, graceSteps: number): string {
  const parts = [
    ...(finding.missing.length > 0
      ? [`declared file${finding.missing.length === 1 ? "" : "s"} ${finding.missing.join(", ")} missing`]
      : []),
    ...(finding.degenerate.length > 0
      ? [`${finding.degenerate.map((d) => d.path).join(", ")} a stand-in for a file`]
      : []),
    ...(finding.failed.length > 0
      ? [finding.failed.length === 1 ? "its own check failing" : `${finding.failed.length} of its own checks failing`]
      : []),
  ];
  return `self-check: its first reply left ${parts.join("; ")}; it was told once and given ${graceSteps} more steps`;
}
