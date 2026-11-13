import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/agent-loop.js";
import { countLineDelta } from "../os/fs/fs-edit-diff.js";
import {
  CHANGED_PATHS_SHOWN,
  describeChanges,
  FileChangeLog,
  mergeFileChanges,
  presentChangedPaths,
} from "./worker-changes.js";
import {
  formatDelegateOutput,
  GREEN_REPLY_CHARS,
  GREEN_REPLY_KEPT_CHARS,
  WorkerRunCollector,
  type WorkerTaskResult,
} from "./worker-result.js";

function executed(
  tool: string,
  details: Record<string, unknown>,
  status: "ok" | "error" = "ok",
): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool, status, summary: "done", details, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  };
}

function row(overrides: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "Task",
    status: "ok",
    reply: "done",
    stepCount: 3,
    durationMs: 1000,
    tools: { calls: 2, errors: 0, writes: 1, byTool: {} },
    ...overrides,
  };
}

describe("countLineDelta", () => {
  it("counts the changed region, not the whole file", () => {
    expect(countLineDelta("a\nb\nc\n", "a\nB\nB2\nc\n")).toEqual({
      addedLines: 2,
      removedLines: 1,
    });
    expect(countLineDelta("", "x\ny\n")).toEqual({ addedLines: 2, removedLines: 0 });
    expect(countLineDelta("same\n", "same\n")).toEqual({ addedLines: 0, removedLines: 0 });
  });
});

