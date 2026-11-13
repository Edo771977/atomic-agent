import { describe, expect, it } from "vitest";

import { taskOutcomeRecord, type TaskOutcomeRecord, type TurnOutcomeRecord } from "./outcome-log.js";
import type { WorkerTaskResult } from "./worker-result.js";
import {
  aggregateOutcomes,
  formatFusionReport,
  parseOutcomeLines,
  parseReportArgs,
  readOutcomeRecords,
  renderOutcomeReport,
} from "./outcome-report.js";

const NOW = new Date("2026-11-10T00:00:00Z");

function task(over: Partial<TaskOutcomeRecord> = {}): TaskOutcomeRecord {
  return {
    v: 1,
    type: "task",
    ts: "2026-11-09T00:00:00.000Z",
    session: "abc",
    provider: "local-llama",
    model: "small",
    leg: "local",
    role: null,
    status: "ok",
    failure: null,
    attempt: 1,
    judgeRetried: false,
    selfCheckNotice: false,
    escalations: 0,
    judge: "off",
    syntaxDemoted: false,
    steps: 4,
    durationMs: 10_000,
    tokensIn: 1000,
    tokensOut: 100,
    cachedTokens: null,
    costUsd: null,
    merge: null,
    ...over,
  };
}

function turn(over: Partial<TurnOutcomeRecord["orchestrator"]> = {}, ts = "2026-11-09T00:00:00.000Z"): TurnOutcomeRecord {
  return {
    v: 1,
    type: "turn",
    ts,
    session: "abc",
    orchestrator: {
      provider: "claude-cli",
      model: "strong",
      requests: 4,
      tokensIn: 10_000,
      tokensOut: 500,
      cachedTokens: 8_000,
      costUsd: null,
      requestCostUsd: over.costUsd ?? null,
      judgeCostUsd: 0,
      escalationCostUsd: 0,
      steps: [
        { in: 2_000, cached: 1_000 },
        { in: 8_000, cached: 7_000 },
      ],
      ...over,
    },
    fanouts: 1,
    tasks: { total: 2, ok: 1, failed: 1 },
    orchestratorTasks: { total: 0, costUsd: null },
    workerTokens: 2_000,
    workerMs: 20_000,
    workerCostUsd: null,
  };
}

const RECORDS = [
  task(),
  task({ durationMs: 30_000, selfCheckNotice: true }),
  task({ attempt: 2, durationMs: 20_000 }),
  task({ status: "failed", failure: "syntax", syntaxDemoted: true, escalations: 1 }),
  task({ status: "max_steps", failure: "max_steps", selfCheckNotice: true }),
  task({ status: "failed", failure: "syntax" }),
  task({ provider: "openrouter", model: "mid", leg: "cloud", costUsd: 0.25 }),
  task({ provider: "claude-cli", model: "strong", leg: "orchestrator", role: "orchestrator" }),
  // Too old for a 7-day window.
  task({ ts: "2026-10-01T00:00:00.000Z", status: "failed", failure: "error" }),
  turn(),
  turn({ provider: "openrouter", model: "big", costUsd: 0.5, cachedTokens: null, steps: [{ in: 100, cached: null }] }),
];

