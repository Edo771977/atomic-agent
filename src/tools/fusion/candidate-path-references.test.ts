import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import { runChecks, runVerify, type VerifyRunResult } from "../verify/run-verify.js";
import { createVerifyWorkspace } from "../verify/verify-workspace-copy.js";
import type { ContractCheckRunner } from "./contract-checks.js";
import type { WorkerTaskResult } from "./worker-result.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const rows: WorkerTaskResult[] = [{ id: "a", title: "a", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];

it("rejects a candidate when an attached redirection must read changed execution-copy bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "atag-literal-reference-")); roots.push(root);
  await writeFile(join(root, "a.txt"), "hello\n");
  const candidate = await createCandidateIntegration(root, { git: async () => null, maxCopyBytes: 1024 * 1024 });
  try {
    await writeFile(join(candidate.dir, "a.txt"), "changed\n");
    const command = `${process.platform === "win32" ? "findstr /c:hello" : "grep -x hello"} <${join(root, "a.txt")}`;
    const executions: VerifyRunResult[] = [];
    const runner: ContractCheckRunner = async (specs, ctx) => {
      const result = await runChecks(specs, ctx); executions.push(...result.results); return result;
    };
    const report = await candidate.finish({ rows, signal: new AbortController().signal, contract: { checks: [{ kind: "command", cmd: command, checks: ["exit 0"] }] }, runChecks: runner });
    expect(executions).toHaveLength(1);
    expect(executions[0]?.error).toBeUndefined();
    expect(executions[0]?.commandLine).not.toContain(join(root, "a.txt"));
    expect(executions[0]?.exitCode).toBe(1);
    expect(executions[0]?.stdoutTail).not.toContain("hello");
    expect(report.status).toBe("rejected");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hello\n");
  } finally { await candidate.cleanup(); }
});

it("imports a source file URL from the actual verify execution copy with query and fragment intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "atag-uri reference ")); roots.push(root);
  const name = "module #%.mjs";
  await writeFile(join(root, name), "export default import.meta.url;\n");
  const url = new URL(pathToFileURL(join(root, name))); url.search = "?input=%2Fproject"; url.hash = "#same%20tag";
  let execution = "";
  const result = await runVerify({ kind: "command", cmd: process.execPath, args: ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(url.href)})).default)`], checks: ["exit 0"] }, {
    workingDir: root,
    workspace: async dir => { const workspace = await createVerifyWorkspace(dir); execution = workspace.dir; return workspace; },
  });
  const actual = pathToFileURL(join(execution, name)); actual.search = url.search; actual.hash = url.hash;
  expect(result.error).toBeUndefined(); expect(result.ok).toBe(true);
  expect(result.stdoutTail?.trim()).toBe(actual.href);
  expect(result.stdoutTail).not.toContain(pathToFileURL(root).href);
});

it("checks candidate module bytes through a rebased file URL in the actual execution copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "atag-candidate-uri ")); roots.push(root);
  await writeFile(join(root, "module.mjs"), 'export const value = "original"; export const url = import.meta.url;\n');
  const candidate = await createCandidateIntegration(root, { git: async () => null, maxCopyBytes: 1024 * 1024 });
  try {
    await writeFile(join(candidate.dir, "module.mjs"), 'export const value = "candidate"; export const url = import.meta.url;\n');
    const url = pathToFileURL(join(root, "module.mjs")).href;
    const executionRoots: string[] = [], executions: VerifyRunResult[] = [];
    const runner: ContractCheckRunner = async (specs, ctx) => {
      const result = await runChecks(specs, { ...ctx, workspace: async dir => {
        const workspace = await createVerifyWorkspace(dir); executionRoots.push(workspace.dir); return workspace;
      } });
      executions.push(...result.results); return result;
    };
    const report = await candidate.finish({ rows, signal: new AbortController().signal, contract: { checks: [{ kind: "command", cmd: process.execPath, args: ["--input-type=module", "-e", `const x = await import(${JSON.stringify(url)}); console.log(x.value, x.url);`], checks: ["exit 0", 'stdout contains "candidate"'] }] }, runChecks: runner });
    expect(executions).toHaveLength(1); expect(executionRoots).toHaveLength(1);
    expect(executions[0]?.error).toBeUndefined(); expect(executions[0]?.ok).toBe(true);
    expect(executions[0]?.stdoutTail?.trim()).toBe(`candidate ${pathToFileURL(join(executionRoots[0]!, "module.mjs")).href}`);
    expect(report.status).toBe("promoted");
    expect(await readFile(join(root, "module.mjs"), "utf8")).toContain('"candidate"');
  } finally { await candidate.cleanup(); }
});