describe("changed paths from the worker's tool events", () => {
  it("records new, modified, patched and moved files relative to the worker's folder", () => {
    const c = new WorkerRunCollector({ workingDir: "/w" });
    c.observe(executed("os.fs.write", { path: "/w/src/new.ts", existed: false, addedLines: 12, removedLines: 0 }));
    c.observe(executed("os.fs.write", { path: "/w/a.ts", existed: true, addedLines: 30, removedLines: 2 }));
    c.observe(executed("os.fs.edit", { path: "/w/a.ts", addedLines: 10, removedLines: 1 }));
    c.observe(
      executed("os.fs.patch", {
        mode: "applied",
        files: [
          { path: "b.ts", absolute: "/w/b.ts", applied: true, addedLines: 4, removedLines: 4 },
          { path: "c.ts", absolute: "/w/c.ts", applied: false, addedLines: 9, removedLines: 9 },
        ],
      }),
    );
    c.observe(executed("os.fs.move", { moves: [{ from: "/w/old.ts", to: "/w/lib/moved.ts" }] }));
    // A refused write changed nothing.
    c.observe(executed("os.fs.write", { path: "/w/refused.ts" }, "error"));
    // Outside the folder: kept absolute.
    c.observe(executed("os.fs.edit", { path: "/elsewhere/x.ts", addedLines: 1, removedLines: 0 }));
    const r = c.finish({ id: "t1", title: "T", reason: "reply", stepCount: 4, durationMs: 10 });
    expect(describeChanges(r.changes)).toBe(
      "changed: src/new.ts (new, +12), a.ts (+40/-3), b.ts (+4/-4), lib/moved.ts (moved from old.ts), /elsewhere/x.ts (+1/-0)",
    );
  });

  it("keeps a created-then-renamed file new, and drops one created then trashed", () => {
    const log = new FileChangeLog("/w");
    log.observe({ tool: "os.fs.write", status: "ok", summary: "", truncated: false, details: { path: "/w/tmp.js", existed: false, addedLines: 3, removedLines: 0 } });
    log.observe({ tool: "os.fs.move", status: "ok", summary: "", truncated: false, details: { moves: [{ from: "/w/tmp.js", to: "/w/final.js" }] } });
    log.observe({ tool: "os.fs.write", status: "ok", summary: "", truncated: false, details: { path: "/w/scratch.txt", existed: false, addedLines: 1, removedLines: 0 } });
    log.observe({ tool: "os.fs.trash", status: "ok", summary: "", truncated: false, details: { paths: ["/w/scratch.txt", "/w/gone.css"] } });
    log.observe({ tool: "os.fs.restore", status: "ok", summary: "", truncated: false, details: { path: "/w/data.csv" } });
    log.observe({ tool: "os.fs.write", status: "ok", summary: "", truncated: false, details: { path: "/w/big.json", existed: true } });
    const changes = log.list();
    expect(describeChanges(changes)).toBe(
      "changed: final.js (new, +3), gone.css (trashed), data.csv (restored), big.json (rewritten)",
    );
    expect(presentChangedPaths(changes)).toEqual(["final.js", "data.csv", "big.json"]);
  });

  it("names at most CHANGED_PATHS_SHOWN paths, then how many more", () => {
    const log = new FileChangeLog("/w");
    for (let i = 0; i < CHANGED_PATHS_SHOWN + 3; i += 1) {
      log.observe({ tool: "os.fs.write", status: "ok", summary: "", truncated: false, details: { path: `/w/f${i}.ts`, existed: false, addedLines: 1, removedLines: 0 } });
    }
    const line = describeChanges(log.list())!;
    expect(line).toContain(`f${CHANGED_PATHS_SHOWN - 1}.ts`);
    expect(line).not.toContain(`f${CHANGED_PATHS_SHOWN}.ts`);
    expect(line.endsWith(", +3 more")).toBe(true);
  });

  it("is absent when the file tools changed nothing", () => {
    const c = new WorkerRunCollector({ workingDir: "/w" });
    c.observe(executed("os.fs.read", { path: "/w/a.ts" }));
    const r = c.finish({ id: "t1", title: "T", reason: "reply", stepCount: 1, durationMs: 10 });
    expect(r.changes).toBeUndefined();
    expect(describeChanges(r.changes)).toBeNull();
  });

  it("marks the line when a shell command ran, since its writes are not seen", () => {
    const c = new WorkerRunCollector({ workingDir: "/w" });
    c.observe(executed("os.fs.edit", { path: "/w/a.ts", addedLines: 1, removedLines: 0 }));
    // A refused or blocked command ran nothing; a failing one did run.
    c.observe(executed("os.shell.run", { cmd: "rm", guardVerdict: "block" }, "error"));
    expect(c.finish({ id: "t1", title: "T", reason: "reply", stepCount: 2, durationMs: 10 }).shellRan).toBeUndefined();
    c.observe(executed("os.shell.run", { cmd: "sh", exitCode: 1 }, "error"));
    const r = c.finish({ id: "t1", title: "T", reason: "reply", stepCount: 3, durationMs: 10 });
    expect(r.shellRan).toBe(true);
    expect(describeChanges(r.changes, { shellRan: r.shellRan })).toBe(
      "changed (file tools only; shell commands ran): a.ts (+1/-0)",
    );
    expect(describeChanges(undefined, { shellRan: true })).toBe(
      "changed (file tools only; shell commands ran): nothing by the file tools",
    );
    // verify.run in its throwaway copy writes nothing back; in place it may.
    const v = new WorkerRunCollector({ workingDir: "/w" });
    v.observe(executed("verify.run", { isolated: true }));
    expect(v.finish({ id: "t1", title: "T", reason: "reply", stepCount: 1, durationMs: 10 }).shellRan).toBeUndefined();
    v.observe(executed("verify.run", { isolated: false }, "error"));
    expect(v.finish({ id: "t1", title: "T", reason: "reply", stepCount: 2, durationMs: 10 }).shellRan).toBe(true);
    const out = formatDelegateOutput([row({ shellRan: true, changes: [{ path: "a.ts", kind: "new", addedLines: 2, removedLines: 0 }] })], 20_000);
    expect(out).toContain("changed (file tools only; shell commands ran): a.ts (new, +2)");
  });

  it("merges a split parent's and children's changes, last writer wins", () => {
    const merged = mergeFileChanges([
      [{ path: "a.ts", kind: "new", addedLines: 1, removedLines: 0 }],
      [{ path: "a.ts", kind: "modified", addedLines: 2, removedLines: 1 }, { path: "b.ts", kind: "new" }],
    ]);
    expect(merged.map((c) => c.path)).toEqual(["a.ts", "b.ts"]);
    expect(merged[0]!.kind).toBe("modified");
  });
});

