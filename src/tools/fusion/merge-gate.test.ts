import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";
import { taskPatchPath } from "./branch-diff.js";
import type { ContractCheckRunner } from "./contract-checks.js";
import type { EscalationComplete } from "./escalation.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { applyPostMergeChecks, gatedChecks } from "./merge-gate.js";
import type { WorkerTaskResult } from "./worker-result.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function gitRepo(files: Record<string, string>): Promise<string> {
  const repo = await makeGitRepo("atag-gate-");
  cleanup.push(repo);
  for (const [path, content] of Object.entries(files)) {
    await writeRepoFile(repo, path, content);
  }
  await runGitRaw(repo, ["add", "-A"]);
  await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

const logger = new StructuredLogger({ level: "error", sinks: [] });

function mode(over: Partial<ResolvedRunMode> & { off?: true } = {}): ResolvedRunMode {
  const { off, ...rest } = over;
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 2,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    ...(off === true ? {} : { isolation: "worktree" as const }),
    ...rest,
  };
}

/** Each worker writes `<id>.txt` with what `write` says, in the folder it was given. */
function deps(
  repo: string,
  write: (taskId: string, attempt: number, dir: string) => Promise<void>,
  over: Partial<FusionDelegateDeps> = {},
  runMode: Partial<ResolvedRunMode> & { off?: true } = {},
): FusionDelegateDeps {
  let minted = 0;
  const attempts = new Map<string, number>();
  return {
    runTurn: async (session) => {
      const taskId = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
      const n = (attempts.get(taskId) ?? 0) + 1;
      attempts.set(taskId, n);
      await write(taskId, n, session.workingDir);
      return { session, reason: "reply", stepCount: 1 } as RunTurnResult;
    },
    createEphemeralSession: (meta, workingDir) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: workingDir ?? repo,
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: repo,
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(runMode),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
  };
}

const ctx = (repo: string) => ({
  workingDir: repo,
  sessionId: "s-p",
  stepIndex: 0,
  signal: new AbortController().signal,
});

/** A check passes when `spec.file` exists in the folder it runs in and does not say "bad". */
function fileChecks(seen: Array<{ file: string; dir: string; ok: boolean }>): ContractCheckRunner {
  return async (specs, runCtx) => {
    const results = [];
    for (const spec of specs) {
      const file = String(spec.file);
      const body = await readFile(join(runCtx.workingDir, file), "utf8").catch(() => null);
      const ok = body !== null && !body.includes("bad");
      seen.push({ file, dir: runCtx.workingDir, ok });
      results.push(ok ? { ok: true, summary: "passed" } : { ok: false, error: `${file} is bad` });
    }
    return { ok: results.every((r) => r.ok), results };
  };
}

const TASKS = [
  { id: "one", title: "One", instructions: "write one.txt" },
  { id: "two", title: "Two", instructions: "write two.txt" },
];

