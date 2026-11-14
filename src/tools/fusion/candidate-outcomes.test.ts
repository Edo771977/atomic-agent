import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCandidateOutcome } from "./candidate-outcomes.js";
import { aggregateOutcomes, formatFusionReport, parseOutcomeLines } from "./outcome-report.js";
import { FusionOutcomeLog, taskOutcomeRecord } from "./outcome-log.js";
import { readRoutingHistory } from "./measured-routing.js";
import type { CandidateAcceptanceReceipt } from "./candidate-acceptance.js";

const receipt: CandidateAcceptanceReceipt = {
  version: 1, id: "a".repeat(24), disposition: "promoted", checkScope: "declared", checkStatus: "passed",
  checks: { total: 2, passed: 2, failed: 0 }, inputs: { declared: 0, verified: 0 },
  checkedPayloadDigest: "b".repeat(64), checkPlanDigest: "c".repeat(64),
};
function record() {
  return taskOutcomeRecord({ id: "private-task", title: "private-title", status: "ok", reply: "secret-reply",
    stepCount: 1, durationMs: 10, checks: { total: 1, failed: 0 }, tools: { calls: 0, errors: 0, writes: 0, byTool: {} } },
  { provider: "worker", model: "small", leg: "local", role: null, taskRole: null, attempt: 1, pricing: undefined, merge: null }, "parent", new Date());
}
describe("candidate outcome telemetry", () => {
  it("keeps final own checks separate from reported status, inner checks and global integration", () => {
    const original = record();
    const candidate = withCandidateOutcome(original, receipt, [{ ok: true }, { task: "private-task", ok: true }], "private-task");
    expect(candidate).toMatchObject({ status: "ok", acceptance: "checks-passed", acceptanceScope: "task-checks",
      candidate: { receipt, taskChecks: { total: 1, passed: 1, failed: 0 } } });
    expect(original).not.toHaveProperty("candidate");
    const stats = aggregateOutcomes(parseOutcomeLines(JSON.stringify(candidate))).workers[0]!;
    expect(stats).toMatchObject({ green: 1, checksPassed: 0, checksFailed: 0, checksUnverified: 1,
      candidate: { taskRuns: 1, promoted: 1, rejected: 0, unverified: 0,
        taskChecksPassed: 1, taskChecksFailed: 0, taskChecksUnverified: 0, rejectionReasons: [] } });
    const text = formatFusionReport(aggregateOutcomes([candidate]));
    expect(text).toContain("Candidate task runs (telemetry only)");
    expect(text).toContain("telemetry only");
    const serialized = JSON.stringify(candidate);
    for (const secret of ["private-task", "private-title", "secret-reply", "command", "stdout"]) expect(serialized).not.toContain(secret);
  });
  it("does not turn call-level green into a task check and counts rejection reasons", () => {
    const rejected = withCandidateOutcome(record(), { ...receipt, disposition: "rejected", reason: "original-changed" }, [{ ok: true }], "private-task");
    const stats = aggregateOutcomes([rejected]).workers[0]!;
    expect(stats).toMatchObject({ green: 1, checksPassed: 0,
      candidate: { taskRuns: 1, promoted: 0, rejected: 1, taskChecksUnverified: 1,
        rejectionReasons: [{ reason: "original-changed", count: 1 }] } });
  });
  it("bounds metadata and strips prose while preserving an unverified candidate discriminator", () => {
    const polluted = { ...receipt, path: "/secret/path", reason: "secret reason", checks: { total: -1, passed: 0, failed: 0 } };
    const bad = withCandidateOutcome(record(), polluted as unknown as CandidateAcceptanceReceipt, [], "private-task");
    expect(bad.candidate).toEqual({ taskChecks: { total: 0, passed: 0, failed: 0 } });
    expect(JSON.stringify(bad)).not.toContain("secret");
    for (const candidate of [null, false, {}, { receipt }, { receipt: { ...receipt, disposition: "unknown" } }]) {
      const row = { ...record(), candidate } as unknown as ReturnType<typeof record>;
      const stats = aggregateOutcomes(parseOutcomeLines(JSON.stringify(row))).workers[0]!;
      expect(stats.checksPassed).toBe(0);
      expect(stats.candidate).toMatchObject({ taskRuns: 1, unverified: 1 });
    }
  });
  it("roundtrips unchanged and failed final checks through the actual writer and history reader", () => {
    const root = mkdtempSync(join(tmpdir(), "candidate-outcomes-"));
    try {
      const path = join(root, "outcomes.ndjson");
      const log = new FusionOutcomeLog({ path, enabled: () => true });
      const unchanged = withCandidateOutcome(record(), { ...receipt, disposition: "unchanged" }, [{ task: "private-task", ok: true }], "private-task");
      const rejected = withCandidateOutcome(record(), { ...receipt, disposition: "rejected", checkStatus: "failed", reason: "checks-failed",
        checks: { total: 2, passed: 1, failed: 1 } }, [{ task: "private-task", ok: false }, { ok: true }], "private-task");
      log.append([unchanged, rejected]);
      const rows = readRoutingHistory(path);
      expect(rows).toEqual([unchanged, rejected]);
      expect(aggregateOutcomes(rows).workers[0]).toMatchObject({ green: 2, checksPassed: 0, checksUnverified: 2,
        candidate: { taskRuns: 2, unchanged: 1, rejected: 1, taskChecksPassed: 1, taskChecksFailed: 1, taskChecksUnverified: 0,
          rejectionReasons: [{ reason: "checks-failed", count: 1 }] } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects unknown versions, contradictory receipt counts and oversized fields without copying them", () => {
    for (const over of [{ version: 2 }, { id: "private-id" }, { checkedPayloadDigest: "secret" },
      { disposition: "future" }, { checkScope: "semantic" }, { checkStatus: "future" }, { reason: "secret reason" },
      { checks: { total: 1, passed: 2, failed: 0 } }, { checks: { total: 1_000_001, passed: 1_000_001, failed: 0 } },
      { inputs: { declared: 0, verified: 1 } }, { checkStatus: "unverified" }]) {
      const row = withCandidateOutcome(record(), { ...receipt, ...over } as CandidateAcceptanceReceipt, [], "private-task");
      expect(row.candidate).not.toHaveProperty("receipt");
      expect(aggregateOutcomes([row]).workers[0]).toMatchObject({ checksPassed: 0, candidate: { taskRuns: 1, unverified: 1 } });
    }
    const extra = withCandidateOutcome(record(), { ...receipt, extra: "secret-path" } as CandidateAcceptanceReceipt, [], "private-task");
    expect(extra.candidate?.receipt).toEqual(receipt);
    expect(JSON.stringify(extra)).not.toContain("secret-path");
  });
  it("treats nonstring JSON enums as unverified without crashing the report or leaking runtime extras", () => {
    for (const field of ["disposition", "checkScope", "checkStatus"] as const) {
      for (const value of [[receipt[field]], { toString: null }, {}]) {
        const row = { ...record(), candidate: { receipt: { ...receipt, [field]: value }, taskChecks: { total: 0, passed: 0, failed: 0 } } };
        const parsed = parseOutcomeLines(JSON.stringify(row));
        expect(() => aggregateOutcomes(parsed)).not.toThrow();
        expect(aggregateOutcomes(parsed).workers[0]).toMatchObject({ checksPassed: 0, candidate: { promoted: 0, unverified: 1 } });
      }
    }
    const scope = { toString: () => "declared", privatePath: "C:/private/operator-project" };
    const row = withCandidateOutcome(record(), { ...receipt, checkScope: scope } as unknown as CandidateAcceptanceReceipt, [], "private-task");
    expect(JSON.stringify(row)).not.toContain("privatePath");
    expect(row.candidate).not.toHaveProperty("receipt");
  });
  it("requires promotion digests and a nonempty fully verified protected scope", () => {
    for (const invalid of [
      { ...receipt, checkedPayloadDigest: undefined }, { ...receipt, checkPlanDigest: undefined },
      { ...receipt, checkScope: "protected-declared" },
      { ...receipt, disposition: "rejected", checkScope: "protected-declared", inputs: { declared: 1, verified: 0 } },
    ]) {
      const row = withCandidateOutcome(record(), invalid as CandidateAcceptanceReceipt, [], "private-task");
      expect(row.candidate).not.toHaveProperty("receipt");
      expect(aggregateOutcomes([row]).workers[0]!.candidate.unverified).toBe(1);
    }
  });
  it("counts one retried task run separately from its two actual worker runs", () => {
    const row = withCandidateOutcome({ ...record(), judgeRetried: true, costUsd: 0.25, tokensIn: 20, durationMs: 30 }, receipt,
      [{ task: "private-task", ok: true }], "private-task", 2);
    expect(row.candidate).toMatchObject({ workerRuns: 2 });
    expect(row).toMatchObject({ attempt: 1, judgeRetried: true, costUsd: 0.25, tokensIn: 20, durationMs: 30 });
    const stats = aggregateOutcomes(parseOutcomeLines(JSON.stringify(row))).workers[0]!;
    expect(stats).toMatchObject({ checksPassed: 0, candidate: { taskRuns: 1, promoted: 1, knownWorkerRuns: 2, workerRunsUnverified: 0 } });
    expect(stats.candidate).not.toHaveProperty("executed");
    const text = formatFusionReport(aggregateOutcomes([row]));
    expect(text).toContain("Candidate task runs (telemetry only)");
    expect(text).toContain("configured leg");
    expect(text).toContain("row-reported");
  });
  it("keeps absent, invalid or oversized worker-run counts unknown instead of inventing one", () => {
    for (const workerRuns of [undefined, 0, -1, 1.5, NaN, 1_000_001, [2], { privatePath: "secret" }]) {
      const row = withCandidateOutcome(record(), receipt, [], "private-task", workerRuns as number);
      expect(row.candidate).not.toHaveProperty("workerRuns");
      expect(JSON.stringify(row)).not.toContain("secret");
      const raw = { ...row, candidate: { ...row.candidate, workerRuns } };
      const stats = aggregateOutcomes(parseOutcomeLines(JSON.stringify(raw))).workers[0]!;
      expect(stats).toMatchObject({ checksPassed: 0, candidate: { taskRuns: 1, promoted: 1, knownWorkerRuns: 0, workerRunsUnverified: 1 } });
    }
    const row = withCandidateOutcome(record(), receipt, [], "private-task", 1_000_000);
    expect(row.candidate?.workerRuns).toBe(1_000_000);
  });
});
