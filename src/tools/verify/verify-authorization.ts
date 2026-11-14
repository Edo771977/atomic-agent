import { isAbsolute, relative, resolve } from "node:path";
import { ApprovalDeniedError, requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { knownSecretsFromEnv, maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import { isSecretEnvName } from "../../sandbox/command-env.js";
import { execWriteTargets, shellWriteTargets, type ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import { shellCommandArgv, shellRuleSegments, shellRunsUnreadableScript } from "../os/shell/shell-command-argv.js";
import { formatShellPreview, needsShellInterpretation, shellGrantShape } from "../os/shell/shell-interpretation.js";
import type { CommandReadCheck, ReadTargetCheck } from "../read-scope/confine-reads.js";
import type { ToolContext } from "../tool-registry.js";
import { rebaseVerifyWorkspaceValue } from "./rebase-verify-workspace.js";
import { guardVerifyRun, verifyRunCommands } from "./verify-run-guard.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";
import { localFileOfUrl, invalidLocalFileUrlReason } from "../read-scope/read-scope-targets.js";

/** No partial consent: oversized plans are refused before prompting or executing. */
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
export class VerifyGuardRefusal extends Error {
  constructor(readonly guardRule: string, readonly guardReason: string) {
    super(`verify.run: blocked by shell guard: ${guardRule} - ${guardReason}`);
  }
}
/** Approval surfaces must honor the canonical credential set even for non-vendor strings. */
export function maskVerificationSecrets(text: string, known: readonly KnownSecret[]): string {
  let masked = maskSecrets(text, known);
  const values = [...new Set(known.map(secret => secret.value).filter(value => value.length > 0))].sort((a, b) => b.length - a.length);
  for (const value of values) masked = masked.split(value).join("[redacted:credential]");
  return masked;
}
function maskedVerificationValue(value: unknown, known: readonly KnownSecret[]): unknown {
  if (typeof value === "string") return maskVerificationSecrets(value, known);
  if (Array.isArray(value)) return value.map(item => maskedVerificationValue(item, known));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [maskVerificationSecrets(key, known), maskedVerificationValue(item, known)]));
  return value;
}
export interface VerifyAuthorizationOptions extends DangerousToolOptions {
  shellPolicy?: ShellGuardPolicy;
  checkCommandReads?: CommandReadCheck;
  checkReadTargets?: ReadTargetCheck;
  knownSecrets?: readonly KnownSecret[];
  /** Interactive checks may use a worker's approved scope; contract checks have their own preflight. */
  allowFanoutScope?: boolean;
}
export interface VerifyAuthorizationContext extends ToolContext {
  /** Rules and displayed project paths belong to the original project, never a private copy. */
  ruleWorkdir?: string;
  checkInputs?: readonly string[];
}

export function resolveVerifyCwd(root: string, cwd: string | undefined): string {
  const target = cwd === undefined ? resolve(root) : resolve(root, cwd);
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("verify.run: `cwd` must stay inside the working directory");
  }
  return target;
}

const VERIFICATION_FIELDS = new Set([
  "kind", "type", "cmd", "command", "args", "start", "cwd", "env", "timeoutMs", "network",
  "ready", "requests", "path", "url", "script", "seconds", "probes", "checks", "task",
]);

/** Reject alternative executor meanings before interpreting or describing any plan. */
function assertDeclaredVerificationSchema(spec: Record<string, unknown>, approvalRequired: boolean): void {
  const present = (object: Record<string, unknown>, key: string): boolean => object[key] !== undefined && object[key] !== null;
  if (present(spec, "cmd") && present(spec, "command")) throw new Error("ambiguous verification command: cmd and command cannot both be present");
  if (present(spec, "kind") && present(spec, "type")) throw new Error("ambiguous verification kind: kind and type cannot both be present");
  const kind = spec.kind ?? spec.type;
  const start = typeof spec.start === "object" && spec.start !== null && !Array.isArray(spec.start) ? spec.start as Record<string, unknown> : undefined;
  if (start !== undefined && present(start, "cmd") && present(start, "command")) throw new Error("ambiguous verification start: cmd and command cannot both be present");
  if (approvalRequired) {
    const unsupported = Object.keys(spec).find(key => !VERIFICATION_FIELDS.has(key));
    if (unsupported !== undefined) throw new Error("unsupported verification executor field");
    if (start !== undefined && Object.keys(start).some(key => key !== "cmd" && key !== "args")) throw new Error("unsupported verification start executor field");
  }
  const nonempty = (value: unknown): boolean => typeof value === "string" && value.length > 0 || Array.isArray(value) && value.length > 0;
  if ((kind === "service" || kind === "page") && [spec.cmd, spec.command, spec.args].some(nonempty)) throw new Error("conflicting verification executors: a service or page must use start, not a command");
  if (kind === "command" && start !== undefined && [start.cmd, start.command, start.args].some(nonempty)) throw new Error("conflicting verification executors: a command must not also declare start");
}

