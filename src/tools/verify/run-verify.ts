/**
 * `runVerify` — the programmatic face of `verify.run`, shared by the
 * tool and by the fan-out contract (`runChecks`).
 *
 * One result shape for the three kinds: `ok`, `kind`, `isolated`,
 * `durationMs`, the kind's own fields, the `checks` outcomes and a
 * `summary` with failures first. `ok` means the run itself went well
 * AND every check passed; a check that fails to parse fails the run.
 */
import { resolve, relative, isAbsolute } from "node:path";

import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import type { ProbeSample } from "./page-probe-script.js";
import { runCommandKind } from "./run-command-kind.js";
import { type BrowserLauncher, defaultBrowserLauncher, type PageRunOutcome, runPageKind } from "./run-page-kind.js";
import { type FetchLike, type RequestOutcome, runServiceKind } from "./run-service-kind.js";
import { type CheckOutcome, type CheckSubject, evaluateChecks } from "./verify-checks.js";
import { parseVerifyRunArgs, type VerifyRunArgs, type VerifyRunKind } from "./verify-run-args.js";
import { renderVerifyRunSummary } from "./verify-run-summary.js";
import { terminalAppHint } from "./terminal-app-hint.js";
import { createVerifyWorkspace, type VerifyWorkspace } from "./verify-workspace-copy.js";
import type { VerificationInputIntegrity } from "./verify-input-integrity.js";
import { rebaseVerifyWorkspaceValue } from "./rebase-verify-workspace.js";

export interface VerifyRunResult {
  readonly ok: boolean;
  readonly kind: VerifyRunKind;
  readonly isolated: boolean;
  readonly durationMs: number;
  /** A run that could not happen (no browser, bad cwd, spawn failure). */
  readonly error?: string;
  /** Setup/cancellation failures are distinct from a check that actually ran. */
  readonly errorCode?: "workspace-unavailable" | "cancelled";
  /**
   * The throwaway copy could not be removed afterwards (a file still
   * busy on Windows, say). A warning only: the run's own outcome — pass
   * or fail — stands.
   */
  readonly cleanupWarning?: string;
  /**
   * The call was cancelled while the executor ran. Its fields (command
   * line, exit code, output) are kept as evidence; the run never passes.
   */
  readonly aborted?: boolean;
  readonly commandLine?: string;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly ready?: boolean;
  readonly readyMs?: number | null;
  readonly requests?: readonly RequestOutcome[];
  readonly errors?: readonly string[];
  readonly consoleErrors?: readonly string[];
  readonly consoleWarnings?: readonly string[];
  readonly requestFailures?: readonly string[];
  readonly missingSelectors?: readonly string[];
  readonly probes?: Readonly<Record<string, ProbeSample[]>>;
  readonly checks?: readonly CheckOutcome[];
  /** What the failure means and what to do instead (a terminal-only program, say). */
  readonly hint?: string;
  readonly summary: string;
}

/**
 * What `verify.run` reads from the config: browser settings for page
 * runs and the workspace copy limit (`tools.verify.maxCopyBytes`, the
 * built-in 2 GiB when absent). A full `AtomicAgentConfig` fits.
 */
export type VerifyRunConfig = Pick<AtomicAgentConfig, "browser"> & {
  readonly tools?: { readonly verify?: { readonly maxCopyBytes?: number } };
};

export interface VerifyRunContext {
  readonly inputIntegrity?: VerificationInputIntegrity;
  readonly workingDir: string;
  /** Browser settings and copy limit; `getConfig().browser` for page runs when omitted. */
  readonly config?: VerifyRunConfig;
  readonly signal?: AbortSignal;
  /** Test seams. */
  readonly launchBrowser?: BrowserLauncher;
  readonly fetchImpl?: FetchLike;
  readonly workspace?: (workingDir: string) => Promise<VerifyWorkspace>;
}

/** `cwd` relative to the copy, refused when it escapes it. */
function resolveRunCwd(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return root;
  const target = resolve(root, cwd);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`verify.run: \`cwd\` must stay inside the working directory (got ${cwd})`);
  }
  return target;
}

