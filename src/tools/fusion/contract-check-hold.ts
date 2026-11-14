import type { ApprovalGate } from "../../approval/approval-gate.js";
import { requireApproval } from "../../approval/dangerous-tool.js";
import type { ContractCheck } from "./contract.js";
import { CONTRACT_CHECKS_HELD, ContractChecksHeldError, type ContractCheckRunner } from "./contract-checks.js";

/**
 * The contract's declared `checks` after outside content (ATO-618,
 * `agent.taintReview`). The checks run commands on what the workers
 * wrote: a test file a worker steered by a web page wrote is code the
 * checks execute. The fan-out's yes was given before that text, so
 * while the orchestrator's session is tainted (a worker's outside
 * content marks it too, `ApprovalGate.followTaint`) the checks are put
 * to the gate as one `shell` request first, the way a tainted shell
 * command is: the reviewer's `low` runs them, anything else asks the
 * person, a refuse-policy session refuses.
 *
 * One decision per delegate call: every batch (a worker's self-check,
 * an isolated merge gate, a dependency release, the final pass, the
 * candidate's final checks) waits on the same request, so a multi-wave
 * run asks once. A batch while the session is clean runs unasked and
 * leaves nothing cached, so taint that arrives later still asks. A
 * request the turn's cancellation ended is not cached either.
 */

/** Longest command summary per check in the request. */
const CHECK_SUMMARY_CHARS = 160;
/** Checks named in the request's reason; the preview lists every one. */
const CHECKS_IN_REASON = 3;

export type ContractCheckHoldGate = Partial<
  Pick<ApprovalGate, "holdsForOutsideContent" | "outsideContentSources" | "request">
>;

export interface ContractCheckHold {
  /**
   * Whether the checks may run now: `undefined` to run them, or the note
   * to report them as not run with. Asks at most once per call.
   */
  decide(signal: AbortSignal, batch?: readonly Record<string, unknown>[]): Promise<string | undefined>;
  /** `runner` behind the hold; absent when no runner is wired. */
  runner: ContractCheckRunner | undefined;
}

export function createContractCheckHold(options: {
  runner: ContractCheckRunner | undefined;
  approvals: ContractCheckHoldGate;
  approvalRequired: boolean;
  /** The orchestrator's session: the one the fan-out was approved on. */
  sessionId: string;
  workingDir: string;
  tool: string;
  /**
   * The contract's declared checks, described on the request. When it
   * declares none (a split's children brought their own), the first
   * batch's specs are described instead.
   */
  checks: readonly ContractCheck[];
  /**
   * The call's own signal: the request lives as long as the call, so a
   * worker whose batch stopped waiting (its time limit) does not take
   * the person's prompt away from the batches still waiting on it.
   */
  signal: AbortSignal;
}): ContractCheckHold {
  let settled: Promise<string | undefined> | undefined;
  const holds = (): boolean =>
    options.approvalRequired &&
    options.approvals.request !== undefined &&
    (options.approvals.holdsForOutsideContent?.(options.sessionId, "shell") ?? false);
  const ask = async (batch: readonly Record<string, unknown>[]): Promise<string | undefined> => {
    const signal = options.signal;
    const sources = options.approvals.outsideContentSources?.(options.sessionId) ?? [];
    const summaries = (options.checks.length > 0 ? options.checks : batch).map(summariseCheck);
    const plural = `${summaries.length} contract check${summaries.length === 1 ? "" : "s"}`;
    const named = summaries.slice(0, CHECKS_IN_REASON).join("; ");
    const more = summaries.length > CHECKS_IN_REASON ? `; +${summaries.length - CHECKS_IN_REASON} more` : "";
    try {
      await requireApproval(
        { approvals: options.approvals as ApprovalGate, approvalRequired: true },
        {
          sessionId: options.sessionId,
          tool: options.tool,
          category: "shell",
          reason:
            `run ${plural} on the workers' output after outside content` +
            `${sources.length === 0 ? "" : ` (${sources.join(", ")})`}: ${named}${more}`,
          preview: summaries.map((s) => `- ${s}`).join("\n"),
          affectedResources: [options.workingDir],
          workdir: options.workingDir,
        },
        signal,
      );
      return undefined;
    } catch (err) {
      if (signal.aborted) throw err;
      const why = err instanceof Error ? err.message : String(err);
      return `${CONTRACT_CHECKS_HELD} (${why})`;
    }
  };
  const decide = async (
    signal: AbortSignal,
    batch: readonly Record<string, unknown>[] = [],
  ): Promise<string | undefined> => {
    if (settled === undefined) {
      if (!holds()) return undefined;
      const pending = ask(batch);
      settled = pending;
      // Cancelled while it waited: no decision, the next batch asks again.
      pending.catch(() => {
        if (settled === pending) settled = undefined;
      });
    }
    try {
      return await untilAborted(settled, signal);
    } catch {
      return `${CONTRACT_CHECKS_HELD} (the turn was cancelled)`;
    }
  };
  const inner = options.runner;
  const runner: ContractCheckRunner | undefined =
    inner === undefined
      ? undefined
      : Object.assign(
          async (...args: Parameters<ContractCheckRunner>) => {
            const held = await decide(args[1].signal, args[0]);
            if (held !== undefined) throw new ContractChecksHeldError(held);
            return inner(...args);
          },
          inner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {},
        );
  return { decide, runner };
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** One check as the person reads it: its command line, or its spec. */
function summariseCheck(check: ContractCheck): string {
  const { task, ...spec } = check;
  const line = commandLine(spec) ?? JSON.stringify(spec);
  const flat = line.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const clipped = flat.length > CHECK_SUMMARY_CHARS ? `${flat.slice(0, CHECK_SUMMARY_CHARS - 1)}…` : flat;
  return typeof task === "string" ? `[${task}] ${clipped}` : clipped;
}

function commandLine(spec: Record<string, unknown>): string | undefined {
  const argv = (cmd: unknown, args: unknown): string | undefined =>
    typeof cmd === "string" && cmd.length > 0
      ? [cmd, ...(Array.isArray(args) ? args.map(String) : [])].join(" ")
      : undefined;
  const direct = argv(spec.cmd, spec.args) ?? (typeof spec.command === "string" ? spec.command : undefined);
  if (direct !== undefined) return direct;
  const start = spec.start as { cmd?: unknown; args?: unknown } | undefined;
  const started = start === undefined ? undefined : argv(start.cmd, start.args);
  const target = typeof spec.url === "string" ? spec.url : typeof spec.path === "string" ? spec.path : undefined;
  if (started !== undefined) return `start ${started}${target === undefined ? "" : `, then open ${target}`}`;
  return target === undefined ? undefined : `open ${target}`;
}
