import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIsolatedWave } from "./branch-merge.js";
import { createBranchSet, defaultGitExec } from "./branch-workspace.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("private branch dependencies", () => {
  it("keeps ignored dependencies readable without sharing a failed task's writes", async () => {
    const repo = await makeGitRepo("atag-private-ignored-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "cache/\nnode_modules/\n");
    await writeRepoFile(repo, "tracked.txt", "tracked\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "cache/state.txt", "original cache\n");
    await writeRepoFile(repo, "node_modules/dependency/index.js", "original dependency\n");
    const { root } = await fixture();
    let runs = 0;
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task("failed")], writeScope: [repo], inputs: [],
      options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        runs += 1;
        const dir = workspace!("failed")!.workingDir;
        expect(await readFile(join(dir, "cache/state.txt"), "utf8")).toBe("original cache\n");
        expect(await readFile(join(dir, "node_modules/dependency/index.js"), "utf8")).toBe("original dependency\n");
        await writeFile(join(dir, "cache/state.txt"), "bad cache\n");
        await writeFile(join(dir, "node_modules/dependency/index.js"), "bad dependency\n");
        expect(await readFile(join(repo, "cache/state.txt"), "utf8")).toBe("original cache\n");
        return [{ ...row("failed"), status: "failed" }];
      },
    });
    expect(runs).toBe(1);
    expect(result.results[0]!.status).toBe("failed");
    expect(await readFile(join(repo, "cache/state.txt"), "utf8")).toBe("original cache\n");
    expect(await readFile(join(repo, "node_modules/dependency/index.js"), "utf8")).toBe("original dependency\n");
  });

  it("copies excluded directories privately outside git and does not share git metadata", async () => {
    const { root, dir } = await fixture();
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "marker"), "original git metadata");
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "dependency.js"), "dependency\n");
    const set = await createBranchSet(dir, ["one", "two"], { tmpRoot: root, git: async () => null });
    expect(set).not.toBeNull();
    try {
      const one = set!.workspaces.get("one")!.dir;
      const two = set!.workspaces.get("two")!.dir;
      expect(await readFile(join(one, "node_modules/dependency.js"), "utf8")).toBe("dependency\n");
      await writeFile(join(one, "node_modules/dependency.js"), "changed\n");
      expect(await readFile(join(two, "node_modules/dependency.js"), "utf8")).toBe("dependency\n");
      expect(await readFile(join(dir, "node_modules/dependency.js"), "utf8")).toBe("dependency\n");
      expect(await readdir(one)).not.toContain(".git");
    } finally { await set?.cleanup(); }
  });

  it("counts ignored directory data against the copy limit before any worker starts", async () => {
    const repo = await makeGitRepo("atag-private-limit-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "node_modules/\n");
    await runGitRaw(repo, ["add", ".gitignore"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "node_modules/dependency.js", "large dependency".repeat(10));
    const { root } = await fixture();
    let runs = 0;
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task("one")], writeScope: [repo], inputs: [],
      options: { tmpRoot: root, maxCopyBytes: 10 },
      run: async () => { runs += 1; return [row("one")]; },
    });
    expect(runs).toBe(0);
    expect(result.results[0]!.error).toMatch(/not started: could not create a private workspace/);
    expect((await readdir(root)).filter((name) => name.startsWith("atag-fusion-"))).toEqual([]);
  });

  it("discards a green task's private cache changes while delivering ordinary outputs and ignored files", async () => {
    const repo = await makeGitRepo("atag-private-green-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "cache/\n*.local\n");
    await runGitRaw(repo, ["add", ".gitignore"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "cache/state.txt", "original cache\n");
    await writeRepoFile(repo, "settings.local", "original settings\n");
    const { root } = await fixture();
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task("one")], writeScope: [repo], inputs: [],
      options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        await writeFile(join(dir, "cache/state.txt"), "private cache\n");
        await writeFile(join(dir, "settings.local"), "new settings\n");
        await writeFile(join(dir, "output.txt"), "deliverable\n");
        return [row("one")];
      },
    });
    expect(result.results[0]!.status).toBe("ok");
    expect(result.outcomes[0]!.applied).toEqual(["output.txt", "settings.local"]);
    expect(await readFile(join(repo, "cache/state.txt"), "utf8")).toBe("original cache\n");
    expect(await readFile(join(repo, "settings.local"), "utf8")).toBe("new settings\n");
    expect(await readFile(join(repo, "output.txt"), "utf8")).toBe("deliverable\n");
  });

  it("refuses missing snapshot inputs instead of silently dispatching an incomplete workspace", async () => {
    const repo = await makeGitRepo("atag-private-missing-");
    cleanup.push(repo);
    await writeRepoFile(repo, "tracked.txt", "tracked\n");
    await runGitRaw(repo, ["add", "tracked.txt"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "input.txt", "untracked input\n");
    const { root } = await fixture();
    let removed = false;
    let runs = 0;
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task("one")], writeScope: [repo], inputs: [],
      options: {
        tmpRoot: root,
        git: async (args, cwd) => {
          const result = await defaultGitExec(args, cwd);
          if (!removed && args.includes("worktree") && args.includes("add")) {
            removed = true;
            await rm(join(repo, "input.txt"));
          }
          return result;
        },
      },
      run: async () => { runs += 1; return [row("one")]; },
    });
    expect(removed).toBe(true);
    expect(runs).toBe(0);
    expect(result.results[0]!.error).toMatch(/^not started: could not create a private workspace/);
    expect((await runGitRaw(repo, ["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(1);
    expect((await readdir(root)).filter((name) => name.startsWith("atag-fusion-"))).toEqual([]);
  });
});

