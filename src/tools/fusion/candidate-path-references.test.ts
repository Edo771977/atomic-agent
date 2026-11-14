import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import { runChecks, type VerifyRunResult } from "../verify/run-verify.js";
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
