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
      "not merged (its own checks failed: two.txt is bad): its changes to 1 file are kept as a patch at .atomic-agent/fusion-merge/two.patch",
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