function finish(
  base: Omit<VerifyRunResult, "ok" | "summary" | "checks" | "durationMs">,
  subject: CheckSubject,
  specs: readonly string[] | undefined,
  runOk: boolean,
  started: number,
): VerifyRunResult {
  // A run that did not happen (no browser, a server that never came up,
  // a command that could not start) evaluates nothing: `no errors` over
  // an empty error list would be the fake pass this tool exists to
  // refuse.
  const checks =
    specs === undefined || specs.length === 0
      ? undefined
      : base.error !== undefined
        ? specs.map((check) => ({ check, ok: false, detail: `not evaluated: ${base.error}` }))
        : evaluateChecks(specs, subject);
  const ok = runOk && (checks?.every((c) => c.ok) ?? true);
  const withoutSummary = { ...base, ok, durationMs: Date.now() - started, ...(checks === undefined ? {} : { checks }) };
  return { ...withoutSummary, summary: renderVerifyRunSummary({ ...withoutSummary, summary: "" }) };
}

async function runInWorkspace(args: VerifyRunArgs, dir: string, isolated: boolean, ctx: VerifyRunContext, started: number): Promise<VerifyRunResult> {
  const cwd = resolveRunCwd(dir, args.cwd);
  const common = { kind: args.kind, isolated };
  if (args.kind === "command") {
    const out = await runCommandKind(args, { cwd, signal: ctx.signal });
    const runOk = out.spawnError === undefined && !out.timedOut && out.exitCode === 0;
    const hint = runOk ? undefined : terminalAppHint(out.stdout, out.stderr);
    return finish(
      { ...common, ...(hint === undefined ? {} : { hint }), commandLine: out.commandLine, exitCode: out.exitCode, timedOut: out.timedOut, stdoutTail: out.stdoutTail, stderrTail: out.stderrTail, ...(out.spawnError === undefined ? {} : { error: `could not start \`${out.commandLine}\`: ${out.spawnError}` }) },
      { kind: "command", exitCode: out.exitCode, timedOut: out.timedOut, stdout: out.stdout, stderr: out.stderr },
      args.checks, runOk, started,
    );
  }
  if (args.kind === "service") {
    const out = await runServiceKind(args, { cwd, signal: ctx.signal, fetchImpl: ctx.fetchImpl });
    const runOk = out.ready && out.requests.every((q) => q.ok);
    return finish(
      { ...common, commandLine: out.commandLine, exitCode: out.exitCode, timedOut: out.timedOut, ready: out.ready, readyMs: out.readyMs, requests: out.requests, stdoutTail: out.stdoutTail, stderrTail: out.stderrTail, ...(out.readyError === undefined ? {} : { error: out.readyError }) },
      { kind: "service", exitCode: out.exitCode, timedOut: out.timedOut, stdout: out.stdout, stderr: out.stderr, requests: out.requests },
      args.checks, runOk, started,
    );
  }
  const launch =
    ctx.launchBrowser ??
    defaultBrowserLauncher(ctx.config ?? { browser: getConfig().browser });
  if (args.start === undefined) {
    const out = await runPageKind(args, { cwd, signal: ctx.signal, launch });
    return finishPage(common, out, {}, args, started);
  }
  // The page is served by its own server: the browser opens it only once
  // the server is ready, and the server stays up until the page run ends.
  const held: { page?: PageRunOutcome } = {};
  const server = await runServiceKind(args, {
    cwd,
    signal: ctx.signal,
    fetchImpl: ctx.fetchImpl,
    whileReady: async () => {
      held.page = await runPageKind(args, { cwd, signal: ctx.signal, launch });
    },
  });
  const serverFields = {
    commandLine: server.commandLine,
    exitCode: server.exitCode,
    timedOut: server.timedOut,
    ready: server.ready,
    readyMs: server.readyMs,
    stdoutTail: server.stdoutTail,
    stderrTail: server.stderrTail,
  };
  const page = held.page;
  if (page === undefined) {
    const error = server.readyError ?? "the page server was not ready";
    return finish(
      { ...common, ...serverFields, error: `page server: ${error}` },
      { kind: "page", errors: [], consoleErrors: [], missingSelectors: [], probes: {} },
      args.checks, false, started,
    );
  }
  return finishPage(common, page, serverFields, args, started);
}

