import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import { runChecks, type VerifyRunResult } from "../verify/run-verify.js";
import { createVerifyWorkspace } from "../verify/verify-workspace-copy.js";
import type { ContractCheckRunner } from "./contract-checks.js";
import type { WorkerTaskResult } from "./worker-result.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const rows: WorkerTaskResult[] = [{ id: "a", title: "a", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atag-candidate-root-alias-"))); roots.push(root);
  const actual = join(root, "actual"), alias = join(root, "requested"); await mkdir(actual);
  // A junction needs no Windows symlink privilege and also exercises the
  // requested-spelling versus realpath distinction behind 8.3 temp roots.
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await realpath(alias)).toBe(actual); expect(alias).not.toBe(actual);
  await writeFile(join(actual, "a.txt"), "original");
  return { actual, alias };
}

it.each(["absolute alias", "relative alias", "canonical"])("checks %s file references using the actual verification execution copy", async spelling => {
  const f = await project();
  const requested = spelling === "relative alias" ? relative(process.cwd(), f.alias) : f.alias;
  const source = spelling === "canonical" ? f.actual : f.alias;
  const candidate = await createCandidateIntegration(requested, { git: async () => null, maxCopyBytes: 1024 * 1024 });
  try {
    await writeFile(join(candidate.dir, "a.txt"), "worker-edited");
    const executions: VerifyRunResult[] = [], executionRoots: string[] = [];
    const runner: ContractCheckRunner = async (specs, ctx) => {
      const result = await runChecks(specs, { ...ctx, workspace: async dir => {
        const workspace = await createVerifyWorkspace(dir); executionRoots.push(workspace.dir); return workspace;
      } }); executions.push(...result.results); return result;
    };
    const report = await candidate.finish({ rows, signal: new AbortController().signal, contract: { checks: [{ kind: "command", cmd: process.execPath,
      args: ["-e", "console.log(require('node:fs').readFileSync(process.argv[1], 'utf8')); console.log(process.argv[1]);", join(source, "a.txt")],
      checks: ["exit 0", 'stdout contains "worker-edited"'] }] }, runChecks: runner });
    expect(executions).toHaveLength(1); expect(executionRoots).toHaveLength(1);
    expect(executions[0]?.error).toBeUndefined(); expect(executions[0]?.ok).toBe(true);
    expect(executions[0]?.stdoutTail?.trim()).toBe(`worker-edited\n${join(executionRoots[0]!, "a.txt")}`);
    expect(report.status).toBe("promoted");
    expect(await readFile(join(f.actual, "a.txt"), "utf8")).toBe("worker-edited");
  } finally { await candidate.cleanup(); }
});

it("checks a requested root alias file URL inside the execution copy, preserving query and fragment", async () => {
  const f = await project();
  await writeFile(join(f.actual, "module.mjs"), 'export const value = "original"; export const url = import.meta.url;');
  const candidate = await createCandidateIntegration(f.alias, { git: async () => null, maxCopyBytes: 1024 * 1024 });
  try {
    await writeFile(join(candidate.dir, "module.mjs"), 'export const value = "worker-edited"; export const url = import.meta.url;');
    const source = pathToFileURL(join(f.alias, "module.mjs")); source.search = "?input=%2Fproject"; source.hash = "#same%20tag";
    const executions: VerifyRunResult[] = [], executionRoots: string[] = [];
    const runner: ContractCheckRunner = async (specs, ctx) => {
      const result = await runChecks(specs, { ...ctx, workspace: async dir => {
        const workspace = await createVerifyWorkspace(dir); executionRoots.push(workspace.dir); return workspace;
      } }); executions.push(...result.results); return result;
    };
    const report = await candidate.finish({ rows, signal: new AbortController().signal, contract: { checks: [{ kind: "command", cmd: process.execPath,
      args: ["--input-type=module", "-e", `const x = await import(${JSON.stringify(source.href)}); console.log(x.value, x.url);`], checks: ["exit 0", 'stdout contains "worker-edited"'] }] }, runChecks: runner });
    const expected = pathToFileURL(join(executionRoots[0]!, "module.mjs")); expected.search = source.search; expected.hash = source.hash;
    expect(executions).toHaveLength(1); expect(executions[0]?.error).toBeUndefined(); expect(executions[0]?.ok).toBe(true);
    expect(executions[0]?.stdoutTail?.trim()).toBe(`worker-edited ${expected.href}`);
    expect(report.status).toBe("promoted");
  } finally { await candidate.cleanup(); }
});

it.runIf(process.platform === "win32").each(["=", " = "])("checks a protected PowerShell path-list through the requested root alias (%j)", async assignment => {
  const f = await project(); await mkdir(join(f.actual, "lib"));
  await writeFile(join(f.actual, "lib", "literal-check.js"), 'module.exports="original";');
  const check = 'console.log(require("literal-check"));'; await writeFile(join(f.actual, "check.cjs"), check);
  const candidate = await createCandidateIntegration(f.alias, { git: async () => null, maxCopyBytes: 1024 * 1024, checkInputs: ["check.cjs"] });
  try {
    await writeFile(join(candidate.dir, "lib", "literal-check.js"), 'module.exports="worker-edited";');
    const cmd = `powershell.exe -NoProfile -NonInteractive -Command "$env:NODE_PATH${assignment}'C:\\external;${join(f.alias, "lib")}'; & '${process.execPath}' check.cjs"`;
    const executions: VerifyRunResult[] = [];
    const runner: ContractCheckRunner = Object.assign(async (specs: readonly Record<string, unknown>[], ctx: Parameters<ContractCheckRunner>[1]) => {
      const result = await runChecks(specs, ctx); executions.push(...result.results); return result;
    }, { supportsInputIntegrity: true as const });
    const report = await candidate.finish({ rows, signal: new AbortController().signal, contract: { checkInputs: ["check.cjs"], checks: [{ kind: "command", cmd, checks: ["exit 0", 'stdout contains "original"'] }] }, runChecks: runner });
    expect(executions).toHaveLength(1); expect(executions[0]?.error).toBeUndefined();
    expect(executions[0]?.commandLine).not.toContain(join(f.alias, "lib"));
    expect(executions[0]?.stdoutTail?.trim()).toBe("worker-edited");
    expect(report.status).toBe("rejected"); expect(report.acceptanceReceipt?.checkScope).toBe("protected-declared");
    expect(await readFile(join(f.actual, "lib", "literal-check.js"), "utf8")).toContain('"original"');
    expect(await readFile(join(f.actual, "check.cjs"), "utf8")).toBe(check);
  } finally { await candidate.cleanup(); }
});
