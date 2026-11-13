import { readFileSync } from "node:fs";

import {
  outcomeLogFiles,
  type FailureCategory,
  type OutcomeLeg,
  type OutcomeRecord,
  type TaskOutcomeRecord,
  type TurnOutcomeRecord,
} from "./outcome-log.js";
import {
  formatDurationShort,
  formatTokenCount,
  formatUsdShort,
} from "./turn-receipt.js";

/**
 * `atomic-agent fusion report` (and `/fusion report` in the TUI): the
 * outcome log (`outcome-log.ts`) aggregated per worker model, plus the
 * orchestrator's own side per provider. Pure over the records; reading
 * the files is `readOutcomeRecords`.
 */

export interface ReportOptions {
  /** Only records from the last N days; absent: everything kept. */
  days?: number;
  /** Case-insensitive substring of a task's model or provider id. */
  model?: string;
  now?: Date;
}

export interface ModelStats {
  provider: string;
  model: string;
  leg: OutcomeLeg;
  tasks: number;
  /** Green on the first attempt, with no judge retry and no self-check notice. */
  firstPassGreen: number;
  firstPassGreenRate: number;
  green: number;
  greenRate: number;
  /** Green after a replan attempt or a judge retry. */
  greenAfterRetry: number;
  topFailures: Array<{ category: FailureCategory; count: number }>;
  escalated: number;
  escalationRate: number;
  selfCheckNotices: number;
  /** Of those, the tasks that came back green. */
  selfCheckFixed: number;
  selfCheckFixRate: number | null;
  syntaxDemoted: number;
  medianDurationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Null when no task of this model was priced. */
  costUsd: number | null;
}

export interface OrchestratorStats {
  provider: string;
  models: string[];
  turns: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** Cached share of the prompt tokens of the turns that reported one. */
  cacheHitPct: number | null;
  /** Mean per-step cache hit over the steps that reported one. */
  avgStepCacheHitPct: number | null;
  costUsd: number | null;
  unpricedTurns: number;
}

export interface FusionReport {
  since: string | null;
  tasks: number;
  turns: number;
  workers: ModelStats[];
  orchestratorTargets: ModelStats[];
  orchestrator: OrchestratorStats[];
  /** Priced strong-side spend: orchestrator turns plus orchestrator-target tasks. */
  strongSpendUsd: number | null;
  /** Some strong-side requests or orchestrator-target tasks were unpriced. */
  strongSpendPartial: boolean;
}

function isRecord(value: unknown): value is OutcomeRecord {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  const ts = (value as { ts?: unknown }).ts;
  return (type === "task" || type === "turn") && typeof ts === "string";
}

/** Parses NDJSON text, skipping lines that are not outcome records. */
function* outcomeLines(text: string): Generator<OutcomeRecord> {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) yield parsed;
    } catch {
      // A torn last line (a crash mid-append) is skipped.
    }
  }
}

export function parseOutcomeLines(text: string): OutcomeRecord[] {
  return Array.from(outcomeLines(text));
}

/** The live file and its rotated ones, oldest first. Missing files read as empty. */
export function readOutcomeRecords(
  path: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
  options: { maxRecords?: number; accept?: (record: OutcomeRecord) => boolean } = {},
): OutcomeRecord[] {
  const records: OutcomeRecord[] = [];
  const maxRecords = options.maxRecords === undefined ? Infinity : Math.max(0, Math.floor(options.maxRecords));
  if (maxRecords === 0) return records;
  let next = 0;
  for (const file of outcomeLogFiles(path).reverse()) {
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const record of outcomeLines(text)) {
      if (options.accept?.(record) === false) continue;
      if (records.length < maxRecords) records.push(record);
      else { records[next] = record; next = (next + 1) % maxRecords; }
    }
  }
  return next === 0 ? records : records.slice(next).concat(records.slice(0, next));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const rate = (n: number, of: number): number => (of === 0 ? 0 : n / of);

function modelStats(rows: TaskOutcomeRecord[]): ModelStats {
  const first = rows[0]!;
  const green = rows.filter((r) => r.status === "ok");
  const firstPass = green.filter(
    (r) => r.attempt <= 1 && !r.judgeRetried && !r.selfCheckNotice,
  );
  const failures = new Map<FailureCategory, number>();
  for (const r of rows) {
    if (r.failure !== null) failures.set(r.failure, (failures.get(r.failure) ?? 0) + 1);
  }
  const noticed = rows.filter((r) => r.selfCheckNotice);
  const fixed = noticed.filter((r) => r.status === "ok");
  const priced = rows.filter((r) => r.costUsd !== null);
  const escalated = rows.filter((r) => r.escalations > 0).length;
  return {
    provider: first.provider,
    model: first.model,
    leg: first.leg,
    tasks: rows.length,
    firstPassGreen: firstPass.length,
    firstPassGreenRate: rate(firstPass.length, rows.length),
    green: green.length,
    greenRate: rate(green.length, rows.length),
    greenAfterRetry: green.filter((r) => r.attempt > 1 || r.judgeRetried).length,
    topFailures: [...failures.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([category, count]) => ({ category, count })),
    escalated,
    escalationRate: rate(escalated, rows.length),
    selfCheckNotices: noticed.length,
    selfCheckFixed: fixed.length,
    selfCheckFixRate: noticed.length === 0 ? null : rate(fixed.length, noticed.length),
    syntaxDemoted: rows.filter((r) => r.syntaxDemoted).length,
    medianDurationMs: median(rows.map((r) => r.durationMs)),
    tokensIn: rows.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: rows.reduce((n, r) => n + r.tokensOut, 0),
    costUsd: priced.length === 0 ? null : priced.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [row]);
    else list.push(row);
  }
  return [...groups.values()];
}