describe("the delegate result: runtime changed line and compact green replies", () => {
  const prose = `STATUS: done, the parser is in place\nCHANGED: a.ts\n${"long explanation ".repeat(200)}`;

  it("renders the runtime's changed line in the row's block", () => {
    const out = formatDelegateOutput(
      [row({ changes: [{ path: "a.ts", kind: "modified", addedLines: 40, removedLines: 3 }, { path: "b.ts", kind: "new", addedLines: 9, removedLines: 0 }] })],
      20_000,
    );
    expect(out).toContain("changed: a.ts (+40/-3), b.ts (new, +9)");
  });

  it("shows only the first line of a green row's reply when its task declared files", () => {
    const out = formatDelegateOutput([row({ reply: prose })], 20_000, {
      declaredFiles: new Set(["t1"]),
    });
    expect(out).toContain("reply: STATUS: done, the parser is in place …");
    expect(out).not.toContain("long explanation");
  });

  it("keeps a green row's assumptions and contract deviations, bounded", () => {
    const reply = [
      "STATUS: done, parser in place",
      "CHANGED: src/parse.ts",
      "CHECKS RUN: npm test → pass",
      "ASSUMPTIONS:",
      "- input is UTF-8",
      "- empty lines are skipped",
      "PROVIDED:",
      "function parseRows src/parse.ts",
      "function parseAll provided differently: named parseEverything",
      "could not provide function stream",
      "long explanation ".repeat(50),
    ].join("\n");
    const out = formatDelegateOutput([row({ reply })], 20_000, { declaredFiles: new Set(["t1"]) });
    expect(out).toContain(
      [
        "reply: STATUS: done, parser in place …",
        "ASSUMPTIONS:",
        "- input is UTF-8",
        "- empty lines are skipped",
        "function parseAll provided differently: named parseEverything",
        "could not provide function stream",
      ].join("\n"),
    );
    expect(out).not.toContain("parseRows");
    expect(out).not.toContain("long explanation");
    // "none" says nothing: only the status line is kept.
    const plain = formatDelegateOutput(
      [row({ reply: "STATUS: done\nCHANGED: a.ts\nASSUMPTIONS: none\n" })],
      20_000,
      { declaredFiles: new Set(["t1"]) },
    );
    expect(plain).toContain("reply: STATUS: done …");
    expect(plain).not.toContain("ASSUMPTIONS");
    // Bounded: a long assumptions section is cut.
    const long = formatDelegateOutput(
      [row({ reply: `STATUS: done\nASSUMPTIONS: ${"y".repeat(1000)}` })],
      20_000,
      { declaredFiles: new Set(["t1"]) },
    );
    const kept = long.slice(long.indexOf("reply: "));
    expect(kept.length).toBeLessThanOrEqual(GREEN_REPLY_KEPT_CHARS + "reply: ".length + 2);
  });

  it("clips a long first line to GREEN_REPLY_CHARS", () => {
    const out = formatDelegateOutput([row({ reply: "x".repeat(GREEN_REPLY_CHARS + 50) })], 20_000, {
      declaredFiles: new Set(["t1"]),
    });
    expect(out).toContain(`reply: ${"x".repeat(GREEN_REPLY_CHARS)} …`);
    expect(out).not.toContain("x".repeat(GREEN_REPLY_CHARS + 1));
  });

  it("keeps the whole reply for a row that is not green", () => {
    const out = formatDelegateOutput([row({ status: "max_steps", reply: prose })], 20_000, {
      declaredFiles: new Set(["t1"]),
    });
    expect(out).toContain("long explanation");
  });

  it("keeps the whole reply for a green task that declared no files", () => {
    const out = formatDelegateOutput([row({ reply: prose })], 20_000, {
      declaredFiles: new Set(["other"]),
    });
    expect(out).toContain("long explanation");
  });
});
