import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  FusionOutcomeLog,
  failureCategory,
  judgeOutcome,
  outcomeLogFiles,
  outcomeLogPath,
  rowCostUsd,
  sessionTag,
  taskOutcomeRecord,
  type TaskOutcomeRecord,
} from "./outcome-log.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

function row(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    ...new WorkerRunCollector().finish({
      id: "t1",
      title: "Secret title",
      reason: "reply",
      stepCount: 3,
      durationMs: 1234.4,
    }),
    reply: "REPLY-TEXT with sk-live-123",
    ...over,
  };
}

const CONTEXT = {
  provider: "local-llama",
  model: "small",
  leg: "local" as const,
  role: null,
  attempt: 1,
  pricing: undefined,
  merge: null,
};

describe("fusion outcome records", () => {
  it("carries counts and categories, never the reply, title or error", () => {
    const record = taskOutcomeRecord(
      row({
        status: "failed",
        error: "invalid tool-call JSON at /home/u/private/file.ts token sk-live-123",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 },
        selfCheckNotice: true,
        escalations: 2,
        syntax: { checked: 1, failedFiles: ["a.ts"], unchecked: 0 },
      }),
      CONTEXT,
      "s-parent",
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(record).toEqual({
      v: 1,
      type: "task",
      ts: "2026-11-01T00:00:00.000Z",
      session: sessionTag("s-parent"),
      provider: "local-llama",
      model: "small",
      leg: "local",
      role: null,
      status: "failed",
      failure: "tool-protocol",
      attempt: 1,
      judgeRetried: false,
      selfCheckNotice: true,
      escalations: 2,
      judge: "off",
      syntaxDemoted: true,
      steps: 3,
      durationMs: 1234,
      tokensIn: 100,
      tokensOut: 20,
      cachedTokens: 40,
      costUsd: null,
      merge: null,
    });
    const text = JSON.stringify(record);
    for (const leak of ["REPLY-TEXT", "Secret title", "sk-live", "/home/u", "s-parent", "a.ts"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("writes a model set to a local file path as its file's base name only", () => {
    const at = (model: string, provider = "local-llama") =>
      taskOutcomeRecord(row(), { ...CONTEXT, model, provider }, "s", new Date(0));
    expect(at("/home/alice/models/Qwen3-Coder-30B.Q4_K_M.gguf").model).toBe("qwen3-coder-30b.q4_k_m");
    expect(at("C:\\Users\\alice\\models\\small.gguf").model).toBe("small");
    expect(at("~/models/small").model).toBe("small");
    expect(at("./small.gguf").model).toBe("small");
    expect(at("models/x/small.bin").model).toBe("small");
    // Model ids are kept as configured, a vendor/model id included.
    expect(at("Qwen3-Coder-30B").model).toBe("Qwen3-Coder-30B");
    expect(at("vendor/model-2.5:free").model).toBe("vendor/model-2.5:free");
    // A provider id that is a path is cut down the same way.
    expect(at("small", "/home/alice/bin/llama-server").provider).toBe("llama-server");
    for (const r of [at("/home/alice/models/x.gguf"), at("small", "/home/alice/p")]) {
      expect(JSON.stringify(r)).not.toContain("alice");
    }
  });

  it("hashes the session id one way, short and stable", () => {
    expect(sessionTag("s-1")).toMatch(/^[0-9a-f]{12}$/);
    expect(sessionTag("s-1")).toBe(sessionTag("s-1"));
    expect(sessionTag("s-1")).not.toBe(sessionTag("s-2"));
  });

  it("names the failure category from the status and what demoted the row", () => {
    expect(failureCategory(row())).toBeNull();
    expect(failureCategory(row({ status: "max_steps" }))).toBe("max_steps");
    expect(failureCategory(row({ status: "timeout" }))).toBe("timeout");
    expect(failureCategory(row({ status: "failed", error: "not started: held" }))).toBe("not-started");
    expect(failureCategory(row({ status: "failed", error: "Claude Code is not signed in" }))).toBe("not-signed-in");
    expect(
      failureCategory(row({ status: "failed", error: "check failed", checks: { total: 2, failed: 1 } })),
    ).toBe("checks");
    expect(failureCategory(row({ status: "failed", error: "boom" }))).toBe("error");
  });

  it("reads the judge's verdict as green, red, unverified or off", () => {
    const judge = { green: true, total: 1, failed: 0, retried: false, costUsd: null, items: [] };
    expect(judgeOutcome(row())).toBe("off");
    expect(judgeOutcome(row({ judge }))).toBe("green");
    expect(judgeOutcome(row({ judge: { ...judge, green: false } }))).toBe("red");
    expect(judgeOutcome(row({ judge: { ...judge, unverified: "no reply" } }))).toBe("unverified");
  });

  it("prices a row only when something can price it", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };
    expect(rowCostUsd(row({ usage }), undefined)).toBeNull();
    expect(rowCostUsd(row({ usage }), { input: 2, output: 4 })).toBeCloseTo(2);
    expect(rowCostUsd(row({ usage: { ...usage, costUsd: 0.5 } }), undefined)).toBe(0.5);
  });
});

describe("FusionOutcomeLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-outcomes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (i: number): TaskOutcomeRecord =>
    taskOutcomeRecord(row({ stepCount: i }), CONTEXT, "s", new Date(0));

  it("appends one NDJSON line per record under <stateDir>/fusion/", () => {
    const path = outcomeLogPath(dir);
    expect(path).toBe(join(dir, "fusion", "outcomes.ndjson"));
    const log = new FusionOutcomeLog({ path });
    log.append([record(1), record(2)]);
    log.append([record(3)]);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as TaskOutcomeRecord).steps)).toEqual([1, 2, 3]);
  });

  it("rotates past the size bound and keeps two old files", () => {
    const path = outcomeLogPath(dir);
    const one = `${JSON.stringify(record(1))}\n`;
    const log = new FusionOutcomeLog({ path, maxBytes: one.length * 2, keep: 2 });
    for (let i = 0; i < 9; i += 1) log.append([record(i)]);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    for (const file of [path, `${path}.1`, `${path}.2`]) {
      expect(readFileSync(file, "utf8").length).toBeLessThanOrEqual(one.length * 2);
    }
    // The newest lines are in the live file.
    expect(readFileSync(path, "utf8")).toContain('"steps":8');
  });

  it("warns and carries on when the file cannot be written", () => {
    // A directory where the file should be: every append fails.
    const path = outcomeLogPath(dir);
    mkdirSync(path, { recursive: true });
    const warn = vi.fn();
    const log = new FusionOutcomeLog({ path, warn });
    expect(() => log.append([record(1)])).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "fusion: the outcome log could not be written",
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });

  it("writes nothing while the toggle is off", () => {
    const path = outcomeLogPath(dir);
    let on = false;
    const log = new FusionOutcomeLog({ path, enabled: () => on });
    log.append([record(1)]);
    expect(existsSync(path)).toBe(false);
    on = true;
    log.append([record(2)]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("starts on a fresh line after one a crash left torn", () => {
    const path = outcomeLogPath(dir);
    mkdirSync(join(dir, "fusion"), { recursive: true });
    writeFileSync(path, '{"type":"task"');
    new FusionOutcomeLog({ path }).append([record(1)]);
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines[0]).toBe('{"type":"task"');
    expect((JSON.parse(lines[1]!) as TaskOutcomeRecord).steps).toBe(1);
  });

  it("appends without rotating, and at once, while another live writer holds the lock", () => {
    const path = outcomeLogPath(dir);
    const one = `${JSON.stringify(record(1))}\n`;
    mkdirSync(join(dir, "fusion"), { recursive: true });
    // The other writer: this very (live) process, a fresh lock.
    writeFileSync(`${path}.lock`, `${process.pid} other-writer`);
    const warn = vi.fn();
    const log = new FusionOutcomeLog({ path, maxBytes: one.length, keep: 2, warn });
    const started = Date.now();
    for (let i = 0; i < 4; i += 1) log.append([record(i)]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(4);
    // Not this writer's lock to release.
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(`${process.pid} other-writer`);
  });

  it("breaks a lock whose owner is gone or that is too old, then rotates and releases it", () => {
    const path = outcomeLogPath(dir);
    const one = `${JSON.stringify(record(1))}\n`;
    mkdirSync(join(dir, "fusion"), { recursive: true });
    const log = new FusionOutcomeLog({ path, maxBytes: one.length, keep: 2 });
    log.append([record(0)]);
    // An owner pid no process has.
    writeFileSync(`${path}.lock`, "2147483646 dead-writer");
    log.append([record(1)]);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
    // A live owner, but abandoned long ago.
    writeFileSync(`${path}.lock`, `${process.pid} old-writer`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    log.append([record(2)]);
    expect(readFileSync(`${path}.2`, "utf8")).toContain('"steps":0');
    expect(readFileSync(`${path}.1`, "utf8")).toContain('"steps":1');
    expect(readFileSync(path, "utf8")).toContain('"steps":2');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("loses no line when two processes append and rotate the same file", async () => {
    const path = outcomeLogPath(dir);
    const perWriter = 150;
    // Generations enough that rotation itself never ages a line out.
    const keep = 200;
    const script = join(dir, "writer.mts");
    const logModule = pathToFileURL(join(import.meta.dirname, "outcome-log.ts")).href;
    writeFileSync(
      script,
      [
        `import { FusionOutcomeLog } from ${JSON.stringify(logModule)};`,
        `const [path, tag, count, keep] = process.argv.slice(2);`,
        `const log = new FusionOutcomeLog({ path, maxBytes: 1500, keep: Number(keep), warn: (m, f) => { console.error(m, JSON.stringify(f)); process.exitCode = 3; } });`,
        `for (let i = 0; i < Number(count); i += 1) log.append([{ v: 1, type: "task", writer: tag, i, pad: "x".repeat(200) }]);`,
      ].join("\n"),
    );
    const run = (tag: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", script, path, tag, String(perWriter), String(keep)],
          { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stderr }));
      });
    const results = await Promise.all([run("a"), run("b")]);
    for (const result of results) expect(result).toEqual({ code: 0, stderr: "" });
    const seen = new Set<string>();
    for (const file of outcomeLogFiles(path, keep)) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line === "") continue;
        const parsed = JSON.parse(line) as { writer: string; i: number };
        seen.add(`${parsed.writer}:${parsed.i}`);
      }
    }
    expect(seen.size).toBe(perWriter * 2);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 60_000);
});
