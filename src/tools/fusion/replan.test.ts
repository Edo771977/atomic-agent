import { describe, expect, it } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionTurnBudget } from "./turn-budget.js";
import { describeReplan, renderReplanBlock } from "./replan.js";
import { WorkerRunCollector } from "./worker-result.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    autoReplan: 2,
    ...over,
  };
}

function deps(failing: Set<string>, over: Partial<FusionDelegateDeps> = {}) {
  let minted = 0;
  const ran: string[] = [];
  const d: FusionDelegateDeps = {
    runTurn: async (session) => {
      const taskId = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
      ran.push(taskId);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
        reason: failing.has(taskId) ? "failed" : "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
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
  };
  return { d, ran };
}

const ctx = () => ({ workingDir: "/repo", sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal });

const ORDERED = {
  tasks: [
    { id: "core", title: "Core", instructions: "make core" },
    { id: "ui", title: "UI", instructions: "make ui" },
  ],
  contract: {
    provides: [{ task: "core", kind: "symbol", name: "Core.run", in: "core.js" }],
    requires: [{ task: "ui", name: "Core.run" }],
  },
};

describe("automatic replanning (ATO-941)", () => {
  it("holds a dependent of a failed task and sends both back to the planner", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d, ran } = deps(new Set(["core"]), { turnBudget: budget });
    const result = await buildFusionDelegateTool(d).run(ORDERED, ctx());
    expect(ran).toEqual(["core"]);
    const rows = result.details.tasks as Array<{ id: string; status: string; error?: string }>;
    expect(rows[1]).toMatchObject({ id: "ui", status: "cancelled" });
    expect(rows[1]!.error).toMatch(/held for the replan: it depends on core/);
    expect(result.summary).toContain("REPLAN REQUIRED");
    const replan = result.details.replan as { pending: Array<{ id: string; replansLeft: number }> };
    expect(replan.pending.map((t) => t.id)).toEqual(["core", "ui"]);
    expect(replan.pending[0]!.replansLeft).toBe(1);
  });

  it("stops sending a task back once its replans are used", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d } = deps(new Set(["core"]), { turnBudget: budget });
    const tool = buildFusionDelegateTool(d);
    const one = { tasks: [ORDERED.tasks[0]!] };
    await tool.run(one, ctx());
    await tool.run(one, ctx());
    const third = await tool.run(one, ctx());
    const replan = third.details.replan as { pending: unknown[]; exhausted: Array<{ id: string }> };
    expect(replan.pending).toEqual([]);
    expect(replan.exhausted.map((t) => t.id)).toEqual(["core"]);
    expect(third.summary).toContain("NO REPLANS LEFT (2 used)");
  });

  it("is off by default: dependents run and nothing is sent back", async () => {
    const { d, ran } = deps(new Set(["core"]), { resolveRunMode: () => mode({ autoReplan: undefined }) });
    const result = await buildFusionDelegateTool(d).run(ORDERED, ctx());
    expect(ran).toEqual(["core", "ui"]);
    expect(result.details.replan).toBeUndefined();
    expect(result.summary).not.toContain("REPLAN");
  });

  it("does not send back an ok task or one the person cancelled", () => {
    const report = describeReplan(
      [
        { id: "a", status: "ok" } as never,
        { id: "b", status: "cancelled", error: "stopped" } as never,
        { id: "c", status: "timeout" } as never,
      ],
      () => 1,
      2,
    );
    expect(report.pending.map((t) => t.id)).toEqual(["c"]);
  });
});