describe("merge only green tasks (isolation)", () => {
  it("holds back a task whose own check fails, saves its patch, and merges the green one", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const seen: Array<{ file: string; dir: string; ok: boolean }> = [];
    const d = deps(
      repo,
      (id, _n, dir) => writeFile(join(dir, `${id}.txt`), id === "two" ? "bad\n" : "good\n"),
      { runChecks: fileChecks(seen) },
    );
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: TASKS,
        contract: {
          checks: [
            { task: "one", kind: "command", file: "one.txt" },
            { task: "two", kind: "command", file: "two.txt" },
          ],
        },
      },
      ctx(repo),
    );
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.map((r) => r.status)).toEqual(["ok", "failed"]);
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("good\n");
    await expect(readFile(join(repo, "two.txt"), "utf8")).rejects.toThrow();
    const patch = await readFile(join(repo, taskPatchPath("two")), "utf8");
    expect(patch).toContain("+++ b/two.txt");
    expect(patch).toContain("+bad");
    expect(rows[1]!.notes?.join(" ")).toContain(
      `not merged (its own checks failed: two.txt is bad): its changes to 1 file are kept as a patch at ${taskPatchPath("two").replaceAll("\\", "/")} (\`git apply\` in the folder); the folder is unchanged`,
    );
    // The gate ran the checks in each task's workspace; nothing ran them again on the folder.
    const gateRuns = seen.filter((s) => s.dir !== repo);
    expect(gateRuns.map((s) => s.file).sort()).toEqual(expect.arrayContaining(["one.txt", "two.txt"]));
    expect(seen.filter((s) => s.dir === repo)).toEqual([]);
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });

  it("runs a check no task owns after the merge, on the merged folder", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const seen: Array<{ file: string; dir: string; ok: boolean }> = [];
    const d = deps(repo, (id, _n, dir) => writeFile(join(dir, `${id}.txt`), "good\n"), {
      runChecks: fileChecks(seen),
    });
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: TASKS,
        contract: {
          checks: [
            { task: "one", kind: "command", file: "one.txt" },
            { kind: "command", file: "two.txt" },
          ],
        },
      },
      ctx(repo),
    );
    const post = seen.filter((s) => s.dir === repo);
    expect(post).toEqual([{ file: "two.txt", dir: repo, ok: true }]);
    expect(result.summary).toContain("call-level checks: 1 of 1 passed");
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[0]!.checks).toMatchObject({ total: 1, failed: 0 });
  });

  it("re-runs a judged-red task in the workspace it was judged in and merges it once green", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    let judged = 0;
    const complete: EscalationComplete = async () => {
      judged += 1;
      return {
        content: JSON.stringify({
          items: [{ id: "a2", pass: judged > 1, why: judged > 1 ? "fixed" : "unfinished" }],
        }),
      };
    };
    const firstSeenAtRetry: string[] = [];
    const d = deps(
      repo,
      async (_id, n, dir) => {
        if (n === 1) {
          await writeFile(join(dir, "one.txt"), "draft\n");
          return;
        }
        firstSeenAtRetry.push(await readFile(join(dir, "one.txt"), "utf8"));
        await writeFile(join(dir, "one.txt"), "final\n");
      },
      { escalationComplete: complete },
      { judge: { providerId: "cloud", model: "judge" } },
    );
    let onDiskAfterFirst: string | null = "unset";
    const runTurn = d.runTurn;
    d.runTurn = async (session, message, options) => {
      if (message.includes("A judge found these acceptance items NOT met")) {
        onDiskAfterFirst = await readFile(join(repo, "one.txt"), "utf8").catch(() => null);
      }
      return runTurn(session, message, options);
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "one", title: "One", instructions: "write one.txt", files: ["one.txt"] }] },
      ctx(repo),
    );
    expect(onDiskAfterFirst).toBeNull();
    expect(firstSeenAtRetry).toEqual(["draft\n"]);
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("final\n");
    const row = (result.details.tasks as WorkerTaskResult[])[0]!;
    expect(row.status).toBe("ok");
    expect(row.notes?.join(" ")).toContain("judge: all 2 acceptance items green after one retry");
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });

  it("keeps a task still red after its retry out of the folder, as a patch", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const complete: EscalationComplete = async () => ({
      content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "wrong" }] }),
    });
    const d = deps(
      repo,
      (_id, n, dir) => writeFile(join(dir, "one.txt"), `attempt ${n}\n`),
      { escalationComplete: complete },
      { judge: { providerId: "cloud", model: "judge" } },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "one", title: "One", instructions: "write one.txt", files: ["one.txt"] }] },
      ctx(repo),
    );
    const row = (result.details.tasks as WorkerTaskResult[])[0]!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^judge: 1 of 2 acceptance items not met after one retry/);
    await expect(readFile(join(repo, "one.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(repo, taskPatchPath("one")), "utf8")).toContain("+attempt 2");
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });

  it("holds a task the judge could not verify as needs_orchestrator, so its dependent is held too", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const ran: string[] = [];
    const d = deps(
      repo,
      async (id, _n, dir) => {
        ran.push(id);
        await writeFile(join(dir, `${id}.js`), "x\n");
      },
      // An answer that cannot be read: the judge leaves it unverified.
      { escalationComplete: async () => ({ content: "no json here" }) },
      { judge: { providerId: "cloud", model: "judge" }, autoReplan: 1 },
    );
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: [
          { id: "core", title: "Core", instructions: "make core.js", files: ["core.js"] },
          { id: "ui", title: "UI", instructions: "make ui.js", files: ["ui.js"] },
        ],
        contract: {
          provides: [{ task: "core", kind: "symbol", name: "x", in: "core.js" }],
          requires: [{ task: "ui", name: "x" }],
        },
      },
      ctx(repo),
    );
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[0]!.status).toBe("needs_orchestrator");
    expect(rows[0]!.notes?.join(" ")).toContain("not merged (the judge could not verify it");
    await expect(readFile(join(repo, "core.js"), "utf8")).rejects.toThrow();
    expect(ran).toEqual(["core"]);
    expect(rows[1]!.error).toMatch(/held for the replan: it depends on core/);
  });

  it("holds back a task whose changed file fails the syntax pass in its workspace", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const syntaxDirs: string[] = [];
    const syntaxCheck: FusionDelegateDeps["syntaxCheck"] = async (files, workingDir) => {
      syntaxDirs.push(workingDir);
      const results = [];
      for (const file of files) {
        const body = await readFile(file, "utf8").catch(() => "");
        results.push(
          body.includes("SYNTAX")
            ? { file, ok: false, checker: "fake", error: "Unexpected token" }
            : { file, ok: true, checker: "fake" },
        );
      }
      return { results };
    };
    const d = deps(
      repo,
      (id, _n, dir) => writeFile(join(dir, `${id}.js`), id === "two" ? "SYNTAX(\n" : "ok()\n"),
      { syntaxCheck },
    );
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: [
          { id: "one", title: "One", instructions: "write one.js", files: ["one.js"] },
          { id: "two", title: "Two", instructions: "write two.js", files: ["two.js"] },
        ],
      },
      ctx(repo),
    );
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.map((r) => r.status)).toEqual(["ok", "failed"]);
    expect(rows[1]!.error).toMatch(/^syntax: 1 file failed \(two\.js\)/);
    expect(rows[1]!.notes?.join(" ")).toContain("not merged (syntax: 1 file failed (two.js))");
    expect(rows[0]!.syntax).toMatchObject({ checked: 1, failedFiles: [] });
    expect(await readFile(join(repo, "one.js"), "utf8")).toBe("ok()\n");
    await expect(readFile(join(repo, "two.js"), "utf8")).rejects.toThrow();
    expect(await readFile(join(repo, taskPatchPath("two")), "utf8")).toContain("+SYNTAX(");
    // Ruled on in the workspaces; the merged green file is not checked again.
    expect(syntaxDirs.length).toBeGreaterThan(0);
    expect(syntaxDirs).not.toContain(repo);
  });

  it("re-runs a gated check on the merged folder when a later wave changed the task's file", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const seen: Array<{ file: string; dir: string; ok: boolean }> = [];
    const d = deps(
      repo,
      async (id, _n, dir) => {
        if (id === "one") await writeFile(join(dir, "shared.txt"), "good\n");
        // A later wave breaks the file the first task's check passed on.
        else await writeFile(join(dir, "shared.txt"), "good\nbad\n");
      },
      { runChecks: fileChecks(seen) },
    );
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: [
          { id: "one", title: "One", instructions: "write shared.txt", files: ["shared.txt"] },
          { id: "two", title: "Two", instructions: "extend shared.txt", files: ["shared.txt"] },
        ],
        contract: {
          provides: [{ task: "one", kind: "file", name: "shared.txt", file: "shared.txt" }],
          requires: [{ task: "two", name: "shared.txt" }],
          checks: [{ task: "one", kind: "command", file: "shared.txt" }],
        },
      },
      ctx(repo),
    );
    const rows = result.details.tasks as WorkerTaskResult[];
    // Green in its workspace, re-run on the folder after the later merge.
    const inWorkspace = seen.filter((s) => s.dir !== repo);
    expect(inWorkspace.length).toBeGreaterThan(0);
    expect(inWorkspace.every((s) => s.ok)).toBe(true);
    expect(seen.filter((s) => s.dir === repo)).toEqual([{ file: "shared.txt", dir: repo, ok: false }]);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.checks).toMatchObject({ total: 1, failed: 1 });
  });

  it("re-runs both tasks' gated checks after a three-way merge of the same file", async () => {
    const base = "l1\nl2\nl3\nl4\nl5\nl6\n";
    const repo = await gitRepo({ "a.txt": base });
    const seen: Array<{ file: string; dir: string; ok: boolean }> = [];
    const d = deps(
      repo,
      async (id, _n, dir) => {
        if (id === "one") return writeFile(join(dir, "a.txt"), base.replace("l1", "L1"));
        await writeFile(join(dir, "a.txt"), base.replace("l6", "bad"));
        await writeFile(join(dir, "two.txt"), "good\n");
      },
      { runChecks: fileChecks(seen) },
    );
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: TASKS,
        contract: {
          checks: [
            { task: "one", kind: "command", file: "a.txt", name: "one" },
            { task: "two", kind: "command", file: "two.txt", name: "two" },
          ],
        },
      },
      ctx(repo),
    );
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe(base.replace("l1", "L1").replace("l6", "bad"));
    const rows = result.details.tasks as WorkerTaskResult[];
    const post = seen.filter((s) => s.dir === repo).map((s) => s.file).sort();
    expect(post).toEqual(["a.txt", "two.txt"]);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.checks).toMatchObject({ total: 1, failed: 1 });
  });

  it("off: a task whose check fails still wrote into the folder, as before", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const seen: Array<{ file: string; dir: string; ok: boolean }> = [];
    const d = deps(repo, (id, _n, dir) => writeFile(join(dir, `${id}.txt`), "bad\n"), {
      runChecks: fileChecks(seen),
    }, { off: true });
    const result = await buildFusionDelegateTool(d).run(
      {
        tasks: [TASKS[0]!],
        contract: { checks: [{ task: "one", kind: "command", file: "one.txt" }] },
      },
      ctx(repo),
    );
    expect((result.details.tasks as WorkerTaskResult[])[0]!.status).toBe("failed");
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("bad\n");
    await expect(readFile(join(repo, taskPatchPath("one")), "utf8")).rejects.toThrow();
  });
});

