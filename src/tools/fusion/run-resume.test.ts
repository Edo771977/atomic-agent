import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import { FusionRunStore, type FusionRunCheckpoint } from "./run-checkpoint.js";
import {
  CARRIED_NOTE,
  describeResumableRun,
  planResume,
  readResumeRequest,
  renderResumeRequest,
} from "./run-resume.js";
import { FusionTurnBudget } from "./turn-budget.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "openrouter",
    orchestratorModel: "big",
    workerProviderId: "cloud-worker",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter",
    degraded: null,
    ...over,
  };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  workingDir: "/repo",
  sessionId: "s-parent",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...over,
});

const taskIdOf = (session: SessionState): string =>
  (session.metadata as { fusionWorker?: { taskId?: string } }).fusionWorker
    ?.taskId ?? "?";

function deps(
  over: Partial<FusionDelegateDeps>,
  onTurn: (taskId: string) => void = () => {},
): FusionDelegateDeps & { ran: string[] } {
  let minted = 0;
  const d = {
    ran: [] as string[],
    runTurn: async (session: SessionState) => {
      const id = taskIdOf(session);
      d.ran.push(id);
      onTurn(id);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...(meta as object) } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
  } as FusionDelegateDeps & { ran: string[] };
  return d;
}

const TASKS = [
  { id: "t1", title: "One", instructions: "do one" },
  { id: "t2", title: "Two", instructions: "do two" },
  { id: "t3", title: "Three", instructions: "do three" },
];

/** t2 needs what t1 provides: two waves. */
const ORDERED = {
  tasks: TASKS.slice(0, 2),
  contract: {
    provides: [{ task: "t1", kind: "other", name: "done", in: "" }],
    requires: [{ task: "t2", name: "done" }],
  },
};

function row(id: string, over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    ...new WorkerRunCollector().finish({ id, title: id, reason: "reply", stepCount: 1, durationMs: 5 }),
    reply: `reply of ${id}`,
    ...over,
  };
}

