import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnOwnerProbe } from "../../session/turn-owner.js";
import {
  FusionRunStore,
  toolHasSideEffects,
  type FusionRunCheckpoint,
} from "./run-checkpoint.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";
import { parseDelegateArgs } from "./delegate-args.js";

const TASKS = [
  { id: "t1", title: "One" },
  { id: "t2", title: "Two" },
];

/** A process that is not this one and is gone. */
function deadProbe(pid = 4_000_001): TurnOwnerProbe {
  return {
    pid,
    host: "test-host",
    hostUptime: () => 1_000,
    isAlive: () => false,
    processStartOf: () => null,
  };
}

/** Another process that is still running. */
function aliveProbe(pid: number): TurnOwnerProbe {
  return { ...deadProbe(pid), isAlive: () => true };
}

function row(
  id: string,
  over: Partial<WorkerTaskResult> = {},
): WorkerTaskResult {
  return {
    ...new WorkerRunCollector().finish({
      id,
      title: id,
      reason: "reply",
      stepCount: 2,
      durationMs: 10,
    }),
    reply: `reply of ${id}`,
    ...over,
  };
}

describe("fusion run checkpoints (ATO-617)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-runs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (store: FusionRunStore) =>
    store.start({
      sessionId: "s-1",
      workingDir: "/repo",
      originalRequest: "build it",
      args: { tasks: TASKS.map((t) => ({ ...t, instructions: "x" })) },
      tasks: TASKS,
      waveCount: 2,
    });

  it("writes the run as soon as it starts", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    const saved = store.load(run.runId)!;
    expect(saved.sessionId).toBe("s-1");
    expect(saved.originalRequest).toBe("build it");
    expect(saved.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(saved.tasks.every((t) => t.result === undefined)).toBe(true);
    expect(saved.state).toBe("running");
  });

  it("writes a finished task and its spend at once", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"), 0.25);
    const saved = store.load(run.runId)!;
    expect(saved.tasks[0]!.result?.status).toBe("ok");
    expect(saved.tasks[0]!.result?.reply).toBe("reply of t1");
    expect(saved.tasks[1]!.result).toBeUndefined();
    expect(saved.spentUsd).toBeCloseTo(0.25);
  });

  it("keeps observed changes and shell coverage for artifact verification after a restart", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    const changes: NonNullable<WorkerTaskResult["changes"]> = [{ path: "bad.js", kind: "new", addedLines: 1, removedLines: 0 }];
    run.recordTask(row("t1", { changes, shellRan: true }));
    const saved = store.load(run.runId)!;
    expect(saved.tasks[0]!.result).toMatchObject({ changes, shellRan: true });
  });

  it("does not claim complete metadata for an unobserved move with writes=0", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1", { tools: { calls: 1, errors: 0, writes: 0, byTool: { "os.fs.move": 1 } } }));
    expect(store.load(run.runId)!.tasks[0]!.result?.artifactMetadata).toBe("incomplete");
  });

  it("rejects malformed nested checkpoint rows instead of trusting an invalid status", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"));
    const saved = run.snapshot();
    (saved.tasks[0]!.result as unknown as { status: string }).status = "invented-success";
    writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(saved));
    expect(store.load(run.runId)).toBeNull();
  });

  it("bounds checkpoint input before parsing", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    const saved = { ...run.snapshot(), oversized: "x".repeat(9 * 1024 * 1024) };
    writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(saved));
    expect(store.load(run.runId) === null).toBe(true);
  });

  it.each(["title", "id", "sessionId", "workingDir", "originalRequest"])("round-trips accepted %s beyond the previous reader-only bound", field => {
    const store = new FusionRunStore({ dir });
    const task = { id: field === "id" ? "i".repeat(1_025) : "one", title: field === "title" ? "t".repeat(8_193) : "One", instructions: "work" };
    const parsed = parseDelegateArgs({ tasks: [task] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    const run = store.start({ sessionId: field === "sessionId" ? "s".repeat(1_025) : "s-1", workingDir: field === "workingDir" ? "/" + "p".repeat(4_096) : "/repo", ...(field === "originalRequest" ? { originalRequest: "r".repeat(1_000_001) } : {}), args: { tasks: [task] }, tasks: parsed.tasks, waveCount: 1 });
    run.finish("interrupted");
    const saved = store.load(run.runId);
    expect(saved === null).toBe(false);
    expect(saved?.tasks[0]!.id).toBe(task.id);
    expect(saved?.args).toEqual({ tasks: [task] });
    expect(store.listResumable()).toHaveLength(1);
  });

  it("retains a legacy long title and id within the aggregate v1 file budget", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    const saved = run.snapshot();
    saved.tasks[0]!.id = "legacy-" + "i".repeat(1_025);
    saved.tasks[0]!.title = "t".repeat(8_193);
    writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(saved));
    expect(store.load(run.runId)?.tasks[0]).toEqual(saved.tasks[0]);
  });

  it("round-trips tool maps and side-effect names without reader-only per-field limits", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    const byTool = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`tool.${i}.${"x".repeat(1_025)}`, 1]));
    run.recordTask(row("t1", { tools: { calls: 257, errors: 0, writes: 0, byTool } }));
    const saved = store.load(run.runId);
    expect(saved?.tasks[0]!.result?.tools.byTool).toEqual(byTool);
    expect(saved?.tasks[0]!.sideEffects).toBe(true);
  });

  it.each([{ notes: Array.from({ length: 65 }, () => "note") }, { notes: ["n".repeat(4_001)] }])("keeps a run but marks coverage incomplete when bounded notes are clipped", ({ notes }) => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1", { notes }));
    expect(store.load(run.runId)?.tasks[0]!.result?.artifactMetadata).toBe("incomplete");
  });

  it.each([4_096, 4_097])("round-trips an observed path of %i characters without losing the run", length => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1", { changes: [{ path: "p".repeat(length), kind: "new" }] }));
    expect(store.load(run.runId)?.tasks[0]!.result?.artifactMetadata).toBe(length === 4_096 ? "complete" : "incomplete");
  });

  it("compacts aggregate verification metadata rather than writing an unreadable run", () => {
    const store = new FusionRunStore({ dir });
    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, instructions: "work" }));
    const run = store.start({ sessionId: "s-1", workingDir: "/repo", args: { tasks }, tasks, waveCount: 1 });
    const changes: NonNullable<WorkerTaskResult["changes"]> = Array.from({ length: 256 }, (_, i) => ({ path: String(i).padStart(4_096, "p"), kind: "new" }));
    for (const task of tasks) run.recordTask(row(task.id, { changes }));
    run.finish("interrupted");
    const saved = store.load(run.runId);
    expect(saved === null).toBe(false);
    expect(saved?.tasks.some(t => t.result?.artifactMetadata === "incomplete")).toBe(true);
  });

  it("reports irreducibly oversized replay arguments without emitting a bogus checkpoint", () => {
    const store = new FusionRunStore({ dir });
    const tasks = [{ id: "one", title: "x".repeat(8 * 1024 * 1024), instructions: "work" }];
    const run = store.start({ sessionId: "s-1", workingDir: "/repo", args: { tasks }, tasks, waveCount: 1 });
    run.finish("interrupted");
    expect(run.checkpointWarning).toContain("8 MiB");
    expect(existsSync(join(dir, `${run.runId}.json`))).toBe(false);
  });

  it("writes the wave count after a wave", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordWave(1);
    expect(store.load(run.runId)!.wavesDone).toBe(1);
  });

  it("deletes a run that completed", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"));
    run.recordTask(row("t2"));
    run.finish("complete");
    expect(store.load(run.runId)).toBeNull();
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("keeps a stopped run and offers it", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"));
    run.finish("interrupted");
    const offered = store.listResumable("s-1");
    expect(offered.map((r) => r.runId)).toEqual([run.runId]);
    expect(offered[0]!.state).toBe("interrupted");
  });

  it("never offers a run this process is still working on", () => {
    const store = new FusionRunStore({ dir });
    start(store);
    expect(store.listResumable("s-1")).toEqual([]);
  });

  it("offers a run whose process died, but not one whose process is alive", () => {
    const dead = start(new FusionRunStore({ dir, probe: deadProbe(4_000_001) }));
    const alive = start(new FusionRunStore({ dir, probe: aliveProbe(4_000_002) }));
    // A fresh process reads both files: pid 4_000_001 is gone, 4_000_002 is not.
    const reader = new FusionRunStore({
      dir,
      probe: {
        ...deadProbe(1),
        isAlive: (pid) => pid === 4_000_002,
      },
    });
    const offered = reader.listResumable().map((r) => r.runId);
    expect(offered).toContain(dead.runId);
    expect(offered).not.toContain(alive.runId);
  });

  it("narrows to one session", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.finish("interrupted");
    expect(store.listResumable("s-other")).toEqual([]);
  });

  it("drops runs past the retention", () => {
    let now = 1_000_000;
    const store = new FusionRunStore({ dir, now: () => now, retentionMs: 1_000 });
    const run = start(store);
    run.finish("interrupted");
    now += 5_000;
    expect(store.listResumable()).toEqual([]);
    expect(existsSync(join(dir, `${run.runId}.json`))).toBe(false);
  });

  it("discards a stopped run, and refuses one in flight", () => {
    const store = new FusionRunStore({ dir });
    const live = start(store);
    expect(store.discard(live.runId)).toBe(false);
    live.finish("interrupted");
    expect(store.discard(live.runId)).toBe(true);
    expect(store.load(live.runId)).toBeNull();
  });

  it("never reads a run id that could leave the directory", () => {
    const store = new FusionRunStore({ dir });
    expect(store.load("../../etc/passwd")).toBeNull();
    expect(FusionRunStore.isValidRunId("fr-abc_123")).toBe(true);
    expect(FusionRunStore.isValidRunId("a/b")).toBe(false);
  });

  it("skips a corrupt file instead of failing", () => {
    writeFileSync(join(dir, "fr-bad.json"), "{not json", "utf8");
    const store = new FusionRunStore({ dir });
    expect(store.listResumable()).toEqual([]);
  });

  it("records side effects as the call starts, before the task finishes", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.noteTool("t2", "os.fs.write");
    expect(store.load(run.runId)!.tasks[1]!.sideEffects).toBe(false);
    run.noteTool("t2", "os.shell.run");
    const saved = store.load(run.runId)!.tasks[1]!;
    expect(saved.sideEffects).toBe(true);
    expect(saved.sideEffectTools).toEqual(["os.shell.run"]);
  });

  it("counts a split's subtask on its root through the tree, not the id (ATO-1320)", () => {
    const store = new FusionRunStore({ dir });
    const run = store.start({
      sessionId: "s-1",
      workingDir: "/repo",
      args: { tasks: [{ id: "a/b", title: "Root", instructions: "x" }] },
      tasks: [{ id: "a/b", title: "Root" }],
      waveCount: 1,
    });
    const parents = new Map([
      ["a/b/c1", "a/b"],
      ["a/b/c1/d", "a/b/c1"],
    ]);
    run.useParents((id) => parents.get(id));
    run.noteTool("a/b/c1/d", "os.shell.run");
    run.recordTask(
      row("a/b/c1", {
        tools: { calls: 1, errors: 0, writes: 0, byTool: { "web.fetch": 1 } },
      }),
      0.4,
    );
    const saved = store.load(run.runId)!;
    expect(saved.spentUsd).toBeCloseTo(0.4);
    expect(saved.tasks[0]!.sideEffects).toBe(true);
    expect(saved.tasks[0]!.sideEffectTools).toContain("os.shell.run");
    // The root's own row is written when its split closes, not by a child.
    expect(saved.tasks[0]!.result).toBeUndefined();
  });

  it("reads side effects off a finished row's tool counts too", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(
      row("t1", {
        tools: { calls: 2, errors: 0, writes: 1, byTool: { "os.fs.write": 1, "mcp.github.create_issue": 1 } },
      }),
    );
    const saved = store.load(run.runId)!.tasks[0]!;
    expect(saved.sideEffects).toBe(true);
    expect(saved.sideEffectTools).toEqual(["mcp.github.create_issue"]);
  });

  it("continues a resumed run in the same file, finished tasks kept", () => {
    const store = new FusionRunStore({ dir });
    const first = start(store);
    first.recordTask(row("t1"), 1);
    first.finish("interrupted");
    const before = store.load(first.runId) as FusionRunCheckpoint;
    const again = store.start({
      runId: first.runId,
      sessionId: "s-1",
      workingDir: "/repo",
      args: before.args,
      tasks: TASKS,
      waveCount: 2,
      resumedFrom: before,
    });
    expect(again.runId).toBe(first.runId);
    const saved = store.load(first.runId)!;
    expect(saved.tasks[0]!.result?.status).toBe("ok");
    expect(saved.spentUsd).toBe(1);
    expect(saved.resumes).toBe(1);
    expect(saved.state).toBe("running");
  });
});

describe("toolHasSideEffects", () => {
  it("treats file tools and reads as safe to repeat", () => {
    for (const tool of ["os.fs.write", "os.fs.read", "os.web.search", "os.git.diff", "reply"]) {
      expect(toolHasSideEffects(tool)).toBe(false);
    }
  });
  it("treats commands, pushes, requests and MCP tools as side effects", () => {
    for (const tool of ["os.shell.run", "os.git.push", "os.http.request", "os.email.send", "mcp.linear.save_issue", "image.generate"]) {
      expect(toolHasSideEffects(tool)).toBe(true);
    }
  });
});
