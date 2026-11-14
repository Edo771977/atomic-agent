import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ReadScope } from "../../config/index.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import type { ToolContext, ToolDefinition, ToolRegistry } from "../tool-registry.js";
import {
  checkWorkerRead,
  findSessionReadOutside,
  sessionReadRoots,
  workerReadRefusal,
} from "./read-scope.js";
import {
  ReadOutsideApprover,
  readOutsidePrompt,
  shellReadOutsidePrompt,
} from "./read-scope-approval.js";
import {
  findShellPathOutsideScope,
  shellCommandLine,
  type ShellScopeEnv,
} from "./read-scope-shell.js";
import {
  READ_TOOL_TARGETS,
  invalidLocalFileUrlReason,
  invalidReadUrlTarget,
  SHELL_TOOL,
  VERIFY_TOOL,
  verifyRunShellCalls,
} from "./read-scope-targets.js";
import {
  findShellStateSecrets,
  findStateSecretReads,
  stateSecretReadPrompt,
  stateSecretShellPrompt,
  type StateSecrets,
} from "./state-secrets.js";

export interface ConfineReadsOptions {
  /** The directories a fusion worker's fan-out may write in. */
  grantedDirs: (sessionId: string) => readonly string[];
  /**
   * The live `agent.readScope`. Read on every call, so a config change
   * takes effect without a restart. Omitted: only fusion workers are
   * confined and the shell is not wrapped — the pre-v67 install
   * (`confineWorkerReads`).
   */
  readScope?: () => ReadScope;
  /**
   * The ladder a read outside the scope asks through (`fs_read_outside`,
   * `read-scope-approval.ts`). Required with `readScope`: the session
   * scope is a question, and a question needs a gate — an install that
   * forgot the gate would silently be a refusal, which is exactly the
   * half-wiring the throw below exists to catch.
   */
  approvals?: DangerousToolOptions;
  /** The shell check's notion of home and platform; a test seam. */
  shellEnv?: ShellScopeEnv;
  /**
   * The agent's own secret files (`state-secrets.ts`). A read-class call
   * targeting one, or a shell command naming one, asks as `state_secret`
   * for every session and whatever `readScope` says. Requires
   * `approvals`; omitted, nothing is checked (embedders, tests).
   */
  stateSecrets?: StateSecrets;
}

export type ReadTargetCheck = (tool: string, args: Record<string, unknown>, ctx: ToolContext, targetTool?: string) => Promise<CompressedToolResult | null>;

/** Registry reads and programmatic local verification use one canonical boundary. */
export function createReadTargetCheck(options: ConfineReadsOptions): ReadTargetCheck {
  if (options.approvals === undefined && (options.readScope !== undefined || options.stateSecrets !== undefined)) throw new Error("read target checks require an approval gate");
  const asker = options.approvals === undefined ? null : new ReadOutsideApprover(options.approvals);
  const secrets = options.stateSecrets ?? null;
  const scoped = () => options.readScope?.() === "working-dir";
  return async (tool, args, ctx, targetTool = tool) => {
    const invalid = invalidReadUrlTarget(targetTool, args);
    if (invalid !== null) return compressToolResult({
      tool,
      status: "error",
      output: `${tool}: ${invalid.url} ${invalid.why}, so the local file was not opened or read.`,
      details: { url: invalid.url, path: invalid.url, reason: "local_file_refused" },
    });
    const worker = checkWorkerRead(
      targetTool,
      args,
      ctx,
      options.grantedDirs(ctx.sessionId),
    );
    if (worker !== null) return worker;
    // Before the scope: a secret file asks even where reads are
    // unrestricted. Once approved, that file needs no scope question
    // on top for this call (and is not remembered for the next one).
    const secretPaths =
      asker === null || secrets === null
        ? []
        : findStateSecretReads(targetTool, args, ctx, secrets);
    if (asker !== null && secretPaths.length > 0) {
      await asker.confirmStateSecret(
        tool,
        ctx,
        { reason: stateSecretReadPrompt(secretPaths) },
        secretPaths,
      );
    }
    if (asker === null || !scoped()) return null;
    const refusal = await asker.admit(
      tool,
      ctx,
      (roots) =>
        findSessionReadOutside(targetTool, args, ctx, [...roots, ...secretPaths]),
      (path, root) => readOutsidePrompt(path, ctx.workingDir, root),
    );
    return refusal;
  };
}