async function fixture(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "atag-isolation-safety-"));
  cleanup.push(root);
  const dir = join(root, "project");
  await mkdir(dir);
  await writeFile(join(dir, "input.txt"), "the user's original\n");
  return { root, dir };
}

const task = (id: string): DelegateTask => ({ id, title: id, instructions: "edit input.txt" });
const row = (id: string): WorkerTaskResult => ({
  id, title: id, status: "ok", reply: "done", stepCount: 1, durationMs: 1,
  tools: { calls: 1, errors: 0, writes: 1, byTool: {} },
});

describe("required branch isolation", () => {
  it.each(["oversize", "setup failure"] as const)("starts no worker after %s, leaving the original unchanged", async (failure) => {
    const { root, dir } = await fixture();
    let runs = 0;
    let gates = 0;
    const result = await runIsolatedWave({
      realDir: dir, tasks: [task("one")], writeScope: [dir], inputs: [],
      options: {
        git: async () => null,
        platform: "linux",
        tmpRoot: failure === "setup failure" ? join(root, "missing", "tmp") : root,
        maxCopyBytes: failure === "oversize" ? 1 : 100_000,
      },
      run: async (_tasks, workspace) => {
        runs += 1;
        await writeFile(join(workspace?.("one")?.workingDir ?? dir, "input.txt"), "damage\n");
        return [row("one")];
      },
      gate: async (r) => { gates += 1; return { row: r, merge: false }; },
    });
    expect(runs).toBe(0);
    expect(gates).toBe(0);
    expect(await readFile(join(dir, "input.txt"), "utf8")).toBe("the user's original\n");
    expect(result.results).toMatchObject([{ id: "one", status: "cancelled", stepCount: 0, tools: { calls: 0 } }]);
    expect(result.results[0]!.error).toMatch(/^not started: could not create a private workspace/);
    expect(result.inPlace).toBeUndefined();
    expect(result.outcomes).toEqual([]);
    expect((await readdir(root)).filter((name) => name.startsWith("atag-fusion-"))).toEqual([]);
  });

  it("does not dispatch a mixed retry wave when a fresh workspace cannot be created", async () => {
    const { root, dir } = await fixture();
    const set = await createBranchSet(dir, ["kept"], { tmpRoot: root, git: async () => null });
    expect(set).not.toBeNull();
    let runs = 0;
    try {
      const result = await runIsolatedWave({
        realDir: dir, tasks: [task("kept"), task("fresh")], writeScope: [dir], inputs: [],
        kept: new Map([["kept", { set: set!, workspace: set!.workspaces.get("kept")! }]]),
        options: { tmpRoot: join(root, "missing", "tmp") },
        run: async () => { runs += 1; return [row("kept"), row("fresh")]; },
      });
      expect(runs).toBe(0);
      expect(result.results.map((r) => [r.id, r.status, r.stepCount])).toEqual([
        ["kept", "cancelled", 0], ["fresh", "cancelled", 0],
      ]);
      expect(await readFile(join(set!.workspaces.get("kept")!.dir, "input.txt"), "utf8")).toBe("the user's original\n");
    } finally {
      await set!.cleanup();
    }
  });
});
