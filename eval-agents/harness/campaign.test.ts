import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "gaia-campaign-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function campaign(name: string, extra: Record<string, string>, forwarded: string[] = []) {
  const reportDir = join(scratch, name);
  if (extra.GAIA_FIXTURE_BLOCK_CSV === "1") mkdirSync(join(reportDir, "matrix.csv"), { recursive: true });
  const result = spawnSync(process.execPath, [
    join(root, "node_modules/vitest/vitest.mjs"), "run", "--config",
    "eval-agents/fixtures/campaign.vitest.ts", "--reporter=default", "--reporter=json",
    "--outputFile", `${reportDir}.vitest.json`, ...forwarded,
  ], {
    cwd: root,
    env: { ...process.env, ATOMIC_AGENT_STATE_DIR: join(scratch, "state"),
      ATOMIC_AGENT_EVAL_LLAMA_URL: "http://127.0.0.1:1",
      ATOMIC_AGENT_EVAL_AGENTS: "ready", ATOMIC_AGENT_GAIA_TASK_IDS: "smoke-001",
      ATOMIC_AGENT_GAIA_LEVEL: "1", ATOMIC_AGENT_GAIA_LIMIT: "1",
      ATOMIC_AGENT_GAIA_SOURCE: "fixtures", ATOMIC_AGENT_GAIA_REPORT_DIR: reportDir,
      ...extra },
    encoding: "utf8", timeout: 15_000,
  });
  if (result.error) throw result.error;
  const vitestReport = readFileSync(`${reportDir}.vitest.json`, "utf8");
  return { ...result, reportDir, output: `${result.stdout}\n${result.stderr}\n${vitestReport}` };
}

describe("actual GAIA campaign wiring (hermetic child Vitest)", () => {
  it("records an adapter exception as an attempted failed case alongside completed cases", () => {
    const result = campaign("adapter-throws", { ATOMIC_AGENT_EVAL_AGENTS: "ready,other", GAIA_FIXTURE_THROW_AGENT: "ready" });
    expect(result.status, result.output).toBe(1);
    const summary = JSON.parse(readFileSync(join(result.reportDir, "campaign.json"), "utf8"));
    expect(summary).toMatchObject({ selected: 2, executed: 2, attempted: 2, completed: 1, failed: 1, skipped: 0, reportErrors: 0 });
    const rows = readFileSync(join(result.reportDir, "matrix.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].result).toMatchObject({ agentId: "ready", correct: false, skipped: false, error: "case exception: fixture adapter exploded" });
    expect(rows[1].result).toMatchObject({ agentId: "other", correct: true, error: null });
  });

  it("retains invocation counters and the other report when a real CSV write fails", () => {
    const result = campaign("report-write-fails", { GAIA_FIXTURE_BLOCK_CSV: "1" });
    expect(result.status, result.output).toBe(1);
    const summary = JSON.parse(readFileSync(join(result.reportDir, "campaign.json"), "utf8"));
    expect(summary).toMatchObject({ selected: 1, executed: 1, attempted: 1, completed: 1, failed: 0, skipped: 0, reportErrors: 1 });
    expect(summary.errors[0]).toMatchObject({ stage: "csv-report", agentId: "ready", taskId: "smoke-001" });
    const record = JSON.parse(readFileSync(join(result.reportDir, "matrix.jsonl"), "utf8"));
    expect(record.result).toMatchObject({ agentId: "ready", correct: true });
  });

  it("fails and persists a summary when the Vitest title filter selects no cases", () => {
    const result = campaign("no-title-match", {}, ["-t", "nonexistent name"]);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no GAIA agent cases executed");
    const summary = JSON.parse(readFileSync(join(result.reportDir, "campaign.json"), "utf8"));
    expect(summary).toMatchObject({ selected: 1, executed: 0, skipped: 0 });
  });

  it("does not expand an empty string agent selection into every agent", () => {
    const result = campaign("empty-string-filter", { ATOMIC_AGENT_EVAL_AGENTS: "" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no agent adapters selected");
  });

  it("fails an intended campaign selecting no dataset rows", () => {
    const result = campaign("no-rows", { ATOMIC_AGENT_GAIA_TASK_IDS: "does-not-exist" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no GAIA rows selected");
  });

  it("fails an intended campaign selecting no adapters", () => {
    const result = campaign("no-adapters", { ATOMIC_AGENT_EVAL_AGENTS: "does-not-exist" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no agent adapters selected");
  });

  it("does not expand an explicitly empty adapter filter into every agent", () => {
    const result = campaign("empty-filter", { ATOMIC_AGENT_EVAL_AGENTS: " , " });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no agent adapters selected");
  });

  it("fails when every selected case is unavailable and reports real skips", () => {
    const result = campaign("all-skipped", { ATOMIC_AGENT_EVAL_AGENTS: "missing" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no GAIA agent cases executed");
    const summary = JSON.parse(readFileSync(join(result.reportDir, "campaign.json"), "utf8"));
    expect(summary).toMatchObject({ selected: 1, executed: 0, skipped: 1 });
  });

  it("reports partial unavailability as skipped while preserving executed success", () => {
    const result = campaign("partial", { ATOMIC_AGENT_EVAL_AGENTS: "ready,missing" });
    expect(result.status, result.output).toBe(0);
    const summary = JSON.parse(readFileSync(join(result.reportDir, "campaign.json"), "utf8"));
    expect(summary).toMatchObject({ selected: 2, executed: 1, skipped: 1 });
    const vitest = JSON.parse(readFileSync(`${result.reportDir}.vitest.json`, "utf8"));
    expect(vitest).toMatchObject({ numPassedTests: 1, numPendingTests: 1 });
    const rows = readFileSync(join(result.reportDir, "matrix.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.result.skipped)).toEqual([false, true]);
    expect(rows[1].result.skipReason).toBe("fixture executable unavailable");
  });
});