export type CommandReadCheck = (tool: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<CompressedToolResult | null>;

/** The same pre-exec read/secret boundary for registry tools and programmatic checks. */
export function createCommandReadCheck(options: ConfineReadsOptions): CommandReadCheck {
  if (options.approvals === undefined) {
    if (options.readScope !== undefined || options.stateSecrets !== undefined) throw new Error("command read checks require an approval gate");
    return async () => null;
  }
  const asker = new ReadOutsideApprover(options.approvals);
  const secrets = options.stateSecrets ?? null;
  const scoped = () => options.readScope?.() === "working-dir";
  return async (
    tool: string,
    args: Record<string, unknown>,
    ctx: Parameters<ToolDefinition["run"]>[1],
  ): Promise<CompressedToolResult | null> => {
    // A command naming a secret file asks at every level below full
    // trust, though the shell itself runs unasked from level 4 and a
    // fan-out's directory scope would let it through: neither a level
    // nor a `shell` grant speaks for the agent's keys (ATO-877,
    // ATO-760). A fusion worker's question is refused by its session
    // policy, like any other it cannot have answered.
    const secretPaths =
      secrets === null
        ? []
        : findShellStateSecrets(args, ctx, secrets, options.shellEnv);
    if (secretPaths.length > 0) {
      const commandLine = shellCommandLine(args);
      await asker.confirmStateSecret(
        tool,
        ctx,
        {
          reason: stateSecretShellPrompt(commandLine, secretPaths),
          preview: commandLine,
        },
        secretPaths,
      );
    }
    if (!scoped()) return null;
    if (isFusionWorkerSessionId(ctx.sessionId)) {
      // A worker's world is its task's directories, and there is
      // nobody to ask: the refusal, as for its reads.
      const granted = options.grantedDirs(ctx.sessionId);
      const outside = findShellPathOutsideScope(
        args,
        ctx,
        [ctx.workingDir, ...granted, ...secretPaths],
        options.shellEnv,
      );
      return outside === null
        ? null
        : workerReadRefusal(tool, outside, ctx, granted);
    }
    return asker.admit(
      tool,
      ctx,
      (roots) =>
        findShellPathOutsideScope(
          args,
          ctx,
          [...roots, ...secretPaths],
          options.shellEnv,
        ),
      (path, root) =>
        shellReadOutsidePrompt(
          shellCommandLine(args),
          path,
          ctx.workingDir,
          root,
        ),
    );
  };
}

/** Definitions this module produced, so a second install does not wrap twice. */
const CONFINED = new WeakSet<ToolDefinition>();

/**
 * Wrap every registered read-class tool (and, under a session scope, the
 * shell) so a call is checked before it runs. Call once, after the
 * native tools are registered. Returns the names it confined.
 *
 * Wrapping at the registry rather than inside each tool keeps the rule
 * in one place, and `registry.invoke` is the single path every call —
 * native, batched, or recovered from text — takes. A worker session
 * gets the worker check first (always on, a refusal); then a call that
 * touches one of the agent's own secret files asks as `state_secret`
 * (`state-secrets.ts`, any scope); then, when the scope is
 * `working-dir`, every other session's call outside the roots is asked
 * about, and runs or is refused by the answer.
 */
export function confineReads(
  registry: Pick<ToolRegistry, "has" | "get" | "register">,
  options: ConfineReadsOptions,
): string[] {
  if (options.readScope !== undefined && options.approvals === undefined) {
    throw new Error(
      "confineReads: a session read scope asks through the approval ladder; pass `approvals` with `readScope`",
    );
  }
  if (options.stateSecrets !== undefined && options.approvals === undefined) {
    throw new Error(
      "confineReads: the secret-file guard asks through the approval ladder; pass `approvals` with `stateSecrets`",
    );
  }
  const asker =
    options.approvals === undefined
      ? null
      : new ReadOutsideApprover(options.approvals);
  const confined: string[] = [];
  const checkReadTarget = createReadTargetCheck(options);
  const install = (name: string, run: ToolDefinition["run"]): void => {
    const inner = registry.get(name);
    confined.push(name);
    if (CONFINED.has(inner)) return;
    const wrapped: ToolDefinition = { ...inner, run };
    CONFINED.add(wrapped);
    registry.register(wrapped);
  };

  for (const name of READ_TOOL_TARGETS.keys()) {
    if (!registry.has(name)) continue;
    const inner = registry.get(name);
    install(name, async (args, ctx) => {
      const refusal = await checkReadTarget(name, args, ctx);
      return refusal ?? inner.run(args, ctx);
    });
  }

  if (asker !== null) {
    const checkCommand = createCommandReadCheck(options);
    const commandTools: [string, (args: Record<string, unknown>) => Record<string, unknown>[]][] = [
      [SHELL_TOOL, (args) => [args]],
      // Its copy of the workspace takes the writes, not the reads: `cat`
      // of an absolute path works there, and the output comes back.
      [VERIFY_TOOL, verifyRunShellCalls],
    ];
    for (const [name, callsOf] of commandTools) {
      if (!registry.has(name)) continue;
      const inner = registry.get(name);
      install(name, async (args, ctx) => {
        for (const call of callsOf(args)) {
          const refusal = await checkCommand(name, call, ctx);
          if (refusal !== null) return refusal;
        }
        return inner.run(args, ctx);
      });
    }
  }
  return confined;
}

/** The browser tool whose `url` names a local page as a read target. */
const LOCAL_PAGE_TOOL = "browser.navigate";

/**
 * The read-scope check for a browser page that LANDED on a local file
 * (`BrowserDomainPolicy.localPages`): a redirect or a click the requested
 * URL never named. Built from the same options as `confineReads`, so it
 * sees the same worker scope, secret files, `agent.readScope` and the
 * directories approved so far. It never asks — mid-click there is no
 * call left to put the question to — and the browser refuses the page.
 */
export function localPageCheck(
  options: ConfineReadsOptions,
): (url: string, ctx: Pick<ToolContext, "sessionId" | "workingDir" | "readRoots">) => string | null {
  return (url, ctx) => {
    const invalid = invalidLocalFileUrlReason(url);
    if (invalid !== null) return invalid;
    const args = { url };
    if (checkWorkerRead(LOCAL_PAGE_TOOL, args, ctx, options.grantedDirs(ctx.sessionId)) !== null) {
      return "is outside this worker's directories";
    }
    if (
      options.stateSecrets !== undefined &&
      findStateSecretReads(LOCAL_PAGE_TOOL, args, ctx, options.stateSecrets).length > 0
    ) {
      return "is one of the agent's own secret files";
    }
    if (options.readScope?.() !== "working-dir" || options.approvals === undefined) return null;
    const roots = [
      ...sessionReadRoots(ctx),
      ...options.approvals.approvals.readScopeGrants.rootsFor(ctx.sessionId),
    ];
    return findSessionReadOutside(LOCAL_PAGE_TOOL, args, ctx, roots) === null
      ? null
      : `is outside the read scope (the working directory ${ctx.workingDir} and the paths approved this session)`;
  };
}

/**
 * The fusion-only install: workers confined to their working directory
 * and fan-out scope, every other session untouched, the shell not
 * wrapped. Kept for callers that want exactly that; the runtime installs
 * `confineReads` with the live `agent.readScope` and the ladder instead.
 */
export function confineWorkerReads(
  registry: Pick<ToolRegistry, "has" | "get" | "register">,
  options: { grantedDirs: (sessionId: string) => readonly string[] },
): string[] {
  return confineReads(registry, { grantedDirs: options.grantedDirs });
}