function orchestratorStats(turns: TurnOutcomeRecord[]): OrchestratorStats {
  const reported = turns.filter((t) => t.orchestrator.cachedTokens !== null);
  const reportedIn = reported.reduce((n, t) => n + t.orchestrator.tokensIn, 0);
  const reportedCached = reported.reduce((n, t) => n + (t.orchestrator.cachedTokens ?? 0), 0);
  const stepRates = turns.flatMap((t) =>
    t.orchestrator.steps.flatMap((s) =>
      s.cached === null || s.in <= 0 ? [] : [Math.min(s.cached, s.in) / s.in],
    ),
  );
  const priced = turns.filter((t) => t.orchestrator.costUsd !== null);
  // A turn whose requests were unpriced is unpriced, even when its judge
  // or escalation calls were priced.
  const unpriced = turns.filter((t) => {
    // A record without the split field: its total is all it has.
    const requests = (t.orchestrator as { requestCostUsd?: number | null }).requestCostUsd;
    return (
      t.orchestrator.requests > 0 &&
      (requests === undefined ? t.orchestrator.costUsd : requests) === null
    );
  });
  return {
    provider: turns[0]!.orchestrator.provider,
    models: [...new Set(turns.map((t) => t.orchestrator.model))],
    turns: turns.length,
    requests: turns.reduce((n, t) => n + t.orchestrator.requests, 0),
    tokensIn: turns.reduce((n, t) => n + t.orchestrator.tokensIn, 0),
    tokensOut: turns.reduce((n, t) => n + t.orchestrator.tokensOut, 0),
    cacheHitPct:
      reportedIn === 0 ? null : Math.round((Math.min(reportedCached, reportedIn) / reportedIn) * 100),
    avgStepCacheHitPct:
      stepRates.length === 0
        ? null
        : Math.round((stepRates.reduce((a, b) => a + b, 0) / stepRates.length) * 100),
    costUsd:
      priced.length === 0 ? null : priced.reduce((n, t) => n + (t.orchestrator.costUsd ?? 0), 0),
    unpricedTurns: unpriced.length,
  };
}

const byTasks = (a: ModelStats, b: ModelStats): number =>
  b.tasks - a.tasks || a.model.localeCompare(b.model);

export function aggregateOutcomes(
  records: readonly OutcomeRecord[],
  options: ReportOptions = {},
): FusionReport {
  const now = options.now ?? new Date();
  const sinceMs =
    options.days === undefined ? undefined : now.getTime() - options.days * 86_400_000;
  const inWindow = records.filter((r) => {
    if (sinceMs === undefined) return true;
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= sinceMs;
  });
  const needle = options.model?.toLowerCase();
  const matches = (model: string, provider: string): boolean =>
    needle === undefined ||
    model.toLowerCase().includes(needle) ||
    provider.toLowerCase().includes(needle);
  const tasks = inWindow.filter(
    (r): r is TaskOutcomeRecord => r.type === "task" && matches(r.model, r.provider),
  );
  const turns = inWindow.filter(
    (r): r is TurnOutcomeRecord =>
      r.type === "turn" && matches(r.orchestrator.model, r.orchestrator.provider),
  );
  const key = (r: TaskOutcomeRecord): string => `${r.provider}\u0000${r.model}\u0000${r.leg}`;
  const workers = groupBy(tasks.filter((r) => r.leg !== "orchestrator"), key)
    .map(modelStats)
    .sort(byTasks);
  const orchestratorTargets = groupBy(tasks.filter((r) => r.leg === "orchestrator"), key)
    .map(modelStats)
    .sort(byTasks);
  const orchestrator = groupBy(turns, (t) => t.orchestrator.provider)
    .map(orchestratorStats)
    .sort((a, b) => b.turns - a.turns || a.provider.localeCompare(b.provider));
  const strongParts = [
    ...orchestrator.map((o) => o.costUsd),
    ...orchestratorTargets.map((o) => o.costUsd),
  ].filter((n): n is number => n !== null);
  return {
    since: sinceMs === undefined ? null : new Date(sinceMs).toISOString(),
    tasks: tasks.length,
    turns: turns.length,
    workers,
    orchestratorTargets,
    orchestrator,
    strongSpendUsd: strongParts.length === 0 ? null : strongParts.reduce((a, b) => a + b, 0),
    strongSpendPartial:
      orchestrator.some((o) => o.unpricedTurns > 0) ||
      tasks.some((r) => r.leg === "orchestrator" && r.costUsd === null),
  };
}