describe("resuming a fusion run (ATO-617)", () => {
  let dir: string;
  let store: FusionRunStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-resume-"));
    ORDERED.contract.provides[0]!.in = join(dir, "done.txt");
    writeFileSync(ORDERED.contract.provides[0]!.in, "done");
    store = new FusionRunStore({ dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A run of TASKS cut off with `done` finished and `effects` mid-command. */
  function cutOff(
    done: string[],
    effects: string[] = [],
    spentUsd = 0,
  ): FusionRunCheckpoint {
    const run = store.start({
      sessionId: "s-parent",
      workingDir: "/repo",
      originalRequest: "build the thing",
      args: { tasks: TASKS },
      tasks: TASKS,
      waveCount: 1,
    });
    for (const id of done) run.recordTask(row(id), spentUsd / Math.max(1, done.length));
    for (const id of effects) run.noteTool(id, "os.shell.run");
    run.finish("interrupted");
    return store.load(run.runId)!;
  }

  describe("the checkpoint during a run", () => {
    it("is written after a task finishes and after its wave", async () => {
      // A run in flight is never offered, so read its file directly.
      const readFile = (): FusionRunCheckpoint | undefined => {
        const [file] = readdirSync(dir).filter((f) => f.endsWith(".json"));
        return file === undefined
          ? undefined
          : (store.load(file.replace(/\.json$/, "")) ?? undefined);
      };
      let seenInWave2: FusionRunCheckpoint | undefined;
      const d = deps({ runCheckpoints: store }, (taskId) => {
        if (taskId === "t2") seenInWave2 = readFile();
      });
      await buildFusionDelegateTool(d).run(ORDERED, ctx());
      expect(seenInWave2).toBeDefined();
      expect(seenInWave2!.tasks.find((t) => t.id === "t1")!.result?.status).toBe("ok");
      expect(seenInWave2!.tasks.find((t) => t.id === "t2")!.result).toBeUndefined();
      expect(seenInWave2!.wavesDone).toBe(1);
      expect(seenInWave2!.waveCount).toBe(2);
    });

    it("is deleted when the run completes", async () => {
      const d = deps({ runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run(ORDERED, ctx());
      expect(result.status).toBe("ok");
      expect(store.listResumable()).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
    });

    it("is kept, and offered, when the turn is stopped", async () => {
      const controller = new AbortController();
      const d = deps({ runCheckpoints: store }, (taskId) => {
        if (taskId === "t1") controller.abort();
      });
      await buildFusionDelegateTool(d).run(ORDERED, ctx({ signal: controller.signal }));
      const offered = store.listResumable("s-parent");
      expect(offered).toHaveLength(1);
      expect(offered[0]!.state).toBe("interrupted");
    });

    it("writes nothing without a store", async () => {
      const d = deps({});
      await buildFusionDelegateTool(d).run(ORDERED, ctx());
      expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
    });
  });

  describe("planResume", () => {
    it("carries finished tasks and re-runs the rest", () => {
      const plan = planResume(cutOff(["t1"]));
      expect(plan.carried.map((r) => r.id)).toEqual(["t1"]);
      expect(plan.carried[0]!.notes).toContain(CARRIED_NOTE);
      expect(plan.rerun).toEqual(["t2", "t3"]);
      expect(plan.needsConfirmation).toEqual([]);
    });

    it("re-runs a task the stop left cancelled", () => {
      const run = store.start({
        sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1,
      });
      run.recordTask(row("t1", { status: "cancelled" }));
      run.finish("interrupted");
      expect(planResume(store.load(run.runId)!).rerun).toContain("t1");
    });

    it("re-runs a never-served queued task instead of carrying it as settled", () => {
      const run = store.start({ sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1 });
      run.recordTask(row("t1", { status: "queued", stepCount: 0 }));
      run.finish("interrupted");
      const plan = planResume(store.load(run.runId)!);
      expect(plan.carried).toEqual([]);
      expect(plan.rerun).toEqual(["t1", "t2", "t3"]);
    });

    it("still requires confirmation if a queued row recorded side effects", () => {
      const run = store.start({ sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1 });
      run.noteTool("t1", "os.shell.run");
      run.recordTask(row("t1", { status: "queued", stepCount: 0 }));
      run.finish("interrupted");
      const saved = store.load(run.runId)!;
      expect(planResume(saved).needsConfirmation.map(r => r.id)).toEqual(["t1"]);
      expect(planResume(saved, ["t1"]).rerun).toEqual(["t1", "t2", "t3"]);
    });

    it("carries a needs_input task's question, even past a long reply", () => {
      const question = "Should the score be the run's total or the best lap?";
      const run = store.start({ sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1 });
      run.recordTask(row("t1", {
        status: "needs_input",
        reply: `${"x".repeat(5_000)}\nNEEDS_INPUT: ${question}`,
        question,
      }));
      run.finish("interrupted");
      const carried = planResume(store.load(run.runId)!).carried[0]!;
      expect(carried).toMatchObject({ id: "t1", status: "needs_input", question });
    });

    it("loads a v1 needs_input row saved without a question", () => {
      const saved = cutOff(["t1"]);
      const result = saved.tasks[0]!.result!;
      result.status = "needs_input";
      delete (result as { question?: string }).question;
      writeFileSync(join(dir, `${saved.runId}.json`), JSON.stringify(saved));
      const loaded = store.load(saved.runId)!;
      expect(loaded).not.toBeNull();
      const carried = planResume(loaded).carried[0]!;
      expect(carried.status).toBe("needs_input");
      expect(carried).not.toHaveProperty("question");
    });

    it("refuses a stored question past its bound", () => {
      const saved = cutOff(["t1"]);
      (saved.tasks[0]!.result as { question?: string }).question = "q".repeat(5_000);
      writeFileSync(join(dir, `${saved.runId}.json`), JSON.stringify(saved));
      expect(store.load(saved.runId)).toBeNull();
    });

    it("loads legacy v1 rows but does not call unknown file-change coverage green", () => {
      const saved = cutOff(["t1"]);
      const result = saved.tasks[0]!.result!;
      result.tools.writes = 1;
      delete result.artifactMetadata;
      delete result.changes;
      writeFileSync(join(dir, `${saved.runId}.json`), JSON.stringify(saved));
      const loaded = store.load(saved.runId)!;
      expect(loaded).not.toBeNull();
      const carried = planResume(loaded).carried[0]!;
      expect(carried.status).toBe("needs_orchestrator");
      expect(carried.error).toContain("coverage is incomplete");
    });

    it("does not silently pass artifacts when the recorded path bound overflowed", () => {
      const run = store.start({ sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1 });
      run.recordTask(row("t1", { changes: Array.from({ length: 300 }, (_, i) => ({ path: `file-${i}.js`, kind: "new" as const })) }));
      run.finish("interrupted");
      expect(planResume(store.load(run.runId)!).carried[0]!.status).toBe("needs_orchestrator");
    });

    it.each(["os.shell.run", "os.fs.archive.extract", "skill.run_script", "os.git.checkout"])("does not call legacy %s write coverage complete", tool => {
      const saved = cutOff(["t1"]);
      const result = saved.tasks[0]!.result!;
      result.tools = { calls: 1, errors: 0, writes: 0, byTool: { [tool]: 1 } };
      delete result.artifactMetadata;
      delete result.changes;
      delete result.shellRan;
      writeFileSync(join(dir, `${saved.runId}.json`), JSON.stringify(saved));
      expect(planResume(store.load(saved.runId)!).carried[0]!.status).toBe("needs_orchestrator");
    });

    it.each(["os.fs.move", "os.fs.trash", "os.fs.restore", "os.fs.patch"])("does not trust legacy %s coverage when the narrow writes counter is zero", tool => {
      const saved = cutOff(["t1"]);
      const result = saved.tasks[0]!.result!;
      result.tools = { calls: 1, errors: 0, writes: 0, byTool: { [tool]: 1 } };
      delete result.artifactMetadata;
      delete result.changes;
      writeFileSync(join(dir, `${saved.runId}.json`), JSON.stringify(saved));
      expect(planResume(store.load(saved.runId)!).carried[0]!.status).toBe("needs_orchestrator");
    });

    it.each(["os.fs.read", "os.fs.list", "os.fs.hash"])("keeps legacy read-only %s results settled", tool => {
      const saved = cutOff(["t1"]);
      const result = saved.tasks[0]!.result!;
      result.tools = { calls: 1, errors: 0, writes: 0, byTool: { [tool]: 1 } };
      delete result.artifactMetadata;
      delete result.changes;
      expect(planResume(saved).carried[0]!.status).toBe("ok");
    });

    it("holds a task with side effects for the person's yes", () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const plan = planResume(checkpoint);
      expect(plan.rerun).toEqual(["t3"]);
      expect(plan.needsConfirmation.map((r) => r.id)).toEqual(["t2"]);
      expect(plan.needsConfirmation[0]!.status).toBe("needs_orchestrator");
      expect(plan.needsConfirmation[0]!.error).toContain("os.shell.run");
      expect(plan.needsConfirmation[0]!.error).toContain(`"confirm":["t2"]`);
      expect(planResume(checkpoint, ["t2"]).rerun).toEqual(["t2", "t3"]);
    });

    it("carries the spend recorded so far", () => {
      expect(planResume(cutOff(["t1"], [], 2)).carriedSpendUsd).toBeCloseTo(2);
    });
  });

  describe("fusion.delegate { resume }", () => {
    it("reports non-resumability without advertising a run id when the original request exceeds the checkpoint budget", async () => {
      const d = deps({ workingDir: dir, runCheckpoints: store, resolveOriginalRequest: () => "x".repeat(8 * 1024 * 1024) });
      const result = await buildFusionDelegateTool(d).run({ tasks: [{ id: "one", title: "One", instructions: "work" }] }, ctx({ workingDir: dir }));
      expect(d.ran).toEqual(["one"]);
      expect(result.details.runId).toBeUndefined();
      expect(result.details.checkpointWarning).toContain("8 MiB");
      expect(result.summary).toContain("cannot be resumed");
    });

    it("does not resume an untracked shell-written artifact as all_ok", async () => {
      writeFileSync(join(dir, "bad.js"), "const = ;");
      const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks: TASKS.slice(0, 1) }, tasks: TASKS.slice(0, 1), waveCount: 1 });
      run.recordTask(row("t1", { shellRan: true, tools: { calls: 1, errors: 0, writes: 0, byTool: { "os.shell.run": 1 } } }));
      run.finish("interrupted");
      const d = deps({ workingDir: dir, runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run({ resume: run.runId }, ctx({ workingDir: dir }));
      expect(d.ran).toEqual([]);
      expect((result.details.tasks as WorkerTaskResult[])[0]!.status).toBe("needs_orchestrator");
      expect(result.details.outcome).not.toBe("all_ok");
    });

    it("verifies undeclared observed artifacts after a crash before syntax verification", async () => {
      writeFileSync(join(dir, "bad.js"), "const = ;");
      const run = store.start({ sessionId: "s-parent", workingDir: dir, args: { tasks: TASKS.slice(0, 1) }, tasks: TASKS.slice(0, 1), waveCount: 1 });
      run.recordTask(row("t1", { changes: [{ path: "bad.js", kind: "new", addedLines: 1, removedLines: 0 }], tools: { calls: 1, errors: 0, writes: 1, byTool: { "os.fs.write": 1 } } }));
      run.finish("interrupted");
      const checked: string[] = [];
      const d = deps({ workingDir: dir, runCheckpoints: store, syntaxCheck: async files => {
        checked.push(...files);
        return { results: files.map(file => ({ file, ok: false, checker: "javascript", error: "parse failed" })) };
      } });
      const result = await buildFusionDelegateTool(d).run({ resume: run.runId }, ctx({ workingDir: dir }));
      expect(d.ran).toEqual([]);
      expect(checked).toEqual([join(dir, "bad.js")]);
      expect((result.details.tasks as WorkerTaskResult[])[0]!.status).toBe("failed");
      expect(result.details.outcome).not.toBe("all_ok");
    });

    it("re-dispatches only the unfinished tasks and reports the rest from the checkpoint", async () => {
      const checkpoint = cutOff(["t1"]);
      const d = deps({ runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      expect(d.ran.sort()).toEqual(["t2", "t3"]);
      expect(result.status).toBe("ok");
      const details = result.details as {
        tasks: WorkerTaskResult[];
        resume: { carried: string[]; rerun: string[] };
      };
      expect(details.resume.carried).toEqual(["t1"]);
      expect(details.resume.rerun).toEqual(["t2", "t3"]);
      expect(details.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
      expect(details.tasks[0]!.reply).toBe("reply of t1");
      expect(result.summary).toContain(`Resumed run ${checkpoint.runId}`);
      // Completed now: nothing left to offer.
      expect(store.listResumable()).toEqual([]);
    });

    it("does not re-run a task with side effects without confirmation", async () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const d = deps({ runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      expect(d.ran).toEqual(["t3"]);
      const details = result.details as {
        tasks: WorkerTaskResult[];
        resume: { needsConfirmation: string[] };
      };
      expect(details.resume.needsConfirmation).toEqual(["t2"]);
      expect(details.tasks.find((t) => t.id === "t2")!.status).toBe("needs_orchestrator");
    });

    it("re-runs it once the person confirmed", async () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const d = deps({ runCheckpoints: store });
      await buildFusionDelegateTool(d).run(
        { resume: checkpoint.runId, confirm: ["t2"] },
        ctx(),
      );
      expect(d.ran.sort()).toEqual(["t2", "t3"]);
    });

    it("keeps the run for the confirm call that follows the first resume", async () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const d = deps({ runCheckpoints: store });
      const tool = buildFusionDelegateTool(d);
      await tool.run({ resume: checkpoint.runId }, ctx());
      expect(d.ran).toEqual(["t3"]);
      expect(store.listResumable("s-parent").map((c) => c.runId)).toEqual([checkpoint.runId]);

      const confirmed = await tool.run(
        { resume: checkpoint.runId, confirm: ["t2"] },
        ctx(),
      );
      expect(confirmed.details?.reason).toBeUndefined();
      expect(d.ran).toEqual(["t3", "t2"]);
      expect(store.listResumable()).toEqual([]);
    });

    it("leaves a task awaiting confirmation out of the automatic replan", async () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const d = deps({
        runCheckpoints: store,
        resolveRunMode: () => mode({ autoReplan: 2 }),
      });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      const details = result.details as {
        tasks: WorkerTaskResult[];
        replan?: { pending: { id: string }[] };
      };
      expect(details.tasks.find((t) => t.id === "t2")!.status).toBe("needs_orchestrator");
      expect((details.replan?.pending ?? []).map((t) => t.id)).not.toContain("t2");
      expect(result.summary).not.toContain("- t2 (needs_orchestrator)");
      expect(d.ran).toEqual(["t3"]);
    });

    it("counts the spend before the restart toward the turn's cap", async () => {
      const checkpoint = cutOff(["t1"], [], 5);
      const turnBudget = new FusionTurnBudget();
      turnBudget.begin("s-parent");
      const d = deps({
        runCheckpoints: store,
        turnBudget,
        resolveRunMode: () => mode({ turnBudgetUsd: 3 }),
      });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      expect(result.status).toBe("error");
      expect(result.details?.reason).toBe("turn-budget");
      expect(d.ran).toEqual([]);
      expect(turnBudget.workerSpend("s-parent")).toBeCloseTo(5);
    });

    it("refuses a run of another session, an unknown id and a malformed call", async () => {
      const checkpoint = cutOff(["t1"]);
      const tool = buildFusionDelegateTool(deps({ runCheckpoints: store }));
      expect(
        (await tool.run({ resume: checkpoint.runId }, ctx({ sessionId: "s-other" }))).details?.reason,
      ).toBe("resume-unknown");
      expect((await tool.run({ resume: "fr-nope" }, ctx())).details?.reason).toBe("resume-unknown");
      expect((await tool.run({ resume: 7 }, ctx())).status).toBe("error");
    });

    it("refuses a resume without a store", async () => {
      const result = await buildFusionDelegateTool(deps({})).run({ resume: "fr-x" }, ctx());
      expect(result.details?.reason).toBe("resume-unknown");
    });
  });

  describe("a task its worker split", () => {
    const PROPOSAL =
      "Too big.\n```split_proposal\n" +
      JSON.stringify({
        reason: "two parts",
        tasks: [
          { id: "a", title: "A", instructions: "part a" },
          { id: "b", title: "B", instructions: "part b" },
        ],
      }) +
      "\n```";
    const treeMode = (): ResolvedRunMode =>
      mode({ taskTree: { maxDepth: 2, maxNodes: 24 } });
    const splitting = (
      onTurn: (taskId: string) => void,
    ): FusionDelegateDeps["runTurn"] =>
      async (session, _message, options) => {
        const id = taskIdOf(session);
        onTurn(id);
        // A stopped turn ends cancelled without an answer, as the agent loop's does.
        if (options.signal?.aborted === true) {
          return {
            session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
            reason: "cancelled",
            stepCount: 0,
          } as RunTurnResult;
        }
        options.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: id === "t1" ? PROPOSAL : "done" },
        });
        return {
          session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
          reason: "reply",
          stepCount: 1,
        } as RunTurnResult;
      };

    it("is not settled when a stop cuts its children off", async () => {
      const controller = new AbortController();
      const d = deps({
        runCheckpoints: store,
        resolveRunMode: treeMode,
        runTurn: splitting((id) => {
          if (id.startsWith("t1/")) controller.abort();
        }),
      });
      await buildFusionDelegateTool(d).run(
        { tasks: TASKS.slice(0, 1) },
        ctx({ signal: controller.signal }),
      );
      const [kept] = store.listResumable("s-parent");
      expect(kept!.tasks[0]!.result).toBeUndefined();
      expect(planResume(kept!).rerun).toEqual(["t1"]);
    });

    it("is written as the closed parent once its children finished", async () => {
      let atT2: FusionRunCheckpoint | null = null;
      const d = deps({
        runCheckpoints: store,
        resolveRunMode: treeMode,
        runTurn: splitting((id) => {
          if (id !== "t2") return;
          const [file] = readdirSync(dir).filter((f) => f.endsWith(".json"));
          atT2 = store.load(file!.replace(/\.json$/, ""));
        }),
      });
      await buildFusionDelegateTool(d).run(ORDERED, ctx());
      const parent = atT2!.tasks.find((t) => t.id === "t1")!;
      expect(parent.result?.status).toBe("ok");
      expect(parent.result?.reply).toContain("Split by the worker into 2 subtasks");
    });

    it("carries a wave's merge suggestions into a resume", () => {
      const merge = { id: "merge-t1", title: "Merge One", instructions: "merge it", files: ["a.txt"] };
      const run = store.start({
        sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1,
      });
      run.recordMerges([merge]);
      run.finish("interrupted");
      const kept = store.load(run.runId)!;
      expect(kept.merges).toEqual([merge]);
      const resumed = store.start({
        runId: kept.runId, sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1, resumedFrom: kept,
      });
      expect(resumed.snapshot().merges).toEqual([merge]);
      resumed.finish("complete");
    });

    it("keeps the spend written before the row is", () => {
      const run = store.start({
        sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1,
      });
      run.addSpend(1.5);
      expect(store.load(run.runId)!.spentUsd).toBeCloseTo(1.5);
      run.finish("complete");
    });
  });

  describe("the words", () => {
    it("reads resume and confirm off the call", () => {
      expect(readResumeRequest({ tasks: [] })).toBeNull();
      expect(readResumeRequest({ resume: " fr-1 ", confirm: ["t2"] })).toEqual({ runId: "fr-1", confirm: ["t2"] });
      expect(typeof readResumeRequest({ confirm: ["t2"] })).toBe("string");
      expect(typeof readResumeRequest({ resume: "fr-1", confirm: "t2" })).toBe("string");
    });

    it("says what is done and what is left", () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const line = describeResumableRun(checkpoint);
      expect(line).toContain("1 of 3 tasks done");
      expect(line).toContain("2 left");
      expect(line).toContain("1 ran commands");
      const message = renderResumeRequest(checkpoint);
      expect(message).toContain(`{"resume":"${checkpoint.runId}"}`);
      expect(message).toContain("build the thing");
    });
  });
});