describe("held-back patches and kept workspaces (isolation)", () => {
  it("names patches apart, ignores the patch folder, and drops a stale patch once the task merges green", async () => {
    expect(taskPatchPath("a/b")).not.toBe(taskPatchPath("a_b"));
    expect(taskPatchPath("a/b")).toMatch(/fusion-merge[\\/]a_b-[0-9a-f]{6}\.patch$/);
    const repo = await gitRepo({ "a.txt": "a\n" });
    const seen: Array<{ file: string; dir: string; ok: boolean }> = [];
    let round = 0;
    const d = deps(
      repo,
      (_id, _n, dir) => writeFile(join(dir, "one.txt"), round === 1 ? "bad\n" : "good\n"),
      { runChecks: fileChecks(seen) },
    );
    const args = {
      tasks: [TASKS[0]!],
      contract: { checks: [{ task: "one", kind: "command", file: "one.txt" }] },
    };
    round = 1;
    await buildFusionDelegateTool(d).run(args, ctx(repo));
    const patch = join(repo, taskPatchPath("one"));
    expect(await readFile(patch, "utf8")).toContain("+bad");
    expect(await readFile(join(repo, ".atomic-agent", "fusion-merge", ".gitignore"), "utf8")).toBe("*\n");
    // Nothing under the patch folder shows up as a change to commit.
    expect((await runGitRaw(repo, ["status", "--porcelain"])).stdout).toBe("");
    round = 2;
    const second = await buildFusionDelegateTool(d).run(args, ctx(repo));
    expect((second.details.tasks as WorkerTaskResult[])[0]!.status).toBe("ok");
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("good\n");
    await expect(readFile(patch, "utf8")).rejects.toThrow();
  });

  it("removes a kept workspace when something after the waves throws", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    let retrying = false;
    const complete: EscalationComplete = async () => ({
      content: JSON.stringify({ items: [{ id: "a2", pass: false, why: "unfinished" }] }),
    });
    const d = deps(
      repo,
      (_id, _n, dir) => writeFile(join(dir, "one.txt"), "draft\n"),
      {
        escalationComplete: complete,
        knownSecrets: () => {
          if (retrying) throw new Error("secret store went away");
          return [];
        },
      },
      { judge: { providerId: "cloud", model: "judge" } },
    );
    const runTurn = d.runTurn;
    d.runTurn = async (session, message, options) => {
      if (message.includes("A judge found these acceptance items NOT met")) retrying = true;
      return runTurn(session, message, options);
    };
    // Secret-store failures use fixed public text; the raw exception may contain credentials.
    await expect(
      buildFusionDelegateTool(d).run(
        { tasks: [{ id: "one", title: "One", instructions: "write one.txt", files: ["one.txt"] }] },
        ctx(repo),
      ),
    ).rejects.toThrow(new Error("Secret metadata unavailable"));
    expect(retrying).toBe(true);
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });
});

