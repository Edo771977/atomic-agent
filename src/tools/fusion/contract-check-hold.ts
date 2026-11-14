import type { ApprovalGate } from "../../approval/approval-gate.js";
import { maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import type { CommandReadCheck } from "../read-scope/confine-reads.js";
import type { ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import { authorizeVerifyBatch } from "../verify/verify-authorization.js";
import type { ContractCheck } from "./contract.js";
import { CONTRACT_CHECKS_HELD, ContractChecksHeldError, type ContractCheckRunner } from "./contract-checks.js";

export type ContractCheckHoldGate = Partial<Pick<ApprovalGate,
  "holdsForOutsideContent" | "outsideContentSources" | "request" | "ruleDecisionFor" | "hasDeclinedTarget"
>>;
export interface ContractCheckHold {
  decide(signal: AbortSignal, batch?: readonly Record<string, unknown>[]): Promise<string | undefined>;
  runner: ContractCheckRunner | undefined;
}

/**
 * Every batch is a new complete verification plan. No decision is cached:
 * children, retries, resumed checks, changed env/cwd and later taint all reach
 * the real gate. Serialize questions, never park a worker-owned prompt, and
 * approve every check in a batch before invoking even its first executor.
 */
export function createContractCheckHold(options: {
  runner: ContractCheckRunner | undefined;
  approvals: ContractCheckHoldGate;
  approvalRequired: boolean;
  sessionId: string;
  workingDir: string;
  /** Trusted source of the default plan, before further execution copies. */
  sourceWorkingDir?: string;
  tool: string;
  checks: readonly ContractCheck[];
  signal: AbortSignal;
  shellPolicy?: ShellGuardPolicy;
  checkCommandReads?: CommandReadCheck;
  knownSecrets?: readonly KnownSecret[];
  readRoots?: readonly string[];
  checkInputs?: readonly string[];
}): ContractCheckHold {
  let tail = Promise.resolve();
  const authorize = (batch: readonly Record<string, unknown>[], workingDir: string, signal: AbortSignal, checkInputs?: readonly string[]) => {
    const combined = AbortSignal.any([options.signal, signal]);
    const result = tail.then(async () => {
      combined.throwIfAborted();
      if (options.approvalRequired && options.approvals.request === undefined) throw new Error("verification approval gate is unavailable");
      return authorizeVerifyBatch(batch, {
        approvals: options.approvals as ApprovalGate, approvalRequired: options.approvalRequired,
        ...(options.shellPolicy === undefined ? {} : { shellPolicy: options.shellPolicy }),
        ...(options.checkCommandReads === undefined ? {} : { checkCommandReads: options.checkCommandReads }),
        ...(options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets }),
      }, {
        sessionId: options.sessionId, workingDir, ruleWorkdir: options.workingDir,
        stepIndex: 0, signal: combined,
        ...(options.readRoots === undefined ? {} : { readRoots: [...options.readRoots] }),
        checkInputs: checkInputs ?? options.checkInputs ?? [],
      });
    });
    tail = result.then(() => undefined, () => undefined);
    return untilAborted(result, combined);
  };
  const note = (err: unknown, signal: AbortSignal): string => {
    const held = options.approvals.holdsForOutsideContent?.(options.sessionId, "shell") === true ? CONTRACT_CHECKS_HELD : "contract checks held before execution: not run";
    const why = signal.aborted || options.signal.aborted ? "the turn was cancelled" : err instanceof Error ? err.message : String(err);
    return maskSecrets(`${held} (${why})`, options.knownSecrets ?? []);
  };
  const decide = async (signal: AbortSignal, batch: readonly Record<string, unknown>[] = options.checks): Promise<string | undefined> => {
    try { await authorize(batch, options.sourceWorkingDir ?? options.workingDir, signal); return undefined; }
    catch (err) { return note(err, signal); }
  };
  const inner = options.runner;
  const runner: ContractCheckRunner | undefined = inner === undefined ? undefined : Object.assign(
    async (specs: Parameters<ContractCheckRunner>[0], ctx: Parameters<ContractCheckRunner>[1]) => {
      let approved: readonly Record<string, unknown>[];
      try { approved = await authorize(specs, ctx.workingDir, ctx.signal, ctx.inputIntegrity?.paths); }
      catch (err) { throw new ContractChecksHeldError(note(err, ctx.signal)); }
      return inner(approved, ctx);
    },
    inner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {},
  );
  return { decide, runner };
}

/** Cancel a queued waiter promptly too; its queued body later observes abort. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