/** `report`'s flags (`--days N`, `--model X`, `--json`); a string is a usage error. */
export function parseReportArgs(
  args: readonly string[],
): (ReportOptions & { json: boolean }) | string {
  const out: ReportOptions & { json: boolean } = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--days") {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) return "--days needs a positive number";
      out.days = value;
      i += 1;
    } else if (arg === "--model") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        return "--model needs a model or provider name";
      }
      out.model = value;
      i += 1;
    } else {
      return `unknown option: ${arg}`;
    }
  }
  return out;
}

/** The report for the log at `path`, as text or JSON: what the CLI and `/fusion report` print. */
export function renderOutcomeReport(
  path: string,
  options: ReportOptions & { json?: boolean },
  read?: (file: string) => string,
): string {
  const report = aggregateOutcomes(readOutcomeRecords(path, read), options);
  return options.json === true
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatFusionReport(report, options);
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function modelRows(stats: ModelStats[]): string[] {
  return table(
    ["model", "leg", "tasks", "1st-pass", "green", "after retry", "escalated", "self-check fixed", "median", "tokens in/out", "spend", "top failures"],
    stats.map((s) => [
      s.model === s.provider ? s.model : `${s.model} (${s.provider})`,
      s.leg,
      String(s.tasks),
      pct(s.firstPassGreenRate),
      pct(s.greenRate),
      String(s.greenAfterRetry),
      pct(s.escalationRate),
      s.selfCheckFixRate === null ? "-" : `${s.selfCheckFixed}/${s.selfCheckNotices}`,
      formatDurationShort(s.medianDurationMs),
      `${formatTokenCount(s.tokensIn)}/${formatTokenCount(s.tokensOut)}`,
      s.costUsd === null ? "unpriced" : formatUsdShort(s.costUsd),
      s.topFailures.length === 0
        ? "-"
        : s.topFailures.map((f) => `${f.category} ${f.count}`).join(", "),
    ]),
  );
}

export function formatFusionReport(report: FusionReport, options: ReportOptions = {}): string {
  const window = options.days === undefined ? "all kept history" : `last ${options.days} day${options.days === 1 ? "" : "s"}`;
  const filter = options.model === undefined ? "" : `, model matching "${options.model}"`;
  const lines = [`Fusion outcomes, ${window}${filter}: ${report.tasks} task${report.tasks === 1 ? "" : "s"}, ${report.turns} turn${report.turns === 1 ? "" : "s"}`];
  if (report.tasks === 0 && report.turns === 0) {
    lines.push("", "Nothing recorded yet. Fusion turns write their outcomes once a fan-out finishes.");
    return `${lines.join("\n")}\n`;
  }
  if (report.workers.length > 0) {
    lines.push("", "Worker models", ...modelRows(report.workers));
  }
  if (report.orchestratorTargets.length > 0) {
    lines.push("", "Tasks sent to the orchestrator's model", ...modelRows(report.orchestratorTargets));
  }
  if (report.orchestrator.length > 0) {
    lines.push(
      "",
      "Orchestrator",
      ...table(
        ["provider", "turns", "requests", "tokens in/out", "cache hit", "avg step hit", "spend"],
        report.orchestrator.map((o) => [
          o.provider,
          String(o.turns),
          String(o.requests),
          `${formatTokenCount(o.tokensIn)}/${formatTokenCount(o.tokensOut)}`,
          o.cacheHitPct === null ? "not reported" : `${o.cacheHitPct}%`,
          o.avgStepCacheHitPct === null ? "-" : `${o.avgStepCacheHitPct}%`,
          o.costUsd === null
            ? "unpriced"
            : `${formatUsdShort(o.costUsd)}${o.unpricedTurns > 0 ? ` (+${o.unpricedTurns} unpriced)` : ""}`,
        ]),
      ),
    );
  }
  lines.push(
    "",
    `Strong-side spend: ${
      report.strongSpendUsd === null
        ? "unpriced (subscription or no price known)"
        : `${formatUsdShort(report.strongSpendUsd)}${report.strongSpendPartial ? " + unpriced (subscription or no price known)" : ""}`
    }`,
    "1st-pass: green on the first attempt with no judge retry and no self-check notice. after retry: green after a replan or judge retry.",
  );
  return `${lines.join("\n")}\n`;
}