describe("fusion report", () => {
  it("separates actual writer status-only success from declared check evidence", () => {
    const row: WorkerTaskResult = {
      id: "task", title: "test", status: "ok", reply: "done", stepCount: 1,
      durationMs: 1, tools: { calls: 0, errors: 0, writes: 0, byTool: {} },
    };
    const context = { provider: "local", model: "small", leg: "local" as const,
      role: null, attempt: 1, pricing: undefined, merge: null };
    const record = taskOutcomeRecord(row, context, "session", NOW);
    const stats = aggregateOutcomes([record]).workers[0]!;
    expect(stats).toMatchObject({ green: 1, firstPassGreen: 1,
      checksPassed: 0, checksFailed: 0, checksUnverified: 1 });
    const text = formatFusionReport(aggregateOutcomes([record]));
    expect(text).toContain("reported green");
    expect(text).toContain("checks pass/fail/unverified");
    expect(text).toContain("worker can modify");
    expect(text).toContain("semantic correctness");

    const checked = taskOutcomeRecord({ ...row, checks: { total: 1, failed: 0 } }, context, "session", NOW);
    const failed = taskOutcomeRecord({ ...row, status: "failed", checks: { total: 1, failed: 1 } }, context, "session", NOW);
    const replan = taskOutcomeRecord({ ...row, checks: { total: 1, failed: 0 } }, { ...context, attempt: 2 }, "session", NOW);
    expect(aggregateOutcomes([checked, failed, replan]).workers[0]).toMatchObject({
      green: 2, firstPassGreen: 1, checksPassed: 2, checksFailed: 1, checksUnverified: 0,
    });
    const judgedFailure = taskOutcomeRecord({ ...row, status: "failed", checks: { total: 1, failed: 1 },
      judge: { green: false, total: 1, failed: 1, retried: false, costUsd: null, items: [] },
    }, context, "session", NOW);
    expect(aggregateOutcomes([judgedFailure]).workers[0]).toMatchObject({
      checksPassed: 0, checksFailed: 1, checksUnverified: 0,
    });
  });

  it("keeps legacy, missing and contradictory check evidence unverified", () => {
    const accepted = task({ acceptance: "checks-passed", acceptanceScope: "task-checks" });
    const records = [
      task(), // legacy status-only record
      { ...accepted, acceptanceScope: undefined },
      { ...accepted, status: "timeout" as const },
      { ...accepted, failure: "checks" as const },
      { ...accepted, failure: undefined },
      { ...accepted, merge: "held" as const },
      { ...accepted, merge: "conflict" as const },
      { ...accepted, merge: undefined },
      { ...accepted, judgeRetried: true },
      { ...accepted, judgeRetried: undefined },
      { ...accepted, escalations: 1 },
      { ...accepted, syntaxDemoted: true },
      { ...accepted, syntaxDemoted: undefined },
      { ...accepted, judge: "red" as const },
      { ...accepted, judge: "unverified" as const },
      { ...accepted, acceptance: "checks-failed" as const },
      { ...accepted, attempt: undefined },
    ] as TaskOutcomeRecord[];
    expect(aggregateOutcomes(records).workers[0]).toMatchObject({
      checksPassed: 0, checksFailed: 0, checksUnverified: records.length,
    });
    expect(aggregateOutcomes([accepted, { ...accepted, merge: "merged" }]).workers[0]).toMatchObject({
      checksPassed: 2, checksFailed: 0, checksUnverified: 0,
    });
  });

  it("aggregates per worker model with first-pass, retries, failures and rates", () => {
    const report = aggregateOutcomes(RECORDS, { days: 7, now: NOW });
    expect(report.tasks).toBe(8);
    expect(report.turns).toBe(2);
    const local = report.workers.find((w) => w.model === "small")!;
    expect(local).toMatchObject({
      tasks: 6,
      green: 3,
      firstPassGreen: 1,
      greenAfterRetry: 1,
      escalated: 1,
      selfCheckNotices: 2,
      selfCheckFixed: 1,
      selfCheckFixRate: 0.5,
      syntaxDemoted: 1,
      medianDurationMs: 10_000,
      tokensIn: 6000,
      tokensOut: 600,
      costUsd: null,
    });
    expect(local.topFailures).toEqual([
      { category: "syntax", count: 2 },
      { category: "max_steps", count: 1 },
    ]);
    expect(local.greenRate).toBeCloseTo(0.5);
    expect(report.workers.find((w) => w.model === "mid")?.costUsd).toBe(0.25);
    expect(report.orchestratorTargets).toHaveLength(1);
    expect(report.orchestratorTargets[0]).toMatchObject({ model: "strong", tasks: 1, green: 1 });
  });

  it("reports the orchestrator's cache hit rate and spend per provider", () => {
    const report = aggregateOutcomes(RECORDS, { now: NOW });
    const cli = report.orchestrator.find((o) => o.provider === "claude-cli")!;
    expect(cli).toMatchObject({ turns: 1, requests: 4, cacheHitPct: 80, avgStepCacheHitPct: 69, costUsd: null, unpricedTurns: 1 });
    const cloud = report.orchestrator.find((o) => o.provider === "openrouter")!;
    expect(cloud).toMatchObject({ cacheHitPct: null, avgStepCacheHitPct: null, costUsd: 0.5 });
    expect(report.strongSpendUsd).toBe(0.5);
    // The claude-cli turn and the orchestrator-target task were not priced.
    expect(report.strongSpendPartial).toBe(true);
  });

  it("does not read a priced judge as a priced orchestrator", () => {
    const judged = turn({ costUsd: 0.03, requestCostUsd: null, judgeCostUsd: 0.03 });
    const report = aggregateOutcomes([judged], { now: NOW });
    expect(report.orchestrator[0]).toMatchObject({ costUsd: 0.03, unpricedTurns: 1 });
    expect(report.strongSpendPartial).toBe(true);
    const text = formatFusionReport(report);
    expect(text).toMatch(/claude-cli\s+1\s+4\s+10\.0k\/500\s+80%\s+69%\s+\$0\.03 \(\+1 unpriced\)/);
    expect(text).toContain("Strong-side spend: $0.03 + unpriced (subscription or no price known)");
  });

  it("filters by model or provider and by window", () => {
    expect(aggregateOutcomes(RECORDS, { model: "MID", now: NOW }).workers.map((w) => w.model)).toEqual(["mid"]);
    expect(aggregateOutcomes(RECORDS, { now: NOW }).tasks).toBe(9);
    expect(aggregateOutcomes(RECORDS, { days: 7, model: "claude", now: NOW }).turns).toBe(1);
  });

  it("prints a plain text table", () => {
    const text = formatFusionReport(aggregateOutcomes(RECORDS, { days: 7, now: NOW }), { days: 7 });
    expect(text).toContain("Fusion outcomes, last 7 days: 8 tasks, 2 turns");
    expect(text).toMatch(/Worker models\nmodel\s+leg\s+tasks\s+reported 1st-pass/);
    expect(text).toMatch(/small \(local-llama\)\s+local\s+6\s+17%\s+50%/);
    expect(text).toContain("syntax 2, max_steps 1");
    expect(text).toContain("Tasks sent to the orchestrator's model");
    expect(text).toMatch(/claude-cli\s+1\s+4\s+10\.0k\/500\s+80%\s+69%\s+unpriced/);
    expect(text).toContain("Strong-side spend: $0.50 + unpriced (subscription or no price known)");
  });

  it("says so when nothing is recorded", () => {
    expect(formatFusionReport(aggregateOutcomes([], {}))).toContain("Nothing recorded yet");
  });

  it("reads the rotated files oldest first and skips torn or foreign lines", () => {
    const files: Record<string, string> = {
      "/x/outcomes.ndjson.2": `${JSON.stringify(task({ steps: 1 }))}\n`,
      "/x/outcomes.ndjson.1": `${JSON.stringify(task({ steps: 2 }))}\nnot json\n{"type":"other","ts":"x"}\n`,
      "/x/outcomes.ndjson": `${JSON.stringify(task({ steps: 3 }))}\n{"type":"task"`,
    };
    const read = (file: string): string => {
      const text = files[file];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    };
    const records = readOutcomeRecords("/x/outcomes.ndjson", read);
    expect(records.map((r) => (r as TaskOutcomeRecord).steps)).toEqual([1, 2, 3]);
    expect(parseOutcomeLines("")).toEqual([]);
    const json = JSON.parse(renderOutcomeReport("/x/outcomes.ndjson", { json: true }, read)) as { tasks: number };
    expect(json.tasks).toBe(3);
  });

  it("parses its flags and refuses bad ones", () => {
    expect(parseReportArgs(["--days", "7", "--model", "small", "--json"])).toEqual({ days: 7, model: "small", json: true });
    expect(parseReportArgs([])).toEqual({ json: false });
    expect(parseReportArgs(["--days", "x"])).toBe("--days needs a positive number");
    expect(parseReportArgs(["--model"])).toBe("--model needs a model or provider name");
    expect(parseReportArgs(["--nope"])).toBe("unknown option: --nope");
  });
});