/**
 * A check is a verify.run call, including when fusion owns it. This deliberately
 * preserves verify.run tool rules; shell deny/ask command-prefix rules cross
 * that boundary through commandSegments, while shell-only allows never do.
 * All hard refusals and saved denies are checked for the WHOLE batch before
 * the first question, then every check is approved before the runner starts.
 */
export async function authorizeVerifyBatch(
  specs: readonly Record<string, unknown>[],
  options: VerifyAuthorizationOptions,
  ctx: VerifyAuthorizationContext,
): Promise<readonly Record<string, unknown>[]> {
  ctx.signal.throwIfAborted();
  const serialized = JSON.stringify(specs);
  if (Buffer.byteLength(serialized) > MAX_AUTHORIZATION_BYTES) throw new Error("verification authorization plan exceeds the size limit");
  const snapshot = JSON.parse(serialized) as Record<string, unknown>[];
  for (const spec of snapshot) assertDeclaredVerificationSchema(spec, options.approvalRequired);
  const project = ctx.ruleWorkdir ?? ctx.workingDir;
  const known = [...knownSecretsFromEnv(), ...(options.knownSecrets ?? [])];
  const plans = snapshot.flatMap(spec => {
    // The injected runner API historically accepts non-process fixture/check
    // specs too. A trusted embedder explicitly opting out of approvals may
    // keep those; production cannot authorize an undisclosed executor.
    const kind = spec.kind ?? spec.type;
    const namedCommand = typeof spec.cmd === "string" || typeof spec.command === "string" ||
      typeof spec.start === "object" && spec.start !== null;
    if (kind === "command" && !namedCommand) {
      if (!options.approvalRequired) return [];
      throw new Error("verification check has no disclosed command; cannot authorize its executor");
    }
    const policySpec = spec.cmd === undefined && kind === "command" && typeof spec.command === "string" ? { ...spec, kind, cmd: spec.command } : { ...spec, kind };
    const actual = parseVerifyRunArgs(policySpec);
    const actualCwd = resolveVerifyCwd(ctx.workingDir, actual.cwd);
    const guard = guardVerifyRun(actual, actualCwd, options.shellPolicy);
    if (guard.blocked !== null) throw new VerifyGuardRefusal(guard.blocked.verdict.rule, guard.blocked.verdict.reason);
    const logical = parseVerifyRunArgs(rebaseVerifyWorkspaceValue(policySpec, ctx.workingDir, project));
    const cwd = resolveVerifyCwd(project, logical.cwd);
    const commands = verifyRunCommands(logical);
    const commandSegments = commands.flatMap(c => shellRuleSegments(c.cmd, c.args, needsShellInterpretation(c.cmd, c.args)));
    const commandUnreadable = commands.some(c => shellRunsUnreadableScript(c.cmd, c.args, needsShellInterpretation(c.cmd, c.args)));
    const targetPaths = commands.flatMap(c => needsShellInterpretation(c.cmd, c.args) ? shellWriteTargets([c.cmd, ...c.args].join(" "), cwd) : execWriteTargets(c.cmd, c.args, cwd));
    const dangerous = guard.dangerous.length > 0;
    const first = commands.length === 1 ? commands[0] : undefined;
    const shape = first === undefined || dangerous ? undefined : shellGrantShape(first.cmd, [first.cmd, ...first.args].join(" "), needsShellInterpretation(first.cmd, first.args));
    const commandArgv = first === undefined ? undefined : shellCommandArgv(first.cmd, first.args, needsShellInterpretation(first.cmd, first.args), shape);
    const env = Object.fromEntries(Object.entries(logical.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, isSecretEnvName(name) ? `[redacted:env:${name}]` : value]));
    const metadata = JSON.stringify({ commandArgv, commandSegments, targetPaths });
    const metadataWords = [...(commandArgv ?? []), ...commandSegments.flat(), ...targetPaths];
    const credentialValues = [...known.map(secret => secret.value), ...Object.entries(logical.env ?? {}).filter(([name]) => isSecretEnvName(name)).map(([, value]) => value)];
    const explicitCredential = credentialValues.some(value => value.length > 0 && metadataWords.some(word => word.includes(value)));
    if (explicitCredential || maskSecrets(metadata, [...known, ...knownSecretsFromEnv(logical.env)]) !== metadata) {
      throw new Error("verification command credentials cannot be safely represented in approval metadata; pass credentials through the explicit environment instead");
    }
    const previewKnown = [...known, ...knownSecretsFromEnv(logical.env)];
    const preview = [
      ...commands.map(c => maskVerificationSecrets(formatShellPreview(c.cmd, c.args, needsShellInterpretation(c.cmd, c.args)), previewKnown)),
      JSON.stringify(maskedVerificationValue({ ...logical, cwd, env, checkInputs: ctx.checkInputs ?? [], execution: "in a private verification copy of this project; absolute project references are rebased into that copy" }, previewKnown), null, 2),
    ].join("\n");
    if (Buffer.byteLength(preview) > MAX_AUTHORIZATION_BYTES) throw new Error("verification authorization preview exceeds the size limit");
    const prompt = {
      sessionId: ctx.sessionId, tool: "verify.run", category: dangerous ? "shell_dangerous" as const : "shell" as const,
      reason: `${dangerous ? `${guard.dangerous.map(c => c.verdict.reason).join("; ")} — ` : ""}verify (${logical.kind}) in a throwaway copy of ${cwd}; the copy is not a sandbox`,
      preview, affectedResources: [cwd], targetPaths, commandSegments,
      ...(commandUnreadable ? { commandUnreadable } : {}),
      ...(commandArgv === undefined ? {} : { commandArgv }), workdir: project,
    };
    return [{ prompt, logical, cwd }];
  });
  // A deny for a later command wins before asking about an earlier command.
  for (const { prompt } of plans) {
    if (options.approvalRequired && options.approvals.ruleDecisionFor?.(prompt) === "deny") {
      await requireApproval(options, prompt, ctx.signal);
      throw new ApprovalDeniedError("verify.run", "blocked by a saved rule", { byUser: false });
    }
  }
  for (const { logical, cwd } of plans) {
    const readContext = { ...ctx, workingDir: cwd, readRoots: [project, ...(ctx.readRoots ?? [])] };
    const paths = logical.kind === "page" && logical.path !== undefined ? [resolve(cwd, logical.path)] : [];
    const urls = [logical.url, logical.ready?.url, ...(logical.requests ?? []).flatMap(request => [request.url, request.path])];
    for (const url of urls) {
      if (url === undefined) continue;
      const invalid = invalidLocalFileUrlReason(url);
      if (invalid !== null) throw new Error(`verification read target ${invalid}`);
      const path = localFileOfUrl(url);
      if (path !== null) paths.push(path);
    }
    for (const path of new Set(paths)) {
      ctx.signal.throwIfAborted();
      const refusal = await options.checkReadTargets?.("verify.run", { path }, readContext, "os.fs.read");
      if (refusal !== undefined && refusal !== null) throw new Error(maskSecrets(refusal.summary, known));
    }
    for (const command of verifyRunCommands(logical)) {
      ctx.signal.throwIfAborted();
      const refusal = await options.checkCommandReads?.("verify.run", { cmd: command.cmd, args: command.args, env: logical.env }, { ...ctx, workingDir: cwd, readRoots: [project, ...(ctx.readRoots ?? [])] });
      if (refusal !== undefined && refusal !== null) throw new Error(maskSecrets(refusal.summary, known));
    }
  }
  for (const { prompt, cwd } of plans) {
    ctx.signal.throwIfAborted();
    const scoped = options.allowFanoutScope === true && prompt.category === "shell" &&
      !(options.approvals.holdsForOutsideContent?.(ctx.sessionId, "shell") ?? false) &&
      (options.approvals.fanoutScopes?.allows(ctx.sessionId, [cwd]) ?? false) &&
      !(options.approvals.hasDeclinedTarget?.(prompt) ?? false) &&
      !["deny", "ask"].includes(options.approvals.ruleDecisionFor?.(prompt) ?? "");
    if (!scoped) await requireApproval(options, prompt, ctx.signal);
  }
  ctx.signal.throwIfAborted();
  return snapshot;
}
