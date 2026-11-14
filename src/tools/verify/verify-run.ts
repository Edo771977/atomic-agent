/**
 * `verify.run` — one tool to run what was built: a command, a service
 * or a page, against a throwaway copy of the working directory.
 *
 * Requires a copy before execution; setup failures refuse the run. The
 * readonly metadata lets the fusion orchestrator gate run it (decision D1).
 * Shared dependency directories and user symlinks retain their targets. It
 * still executes things, so below the approval ladder's shell rung it
 * asks under the same category as `os.shell.run`; an authorised fan-out
 * scope covers it the way it covers a worker's shell command. At level
 * 5 (`--no-approval`) it runs without asking.
 *
 * The copy is not a sandbox, so every command it starts first passes
 * the shell guard (ATO-1266): a hardline or policy rule refuses the call
 * before anything runs, at every level; a `dangerous.*` match asks as
 * `shell_dangerous`, which no fan-out scope and no `shell` grant covers.
 */
import { authorizeVerifyBatch, maskVerificationSecrets, VerifyGuardRefusal, type VerifyAuthorizationOptions } from "./verify-authorization.js";
import { markToolReadPolicy } from "../read-scope/confine-reads.js";
import type { KnownSecret } from "../../error-reporting/secret-detector.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserLauncher } from "./run-page-kind.js";
import { runVerify, type VerifyRunConfig, type VerifyRunContext } from "./run-verify.js";
import { parseVerifyRunArgs, type VerifyRunArgs } from "./verify-run-args.js";
export const VERIFY_RUN_TOOL = "verify.run";

export interface VerifyRunToolOptions extends VerifyAuthorizationOptions {
  /** Live canonical runtime credentials, including configured custom keys. */
  resolveKnownSecrets?: () => readonly KnownSecret[];
  /** Browser settings and `tools.verify.maxCopyBytes`. */
  config: VerifyRunConfig;
  /**
   * Operator policy for the shell guard (the git remote-sync switch),
   * the same predicates `os.shell.run` gets. Omitted by embedders and
   * tests, which then get the static rule set.
   */
  shellPolicy?: ShellGuardPolicy;
  /** Test seam: replaces the real browser launch. */
  launchBrowser?: BrowserLauncher;
  /** Test/embedder seam; unavailable copies are refused by runVerify. */
  workspace?: VerifyRunContext["workspace"];
}

/** What the operator is asked to approve, in one line. */
export function describeVerifyRun(args: VerifyRunArgs): string {
  if (args.kind === "command") return [args.cmd, ...(args.args ?? [])].join(" ");
  if (args.kind === "service") {
    const start = [args.start?.cmd, ...(args.start?.args ?? [])].join(" ");
    return `start \`${start}\`, then ${args.requests?.length ?? 0} request(s)`;
  }
  const open = `open ${args.url ?? args.path} headless for ${args.seconds}s`;
  if (args.start === undefined) return open;
  return `start \`${[args.start.cmd, ...(args.start.args ?? [])].join(" ")}\`, then ${open}`;
}

export function buildVerifyRunTool(options: VerifyRunToolOptions): ToolDefinition {
  const definition: ToolDefinition = {
    name: VERIFY_RUN_TOOL,
    description:
      "Run a check against a throwaway copy of the working directory; refuses execution if the copy is unavailable (may require approval). Shared dependency directories and user symlinks retain their targets; the copy does not confine process writes. kind 'command': any test runner, compiler or script ({cmd, args}). kind 'service': {start:{cmd,args}, ready:{port|url}, requests:[{method,path|url,body,expectStatus,expectBody}]}. kind 'page': a local HTML file ({path}) or {url} in a headless browser (with {start, url} the server is started first and the page opens once `ready` passes, by default when the url answers 2xx): {script:[{action:click|key|type|wait,…}]}, then `seconds` of runtime with `probes:[{name, expr}]` sampled every 250 ms; collects uncaught errors, console errors, failed getElementById/querySelector lookups. `checks`: `exit 0`, `exit != 0`, `stdout contains \"x\"`, `stderr not contains \"x\"`, `status 200`, `no errors`, `missing selectors 0`, `probe <name> decreases|increases|equals <v>|reaches <v>|stays <v>`. `network` defaults to false (a proxy-based soft block, not a sandbox). Results are capped: output tails of 8,000 chars, summary of 4,000.",
    readonly: true,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: VerifyRunArgs;
      try {
        args = parseVerifyRunArgs(rawArgs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { tool: VERIFY_RUN_TOOL, status: "error", summary: message, details: { error: message }, truncated: false };
      }
      const description = describeVerifyRun(args);
      let knownSecrets: readonly KnownSecret[];
      try { knownSecrets = [...(options.knownSecrets ?? []), ...(options.resolveKnownSecrets?.() ?? [])]; }
      catch { return { tool: VERIFY_RUN_TOOL, status: "error", summary: "verification authorization credentials are unavailable", details: {}, truncated: false }; }
      try {
        const approved = await authorizeVerifyBatch([rawArgs], { ...options, knownSecrets, allowFanoutScope: true }, ctx);
        args = parseVerifyRunArgs(approved[0]!);
      } catch (error) {
        // Approval denials retain their existing dispatch semantics. Hard
        // policy refusals remain ordinary tool results and never reach IO.
        if (error instanceof Error && error.name === "ApprovalDeniedError") throw error;
        const message = maskVerificationSecrets(error instanceof Error ? error.message : String(error), knownSecrets);
        return { tool: VERIFY_RUN_TOOL, status: "error", summary: message, details: { error: message, description: maskVerificationSecrets(description, knownSecrets), ...(error instanceof VerifyGuardRefusal ? { guardVerdict: "block", guardRule: error.guardRule, guardReason: maskVerificationSecrets(error.guardReason, knownSecrets) } : {}) }, truncated: false };
      }
      const result = await runVerify(args, {
        workingDir: ctx.workingDir,
        config: options.config,
        signal: ctx.signal,
        ...(options.shellPolicy === undefined ? {} : { shellPolicy: options.shellPolicy }),
        ...(options.launchBrowser === undefined ? {} : { launchBrowser: options.launchBrowser }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      });
      const { summary, ...details } = result;
      return {
        tool: VERIFY_RUN_TOOL,
        status: result.ok ? "ok" : "error",
        summary,
        details: { ...details, description },
        truncated: summary.endsWith("[clipped]"),
      };
    },
  };
  return options.checkCommandReads !== undefined && options.checkReadTargets !== undefined ? markToolReadPolicy(definition) : definition;
}