describe("a replan may split a failed task into continuation ids", () => {
  type Report = {
    pending: Array<{ id: string; replansLeft: number; fix?: string }>;
    exhausted: Array<{ id: string }>;
  };

  it("accepts t.a / t.b as continuations that share the failed task's replans", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d, ran } = deps(new Set(["core", "core.a", "core.b", "core.a.x"]), {
      turnBudget: budget,
    });
    const tool = buildFusionDelegateTool(d);
    const first = await tool.run({ tasks: [ORDERED.tasks[0]!] }, ctx());
    expect((first.details.replan as Report).pending[0]).toMatchObject({ id: "core", replansLeft: 1 });
    expect(first.summary).toContain("split it into continuation ids (`<id>.a`, `<id>.b`, sharing its replans)");
    // The split is one more round at `core`, not one per child.
    const split = await tool.run(
      {
        tasks: [
          { id: "core.a", instructions: "the first half" },
          { id: "core.b", instructions: "the second half" },
        ],
      },
      ctx(),
    );
    expect(budget.attempts("s-p", "core")).toBe(2);
    expect(budget.attempts("s-p", "core.a")).toBe(2);
    const second = split.details.replan as Report;
    expect(second.pending.map((t) => [t.id, t.replansLeft])).toEqual([
      ["core.a", 0],
      ["core.b", 0],
    ]);
    // A split of a split still counts on `core`: past the cap, it is
    // reported, never sent back.
    const third = await tool.run({ tasks: [{ id: "core.a.x", instructions: "smaller" }] }, ctx());
    const last = third.details.replan as Report;
    expect(last.pending).toEqual([]);
    expect(last.exhausted.map((t) => t.id)).toEqual(["core.a.x"]);
    expect(ran).toEqual(["core", "core.a", "core.b", "core.a.x"]);
  });

  it("treats a dotted id as its own task until the id before the dot has run", () => {
    const budget = new FusionTurnBudget();
    budget.begin("s");
    budget.noteRoundAttempts("s", ["parse", "parse.dates"]);
    expect(budget.attempts("s", "parse")).toBe(1);
    expect(budget.attempts("s", "parse.dates")).toBe(1);
    budget.noteRoundAttempts("s", ["parse.dates"]);
    expect(budget.attempts("s", "parse.dates")).toBe(2);
    expect(budget.attempts("s", "parse")).toBe(1);
    // A continuation of the continuation lands on it, not on `parse`.
    budget.noteRoundAttempts("s", ["parse.dates.iso", "other.x"]);
    expect(budget.attempts("s", "parse.dates")).toBe(3);
    expect(budget.attempts("s", "other.x")).toBe(1);
    // The next turn starts over.
    budget.begin("s");
    expect(budget.attempts("s", "parse.dates.iso")).toBe(0);
  });

  it("continues only a task that is still open: a dotted id after a closed one is new work", () => {
    const budget = new FusionTurnBudget();
    budget.begin("s");
    budget.noteRoundAttempts("s", ["parse", "lex"]);
    budget.noteRoundOutcomes("s", [
      { id: "parse", open: false },
      { id: "lex", open: true },
    ]);
    budget.noteRoundAttempts("s", ["parse.dates", "lex.a"]);
    // `parse` closed green: `parse.dates` is its own family, one run.
    expect(budget.attempts("s", "parse.dates")).toBe(1);
    expect(budget.attempts("s", "parse")).toBe(1);
    // `lex` is still open: `lex.a` continues it.
    expect(budget.attempts("s", "lex.a")).toBe(2);
    expect(budget.attempts("s", "lex")).toBe(2);
  });

  it("gives a new dotted id after a closed task its own replans, through the delegate", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d, ran } = deps(new Set(["parse.dates"]), { turnBudget: budget });
    const tool = buildFusionDelegateTool(d);
    const first = await tool.run({ tasks: [{ id: "parse", instructions: "the parser" }] }, ctx());
    expect(first.details.replan).toBeUndefined();
    const second = await tool.run(
      { tasks: [{ id: "parse.dates", instructions: "now dates, new work" }] },
      ctx(),
    );
    const report = second.details.replan as Report;
    // One run, not two: the full replans, and no "failed twice" steer.
    expect(report.exhausted).toEqual([]);
    expect(report.pending).toEqual([
      expect.objectContaining({ id: "parse.dates", replansLeft: 1 }),
    ]);
    expect(report.pending[0]!.fix).toBeUndefined();
    expect(budget.attempts("s-p", "parse.dates")).toBe(1);
    expect(ran).toEqual(["parse", "parse.dates"]);
  });
});

