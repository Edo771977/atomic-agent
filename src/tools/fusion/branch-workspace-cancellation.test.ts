import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCommand, type CommandResult } from "../../sandbox/command-runner.js";
import { createCandidateIntegration } from "./candidate-integration.js";
import { createBranchSet, stampTree, touchedPaths } from "./branch-workspace.js";
import { gitBinaryPatch } from "./branch-diff.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atag-stamp-cancel-")); roots.push(root);
  const project = join(root, "project"), temp = join(root, "private");
  await mkdir(join(project, "source"), { recursive: true }); await mkdir(temp);
  await writeFile(join(project, "source", "file.txt"), "input bytes\n");
  return { root, project, temp };
}
function completed(exitCode = 0): CommandResult {
  return { command: "git", args: [], exitCode, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
}

it("cancels the real child ignore query pending during candidate setup and cleans incomplete workspaces", async () => {
  const f = await fixture(); const abort = new AbortController();
  let queryHadSignal = false, finishedNaturally = false, queryRan = false;
  await expect(createCandidateIntegration(f.project, {
    tmpRoot: f.temp, signal: abort.signal, git: async () => null,
    ignoreGit: async (args, options) => {
      if (!args.includes("check-ignore")) return completed(args.includes("rev-parse") || args.includes("config") ? 1 : 0);
      queryRan = true; queryHadSignal = options.signal !== undefined;
      const child = runCommand(process.execPath, ["-e", 'setTimeout(() => process.stdout.write("NATURAL_COMPLETION"), 2000)'], {
        cwd: options.cwd, ...(options.signal === undefined ? {} : { signal: options.signal }), timeoutMs: 5000,
      });
      const timer = setTimeout(() => abort.abort(new Error("caller cancelled setup query")), 50);
      try { const result = await child; finishedNaturally = result.stdout.includes("NATURAL_COMPLETION"); return result; }
      finally { clearTimeout(timer); }
    },
  })).rejects.toThrow(/caller cancelled setup query/);
  expect(queryRan).toBe(true); expect(queryHadSignal).toBe(true); expect(finishedNaturally).toBe(false);
  expect(await readdir(f.temp)).toEqual([]);
});

it("refuses an already-cancelled tree walk before invoking its ignore evaluator", async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort(new Error("walk cancelled")); let queries = 0;
  await expect(stampTree(f.project, new Set(), async () => { queries += 1; return new Set(); }, abort.signal)).rejects.toThrow("walk cancelled");
  expect(queries).toBe(0);
  // An ordinary uncapped caller retains the existing optional-signal behavior.
  expect((await stampTree(f.project)).has(join("source", "file.txt"))).toBe(true);
});

it("honors a recovery touched-path scan's independent cancellation signal", async () => {
  const f = await fixture(); const set = await createBranchSet(f.project, ["task"], { tmpRoot: f.temp, git: async () => null });
  try {
    const abort = new AbortController(); abort.abort(new Error("recovery scan deadline"));
    await expect(touchedPaths(set!.workspaces.get("task")!, abort.signal)).rejects.toThrow("recovery scan deadline");
  } finally { await set?.cleanup(); }
});

it("cancels a pending binary-patch child using the independent recovery signal", async () => {
  const f = await fixture(); const abort = new AbortController(); let natural = false, forwarded = false;
  await expect(gitBinaryPatch(f.project, f.project, [], async (args, options) => {
    if (!args.includes("init")) return completed(1);
    forwarded = options.signal === abort.signal;
    const child = runCommand(process.execPath, ["-e", 'setTimeout(() => process.stdout.write("NATURAL_COMPLETION"), 2000)'], {
      cwd: options.cwd, ...(options.signal === undefined ? {} : { signal: options.signal }), timeoutMs: 5000,
    });
    const timer = setTimeout(() => abort.abort(new Error("recovery patch deadline")), 50);
    try { const result = await child; natural = result.stdout.includes("NATURAL_COMPLETION"); return result; }
    finally { clearTimeout(timer); }
  }, f.temp, abort.signal)).rejects.toThrow("recovery patch deadline");
  expect(forwarded).toBe(true); expect(natural).toBe(false); expect(await readdir(f.temp)).toEqual([]);
});
