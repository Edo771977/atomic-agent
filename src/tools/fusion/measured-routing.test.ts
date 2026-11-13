import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";
import { OUTCOME_LOG_MAX_BYTES, type TaskOutcomeRecord } from "./outcome-log.js";
import { measuredTaskLegs, readRoutingHistory } from "./measured-routing.js";
import { resolveTaskLegs } from "./role-models.js";

const worker = { providerId: "worker", model: "small" };
const strong = { providerId: "strong", model: "big" };
const now = Date.parse("2026-11-13T00:00:00Z");
const identity = (provider: string) => createHash("sha256").update(provider).digest("hex");
function record(provider: string, passed: boolean, over: Partial<TaskOutcomeRecord> = {}): TaskOutcomeRecord {
  return { v: 1, type: "task", ts: new Date(now - 1000).toISOString(), session: "past", provider,
    model: provider === "worker" ? "small" : provider === "strong" ? "big" : "builder", leg: "cloud", role: null, taskRole: null,
    status: passed ? "ok" : "failed", failure: passed ? null : "checks", attempt: 1, judgeRetried: false,
    selfCheckNotice: false, escalations: 0, judge: "off", syntaxDemoted: false, steps: 1, durationMs: 100,
    tokensIn: 10, tokensOut: 10, cachedTokens: null, costUsd: null, merge: null,
    acceptance: passed ? "checks-passed" : "checks-failed", acceptanceScope: "task-checks", routingIdentity: identity(provider), ...over };
}
const samples = (provider: string, passed: boolean, over: Partial<TaskOutcomeRecord> = {}) => Array.from({ length: 3 }, () => record(provider, passed, over));
function select(records = [...samples("worker", false), ...samples("strong", true)], options: {
  tasks?: DelegateTask[]; roles?: FusionRoleModels; remaining?: number; attempted?: boolean;
} = {}) {
  const tasks = options.tasks ?? [{ id: "a", title: "Build", instructions: "build" }];
  return measuredTaskLegs(tasks, resolveTaskLegs(tasks, worker, options.roles, strong), worker, options.roles, strong,
    { records, minSamples: 3, days: 30, now, remainingOrchestrator: options.remaining ?? 2,
      attempted: () => options.attempted === true, cliToolsStayOn: () => false, identityFor: identity });
}