describe("the judge reads the task's diff (isolation)", () => {
  it("sees an edit past the first 6,000 chars and lists a touched file nobody declared", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the original text`).join("\n") + "\n";
    expect(big.length).toBeGreaterThan(6_000);
    const repo = await gitRepo({ "big.txt": big });
    const prompts: string[] = [];
    const complete: EscalationComplete = async (call) => {
      prompts.push(call.prompt);
      return { content: JSON.stringify({ items: [{ id: "a2", pass: true, why: "ok" }] }) };
    };
    const d = deps(
      repo,
      async (_id, _n, dir) => {
        await writeFile(join(dir, "big.txt"), big.replace("line 399 of", "line 399 FIXED of"));
        await writeFile(join(dir, "extra.txt"), "helper\n");
      },
      { escalationComplete: complete },
      { judge: { providerId: "cloud", model: "judge" } },
    );
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "one", title: "One", instructions: "fix line 399", files: ["big.txt"] }] },
      ctx(repo),
    );
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("Touched files: big.txt (modified), extra.txt (added)");
    expect(prompt).toContain("-line 399 of the original text");
    expect(prompt).toContain("+line 399 FIXED of the original text");
    expect(prompt).toContain("### extra.txt (new file)\nhelper");
    // A diff, not the file's head.
    expect(prompt).not.toContain("line 1 of the original text");
    expect((result.details.tasks as WorkerTaskResult[])[0]!.status).toBe("ok");
    expect(await readFile(join(repo, "big.txt"), "utf8")).toContain("line 399 FIXED");
  });
});

describe("gatedChecks / applyPostMergeChecks", () => {
  it("leaves a check naming a concurrent task's path to the pass after the merge", () => {
    const contract = {
      owners: { "b.js": "two" },
      checks: [
        { task: "one", kind: "command", cmd: "node", args: ["a.js"] },
        { task: "one", kind: "command", cmd: "node", args: ["b.js"] },
        { kind: "command", cmd: "npm", args: ["test"] },
      ],
    };
    expect(gatedChecks(contract, "one", ["one", "two"]).map((c) => c.index)).toEqual([0]);
    expect(gatedChecks(contract, "one", ["one"]).map((c) => c.index)).toEqual([0, 1]);
  });

  it("adds a later check to the gate's counts instead of replacing them", () => {
    const row = {
      id: "one",
      title: "One",
      status: "ok",
      reply: "",
      stepCount: 1,
      durationMs: 1,
      tools: { calls: 0, errors: 0, writes: 0, byTool: {} },
      checks: { total: 1, failed: 0 },
    } as WorkerTaskResult;
    const [out] = applyPostMergeChecks([row], [{ task: "one", ok: false, detail: "b.js threw" }]);
    expect(out!.status).toBe("failed");
    expect(out!.checks).toEqual({ total: 2, failed: 1, detail: "b.js threw" });
  });
});
