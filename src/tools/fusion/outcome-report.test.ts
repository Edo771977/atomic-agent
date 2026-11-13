import { describe, expect, it } from "vitest";

import type { TaskOutcomeRecord, TurnOutcomeRecord } from "./outcome-log.js";
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
      steps: [
        { in: 2_000, cached: 1_000 },
        { in: 8_000, cached: 7_000 },
      ],
      ...over,
    },
    fanouts: 1,
    tasks: { total: 2, ok: 1, failed: 1 },
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
  });

  it("filters by model or provider and by window", () => {
    expect(aggregateOutcomes(RECORDS, { model: "MID", now: NOW }).workers.map((w) => w.model)).toEqual(["mid"]);
    expect(aggregateOutcomes(RECORDS, { now: NOW }).tasks).toBe(9);
    expect(aggregateOutcomes(RECORDS, { days: 7, model: "claude", now: NOW }).turns).toBe(1);
  });

  it("prints a plain text table", () => {
    const text = formatFusionReport(aggregateOutcomes(RECORDS, { days: 7, now: NOW }), { days: 7 });
    expect(text).toContain("Fusion outcomes, last 7 days: 8 tasks, 2 turns");
    expect(text).toMatch(/Worker models\nmodel\s+leg\s+tasks\s+1st-pass/);
    expect(text).toMatch(/small \(local-llama\)\s+local\s+6\s+17%\s+50%/);
    expect(text).toContain("syntax 2, max_steps 1");
    expect(text).toContain("Tasks sent to the orchestrator's model");
    expect(text).toMatch(/claude-cli\s+1\s+4\s+10\.0k\/500\s+80%\s+69%\s+unpriced/);
    expect(text).toContain("Strong-side spend: $0.50");
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