describe("measured routing evidence and admission", () => {
  it("chooses configured build targets and exact requested-role evidence", () => {
    const roles: FusionRoleModels = { byRole: { build: { providerId: "build", model: "builder", local: false } }, mixLocalModels: false, localLegProviderIds: [] };
    const result = select([...samples("worker", false), ...samples("build", true)], { roles });
    expect(result.legs.get("a")?.providerId).toBe("build");
    expect(select([...samples("worker", false), ...samples("build", true, { taskRole: "review" })], { roles }).legs.get("a")?.providerId).toBe("worker");
    expect(select(undefined, { roles, tasks: [{ id: "a", title: "Build", instructions: "build", role: "build" }] }).decisions[0]?.reason).toBe("pinned");
  });
  it("never discovers an unconfigured provider from its scores", () => {
    expect(select([...samples("worker", false), ...samples("alien", true)]).legs.get("a")?.providerId).toBe("worker");
  });
  it("allocates remaining strong capacity in deterministic task order", () => {
    const tasks = ["a", "b"].map((id) => ({ id, title: "Build", instructions: "build" }));
    const result = select(undefined, { tasks, remaining: 1 });
    expect([...result.legs.values()].map((leg) => leg.providerId)).toEqual(["strong", "worker"]);
    expect(result.decisions[1]?.excluded).toContainEqual({ provider: "strong", reason: "strong-target-cap" });
  });
  it("guards a second local build model", () => {
    const roles: FusionRoleModels = { byRole: { build: { providerId: "build", model: "builder", local: true } }, mixLocalModels: false, localLegProviderIds: ["worker"] };
    expect(select([...samples("worker", false), ...samples("build", true)], { roles }).legs.get("a")?.providerId).toBe("worker");
  });
  it.each(["out-of-credit", "not-signed-in", "tool-protocol", "cli-missing", "timeout", "cancelled"] as const)("does not route around latest %s history", (failure) => {
    const result = select([...samples("worker", false), ...samples("strong", true), record("worker", false, { failure, ts: new Date(now).toISOString() })]);
    expect(result.legs.get("a")?.providerId).toBe("worker");
    expect(result.decisions[0]?.reason).toBe("blocking-history");
  });
  it("lets a blocking row expire after the cooldown so an excluded alternative can be chosen again", () => {
    const blocker = (hoursAgo: number) => record("strong", false, { status: "timeout", failure: "timeout", ts: new Date(now - hoursAgo * 3_600_000).toISOString() });
    const older = samples("strong", true).map((r) => ({ ...r, ts: new Date(now - 72 * 3_600_000).toISOString() }));
    const fresh = select([...samples("worker", false), ...older, blocker(1)]);
    expect(fresh.legs.get("a")?.providerId).toBe("worker");
    expect(fresh.decisions[0]?.excluded).toContainEqual({ provider: "strong", reason: "blocking-history" });
    // A leg excluded by its last run never runs again, so that row stays the
    // latest; after the cooldown its earlier verified history counts again.
    const expired = select([...samples("worker", false), ...older, blocker(25)]);
    expect(expired.legs.get("a")?.providerId).toBe("strong");
    expect(expired.decisions[0]?.candidates[1]?.blocked).toBe(false);
  });
  it("requires objective acceptance, first attempts and enough samples on each side", () => {
    for (const over of [{ acceptance: undefined }, { attempt: 2 }, { escalations: 1 }, { judgeRetried: true }, { judgeRetried: undefined }, { merge: "held" as const }, { ts: "bad" }, { ts: new Date(now + 1).toISOString() }, { v: 99 }, { durationMs: NaN }]) {
      expect(select([...samples("worker", false), ...samples("strong", true, over)]).legs.get("a")?.providerId).toBe("worker");
    }
    expect(select([...samples("worker", false), record("strong", true)]).legs.get("a")?.providerId).toBe("worker");
  });
  it("unknown cost is null and never a free-cost advantage", () => {
    const result = select([...samples("worker", true, { costUsd: .1 }), ...samples("strong", true, { costUsd: null })]);
    expect(result.legs.get("a")?.providerId).toBe("worker");
    expect(result.decisions[0]?.candidates[1]?.medianCostUsd).toBeNull();
    expect(select([...samples("worker", true, { costUsd: .1 }), ...samples("strong", true, { costUsd: .05 })]).legs.get("a")?.providerId).toBe("strong");
  });
  it("can compare latency at equal acceptance without fabricating cost", () => {
    expect(select([...samples("worker", true, { durationMs: 500 }), ...samples("strong", true)]).legs.get("a")?.providerId).toBe("strong");
  });
  it("accepts an exact ten percentage point gain from two to three of ten checks", () => {
    const records = ["worker", "strong"].flatMap((provider) => Array.from({ length: 10 }, (_, i) => record(provider, i < (provider === "worker" ? 2 : 3))));
    expect(select(records).legs.get("a")?.providerId).toBe("strong");
  });
  it("excludes path-sanitized model aliases instead of attributing collisions", () => {
    const tasks = [{ id: "a", title: "Build", instructions: "build" }];
    const pathWorker = { providerId: "worker", model: "/models/small.gguf" };
    const result = measuredTaskLegs(tasks, resolveTaskLegs(tasks, pathWorker, undefined, strong), pathWorker, undefined, strong,
      { records: [...samples("worker", false), ...samples("strong", true)], minSamples: 3, days: 30, now, remainingOrchestrator: 2, attempted: () => false, cliToolsStayOn: () => false });
    expect(result.decisions[0]?.reason).toBe("insufficient-evidence");
  });
  it("reads rotation, skips malformed/torn records and tolerates unavailable history", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-history-"));
    try {
      const path = join(dir, "outcomes.ndjson");
      writeFileSync(path + ".1", JSON.stringify(record("worker", false)) + "\n{torn");
      writeFileSync(path, "bad\n" + JSON.stringify(record("strong", true)) + "\n{}");
      expect(readRoutingHistory(path)).toHaveLength(2);
      mkdirSync(join(dir, "unreadable"));
      expect(readRoutingHistory(join(dir, "unreadable"))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("bounds external oversized files to the tail without parsing a partial first line", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-bound-"));
    try {
      const path = join(dir, "outcomes.ndjson");
      writeFileSync(path, JSON.stringify(record("worker", false)) + "\n" + "x".repeat(OUTCOME_LOG_MAX_BYTES) + "\n" + JSON.stringify(record("strong", true)));
      expect(readRoutingHistory(path).map((r) => r.type === "task" ? r.provider : null)).toEqual(["strong"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects dense malformed rows within the byte cap without spread overflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-dense-"));
    try {
      const path = join(dir, "outcomes.ndjson");
      writeFileSync(path, '{"type":"task","ts":""}\n'.repeat(200_000));
      expect(readRoutingHistory(path)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