function finishPage(
  common: { kind: VerifyRunKind; isolated: boolean },
  out: PageRunOutcome,
  extra: Partial<VerifyRunResult>,
  args: VerifyRunArgs,
  started: number,
): VerifyRunResult {
  const runOk = out.launched && out.loaded && out.errors.length === 0 && out.consoleErrors.length === 0;
  return finish(
    { ...common, ...extra, errors: out.errors, consoleErrors: out.consoleErrors, consoleWarnings: out.consoleWarnings, requestFailures: out.requestFailures, missingSelectors: out.missingSelectors, probes: out.probes, ...(out.error === undefined ? {} : { error: out.error }) },
    { kind: "page", errors: out.errors, consoleErrors: out.consoleErrors, missingSelectors: out.missingSelectors, probes: out.probes },
    args.checks, runOk, started,
  );
}

/** Run one spec against a throwaway copy of `ctx.workingDir`. */
export async function runVerify(
  rawArgs: VerifyRunArgs | Record<string, unknown>,
  ctx: VerifyRunContext,
): Promise<VerifyRunResult> {
  const started = Date.now();
  const args = parseVerifyRunArgs(rawArgs as Record<string, unknown>);
  const failed = (error: string, errorCode: VerifyRunResult["errorCode"], isolated = false): VerifyRunResult =>
    finish({ kind: args.kind, isolated, error, ...(errorCode === undefined ? {} : { errorCode }) }, { kind: args.kind }, args.checks, false, started);
  if (ctx.signal?.aborted) return failed("verification cancelled before execution", "cancelled");
  let workspace: VerifyWorkspace | undefined;
  let result: VerifyRunResult;
  try {
    const maxBytes = ctx.config?.tools?.verify?.maxCopyBytes;
    workspace = await (ctx.workspace ?? ((dir: string) => createVerifyWorkspace(dir, maxBytes === undefined ? {} : { maxBytes })))(ctx.workingDir);
    if (ctx.signal?.aborted) {
      result = failed("verification cancelled before execution", "cancelled", workspace.isolated);
    } else if (!workspace.isolated || resolve(workspace.dir) === resolve(ctx.workingDir)) {
      result = failed(`verification not started: ${workspace.error ?? "a private workspace copy is unavailable"}`, "workspace-unavailable");
    } else {
      const completeIntegrity = await ctx.inputIntegrity?.begin(workspace.dir, ctx.signal ?? new AbortController().signal);
      const executionArgs = ctx.inputIntegrity === undefined ? args : rebaseVerifyWorkspaceValue(args, ctx.workingDir, workspace.dir);
      result = await runInWorkspace(executionArgs, workspace.dir, true, ctx, started);
      await completeIntegrity?.();
      // Executors may settle normally after an abort (a page can skip
      // remaining script steps). Such an incomplete run cannot pass.
      // Keep what it did report: the command line, exit code and output
      // are evidence of what ran before the cancellation landed.
      if (ctx.signal?.aborted) {
        const { ok: _ok, summary: _summary, checks: _checks, durationMs: _durationMs, ...fields } = result;
        const error = `verification cancelled during execution${fields.error === undefined ? "" : ` (${fields.error})`}`;
        result = finish({ ...fields, error, errorCode: "cancelled", aborted: true }, { kind: args.kind }, args.checks, false, started);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    result = failed(error, ctx.signal?.aborted ? "cancelled" : workspace === undefined ? "workspace-unavailable" : undefined, workspace?.isolated ?? false);
  }
  try {
    await workspace?.cleanup();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const warned = { ...result, cleanupWarning: `could not remove the verification copy ${workspace?.dir ?? ""}: ${error}` };
    result = { ...warned, summary: renderVerifyRunSummary(warned) };
  }
  return result;
}

/** The fan-out contract's checks: every spec in order, `ok` when all are. */
export const runChecks = Object.assign(async function runChecks(
  specs: readonly (VerifyRunArgs | Record<string, unknown>)[],
  ctx: VerifyRunContext,
): Promise<{ ok: boolean; results: VerifyRunResult[] }> {
  const results: VerifyRunResult[] = [];
  for (const spec of specs) {
    if (ctx.signal?.aborted) break;
    try {
      results.push(await runVerify(spec, ctx));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const kind = (typeof spec.kind === "string" ? spec.kind : "command") as VerifyRunKind;
      results.push({ ok: false, kind, isolated: true, durationMs: 0, error, summary: `verify.run ${kind}: FAILED\n${error}` });
    }
  }
  return { ok: results.length === specs.length && results.every((r) => r.ok), results };
}, { supportsInputIntegrity: true as const });
