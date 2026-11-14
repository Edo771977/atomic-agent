import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadEvalAgentsEnvFile } from "./harness/load-env.js";

loadEvalAgentsEnvFile();

import { listAgentAdapters } from "./adapters/index.js";
import { appendCsvRow, appendJsonlRow } from "./harness/append-report.js";
import { captureEnvironmentSnapshot } from "./harness/environment-lock.js";
import { loadGaiaRows } from "./harness/load-gaia-rows.js";
import { runGaiaCase } from "./harness/run-gaia-case.js";
import type { GaiaAgentRunResult } from "./harness/gaia-types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_DIR = process.env.ATOMIC_AGENT_GAIA_REPORT_DIR
  ? resolve(process.env.ATOMIC_AGENT_GAIA_REPORT_DIR)
  : resolve(HERE, "reports", `run-${TIMESTAMP}`);
process.env.ATOMIC_AGENT_GAIA_REPORT_DIR = REPORT_DIR;
const CSV_PATH = resolve(REPORT_DIR, "matrix.csv");
const JSONL_PATH = resolve(REPORT_DIR, "matrix.jsonl");
const TRACES_DIR = resolve(REPORT_DIR, "traces");

const chatUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL ?? "";
const embedUrl = process.env.ATOMIC_AGENT_EVAL_EMBED_URL ?? null;

function parseAgentFilter(): string[] | undefined {
  const raw = process.env.ATOMIC_AGENT_EVAL_AGENTS;
  if (raw === undefined) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadRows() {
  const source = (process.env.ATOMIC_AGENT_GAIA_SOURCE ?? "auto") as
    | "fixtures"
    | "hf"
    | "auto";
  const level = process.env.ATOMIC_AGENT_GAIA_LEVEL
    ? Number(process.env.ATOMIC_AGENT_GAIA_LEVEL)
    : null;
  const limit = process.env.ATOMIC_AGENT_GAIA_LIMIT
    ? Number(process.env.ATOMIC_AGENT_GAIA_LIMIT)
    : null;
  // Like the agent filter: absent selects every row, an explicitly empty or
  // comma-only list selects none (and the campaign fails as empty).
  const rawTaskIds = process.env.ATOMIC_AGENT_GAIA_TASK_IDS;
  const taskIds = rawTaskIds === undefined
    ? null
    : rawTaskIds.split(",").map((s) => s.trim()).filter(Boolean);
  return loadGaiaRows({ source, level, limit, taskIds });
}

beforeAll(async () => {
  loadEvalAgentsEnvFile();
  mkdirSync(REPORT_DIR, { recursive: true });
  if (chatUrl) {
    const snap = await captureEnvironmentSnapshot({
      chatUrl,
      embeddingUrl: embedUrl,
    });
    writeFileSync(
      resolve(REPORT_DIR, "environment.json"),
      `${JSON.stringify(snap, null, 2)}\n`,
      "utf8",
    );
  }
});

describe("GAIA multi-agent matrix", () => {
  const rows = loadRows();
  const adapters = listAgentAdapters(parseAgentFilter());
  const campaign = {
    selected: rows.length * adapters.length,
    // executed is retained as an alias of actual adapter invocations.
    executed: 0, attempted: 0, completed: 0, failed: 0, skipped: 0, reportErrors: 0,
    errors: [] as Array<{ stage: string; agentId: string; taskId: string; message: string }>,
  };
  const persistCampaign = () => {
    try {
      writeFileSync(resolve(REPORT_DIR, "campaign.json"), `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
    } catch (error) {
      // If the destination itself is unusable, stderr still carries the
      // counters; the write error fails the campaign rather than hiding work.
      console.error(`[GAIA campaign report failure] ${JSON.stringify(campaign)}`);
      throw error;
    }
  };
  // Collection runs even when Vitest skips every test by title. Persist the
  // initial zero counters before hooks so that skipped campaigns stay visible.
  mkdirSync(REPORT_DIR, { recursive: true });
  persistCampaign();

  afterAll(() => {
    persistCampaign();
    console.error(`[GAIA campaign] ${JSON.stringify(campaign)}`);
    if (campaign.selected > 0) {
      expect(campaign.executed, "no GAIA agent cases executed; all selected cases were skipped or filtered out").toBeGreaterThan(0);
    }
  });

  if (rows.length === 0 || adapters.length === 0) {
    test("matrix is empty (no rows or no adapters selected)", () => {
      expect.soft(rows.length, "no GAIA rows selected; check dataset and task filters").toBeGreaterThan(0);
      expect.soft(adapters.length, "no agent adapters selected; check ATOMIC_AGENT_EVAL_AGENTS").toBeGreaterThan(0);
    });
  }

  for (const adapter of adapters) {
    describe(adapter.label, () => {
      for (const row of rows) {
        const title = `[L${row.Level}] ${row.task_id}`;
        test(title, async (context) => {
          let result: GaiaAgentRunResult;
          const started = Date.now();
          try {
            if (!chatUrl) throw new Error("ATOMIC_AGENT_EVAL_LLAMA_URL is required for agent runs");
            result = await runGaiaCase({
              adapter, row, chatUrl, embedUrl,
              maxSteps: Number(process.env.ATOMIC_AGENT_GAIA_MAX_STEPS ?? "30"),
              timeoutMs: Number(process.env.ATOMIC_AGENT_GAIA_TIMEOUT_MS ?? "600000"),
              tracesOutDir: TRACES_DIR,
              onAttempt: () => { campaign.attempted += 1; campaign.executed += 1; },
              onComplete: () => { campaign.completed += 1; },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            campaign.errors.push({ stage: "case", agentId: adapter.id, taskId: row.task_id, message });
            result = {
              agentId: adapter.id, taskId: row.task_id, rawReply: "", extractedAnswer: "", correct: false,
              skipped: false, skipReason: null, error: `case exception: ${message}`,
              metrics: { stepCount: null, promptTokens: null, predictedTokens: null, toolErrors: null,
                wallClockMs: Date.now() - started, timedOut: false, exitCode: null },
            };
          }
          if (result.skipped) campaign.skipped += 1;
          else if (result.error !== null || !result.correct) campaign.failed += 1;
          // Save invocation accounting before either matrix write can fail.
          persistCampaign();
          const reportErrorsBefore = campaign.reportErrors;
          for (const [stage, append] of [
            ["csv-report", () => appendCsvRow(CSV_PATH, row, result)],
            ["jsonl-report", () => appendJsonlRow(JSONL_PATH, row, result)],
          ] as const) {
            try { append(); }
            catch (error) {
              campaign.reportErrors += 1;
              campaign.errors.push({ stage, agentId: adapter.id, taskId: row.task_id,
                message: error instanceof Error ? error.message : String(error) });
            }
          }
          persistCampaign();
          expect(campaign.reportErrors, "GAIA matrix report writes failed; see campaign.json errors").toBe(reportErrorsBefore);

          if (result.skipped) {
            expect(result.skipReason, "skipped cases must report a reason").toBeTruthy();
            context.skip();
          }

          expect.soft(result.error, result.error ?? "no error").toBeNull();
          expect(result.correct, `extracted=${result.extractedAnswer} gold=${row["Final answer"]}`).toBe(
            true,
          );
        });
      }
    });
  }
});