describe("the fix each status calls for", () => {
  const row = (id: string, status: string) => ({ id, status }) as never;

  it("split for steps and time, the exact edit for no change, the orchestrator after two runs", () => {
    const runs = new Map([["twice", 2]]);
    const report = describeReplan(
      [
        row("steps", "max_steps"),
        row("slow", "timeout"),
        row("idle", "no_changes"),
        row("twice", "failed"),
        row("plain", "failed"),
      ],
      (id) => runs.get(id) ?? 1,
      3,
    );
    const fix = Object.fromEntries(report.pending.map((t) => [t.id, t.fix]));
    expect(fix.steps).toBe("split it into smaller tasks, as continuation ids `steps.a`, `steps.b` (they share its replans)");
    expect(fix.slow).toContain("`slow.a`, `slow.b`");
    expect(fix.idle).toBe("name the file and the exact edit in the brief");
    expect(fix.twice).toBe('it failed twice on a worker: send it with `model: "orchestrator"`');
    expect(fix.plain).toBeUndefined();
    expect(renderReplanBlock(report)).toContain(
      '- twice (failed): failed — 1 more replan after this one; fix: it failed twice on a worker: send it with `model: "orchestrator"`',
    );
  });

  it("does not send a task back to the orchestrator's model that already ran there", () => {
    const once = describeReplan([row("hard", "max_steps")], () => 1, 3, () => true);
    expect(once.pending[0]!.fix).toContain("split it into smaller tasks");
    // Twice, once there: reported to the person, not sent anywhere.
    const report = describeReplan(
      [row("hard", "max_steps")],
      () => 2,
      3,
      (id) => id === "hard",
    );
    expect(report.pending).toEqual([]);
    expect(report.failedOnOrchestrator.map((t) => t.id)).toEqual(["hard"]);
    expect(renderReplanBlock(report)).toContain(
      "FAILED ON THE ORCHESTRATOR'S MODEL TOO",
    );
  });

  it("names no orchestrator fix while the target is off or its cap is used", () => {
    const report = describeReplan([row("twice", "failed")], () => 2, 3, () => false, false);
    expect(report.pending[0]!.fix).toBeUndefined();
  });

  it("remembers across rounds that a task ran on the orchestrator's model", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d, ran } = deps(new Set(["hard"]), { turnBudget: budget });
    const tool = buildFusionDelegateTool(d);
    const first = await tool.run(
      { tasks: [{ id: "hard", instructions: "the hard part", model: "orchestrator" }] },
      ctx(),
    );
    const one = first.details.replan as {
      pending: Array<{ id: string; fix?: string }>;
    };
    expect(one.pending.map((t) => t.id)).toEqual(["hard"]);
    expect(one.pending[0]!.fix).toBeUndefined();
    // Round two on a worker: this call's legs say worker, the turn
    // remembers the orchestrator run, so it is not steered back there.
    const second = await tool.run(
      { tasks: [{ id: "hard", instructions: "the hard part, rebriefed" }] },
      ctx(),
    );
    const two = second.details.replan as {
      pending: unknown[];
      failedOnOrchestrator: Array<{ id: string }>;
    };
    expect(two.pending).toEqual([]);
    expect(two.failedOnOrchestrator.map((t) => t.id)).toEqual(["hard"]);
    expect(second.summary).not.toContain('send it with `model: "orchestrator"`');
    expect(second.summary).toContain("tell the person plainly what failed");
    expect(ran).toEqual(["hard", "hard"]);
  });

  it("names the fix on a row cut at its step or time limit", () => {
    for (const stopCause of ["step_ceiling", "time_ceiling"] as const) {
      const row = new WorkerRunCollector().finish({
        id: "a",
        title: "A",
        reason: "max_steps",
        stepCount: 7,
        durationMs: 1,
        stopCause,
      });
      expect(row.notes?.join("\n")).toContain("fix: split it into smaller tasks");
    }
  });
});
