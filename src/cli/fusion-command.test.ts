import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FusionOutcomeLog, outcomeLogPath } from "../tools/fusion/index.js";
import { fusionCommand } from "./fusion-command.js";

describe("atomic-agent fusion", () => {
  let dir: string;
  let out: string;
  let err: string;
  const io = () => ({
    stateDir: () => dir,
    stdout: (t: string) => void (out += t),
    stderr: (t: string) => void (err += t),
    now: () => new Date("2026-11-10T00:00:00Z"),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-cli-"));
    out = "";
    err = "";
    new FusionOutcomeLog({ path: outcomeLogPath(dir) }).append([
      {
        v: 1, type: "task", ts: "2026-11-09T00:00:00.000Z", session: "abc",
        provider: "local-llama", model: "small", leg: "local", role: null,
        status: "ok", failure: null, attempt: 1, judgeRetried: false,
        selfCheckNotice: false, escalations: 0, judge: "off", syntaxDemoted: false,
        steps: 3, durationMs: 5000, tokensIn: 100, tokensOut: 10,
        cachedTokens: null, costUsd: null, merge: null,
      },
    ]);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the report as a table", async () => {
    expect(await fusionCommand(["report", "--days", "7"], io())).toBe(0);
    expect(out).toContain("Fusion outcomes, last 7 days: 1 task, 0 turns");
    expect(out).toMatch(/small \(local-llama\)\s+local\s+1\s+100%/);
  });

  it("prints JSON with --json", async () => {
    expect(await fusionCommand(["report", "--json", "--model", "small"], io())).toBe(0);
    const report = JSON.parse(out) as { tasks: number; workers: Array<{ model: string }> };
    expect(report.tasks).toBe(1);
    expect(report.workers[0]!.model).toBe("small");
  });

  it("prints help, and exits 2 on a usage error", async () => {
    expect(await fusionCommand([], io())).toBe(0);
    expect(out).toContain("report [--days N] [--model X] [--json]");
    expect(await fusionCommand(["nope"], io())).toBe(2);
    expect(err).toContain("unknown subcommand: nope");
    expect(await fusionCommand(["report", "--days", "-1"], io())).toBe(2);
    expect(err).toContain("--days needs a positive number");
  });
});
