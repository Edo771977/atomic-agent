import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIsolatedWave } from "./branch-merge.js";
import { createBranchSet, defaultGitExec, removeWorkspaceTree, touchedPaths } from "./branch-workspace.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX, type FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("shared dependency directories", () => {
  it("isolates a repo whose ignored node_modules exceeds the copy budget across tasks", async () => {
    const repo = await makeGitRepo("atag-shared-deps-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "node_modules/\n");
    await writeRepoFile(repo, "tracked.txt", "tracked\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "node_modules/dep/index.js", "x".repeat(300_000));
    const { root } = await fixture();
    const set = await createBranchSet(repo, ["t1", "t2", "t3"], { tmpRoot: root, maxCopyBytes: 100_000 });
    expect(set).not.toBeNull();
    try {
      for (const id of ["t1", "t2", "t3"]) {
        const dir = set!.workspaces.get(id)!.dir;
        expect((await readFile(join(dir, "node_modules/dep/index.js"), "utf8")).length).toBe(300_000);
        expect(await realpath(join(dir, "node_modules"))).toBe(await realpath(join(repo, "node_modules")));
        expect([...set!.workspaces.get(id)!.manifest.keys()].some((p) => p.startsWith("node_modules"))).toBe(false);
      }
    } finally { await set?.cleanup(); }
    expect(await readFile(join(repo, "node_modules/dep/index.js"), "utf8")).toHaveLength(300_000);
  });

  it("links ignored folders inside a dependency directory that keeps a tracked placeholder", async () => {
    const repo = await makeGitRepo("atag-shared-gitkeep-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "node_modules/*\n!node_modules/.gitkeep\n");
    await writeRepoFile(repo, "node_modules/.gitkeep", "");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "node_modules/big/x.bin", "x".repeat(300_000));
    await writeRepoFile(repo, "node_modules/big/node_modules/inner/y.bin", "y".repeat(300_000));
    const { root } = await fixture();
    const set = await createBranchSet(repo, ["t1", "t2"], { tmpRoot: root, maxCopyBytes: 100_000 });
    expect(set).not.toBeNull();
    try {
      for (const id of ["t1", "t2"]) {
        const dir = set!.workspaces.get(id)!.dir;
        expect(await readFile(join(dir, "node_modules/.gitkeep"), "utf8")).toBe("");
        expect((await lstat(join(dir, "node_modules"))).isSymbolicLink()).toBe(false);
        expect(await realpath(join(dir, "node_modules/big"))).toBe(await realpath(join(repo, "node_modules/big")));
        expect(await touchedPaths(set!.workspaces.get(id)!)).toEqual([]);
      }
    } finally { await set?.cleanup(); }
  });

  it("does not copy node_modules, target or .venv wholesale in the folder-copy fallback", async () => {
    const { root, dir } = await fixture();
    for (const name of ["node_modules", "target", ".venv"]) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "big.bin"), Buffer.alloc(300_000));
    }
    const set = await createBranchSet(dir, ["t1", "t2", "t3"], { tmpRoot: root, git: async () => null, maxCopyBytes: 100_000 });
    expect(set).not.toBeNull();
    try {
      const one = set!.workspaces.get("t1")!.dir;
      for (const name of ["node_modules", "target", ".venv"]) {
        expect((await lstat(join(one, name))).isSymbolicLink()).toBe(true);
        expect(await realpath(join(one, name))).toBe(await realpath(join(dir, name)));
      }
      expect(await readFile(join(one, "input.txt"), "utf8")).toBe("the user's original\n");
    } finally { await set?.cleanup(); }
  });
});

describe("direct-mode copy budget", () => {
  it("links an ignored venv/ to the original instead of copying it into the base and every task", async () => {
    const repo = await makeGitRepo("atag-direct-venv-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "venv/\n");
    await writeRepoFile(repo, "src/a.ts", "x\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "venv/big.bin", "v".repeat(40_000));
    const { root } = await fixture();
    const set = await createBranchSet(repo, ["a", "b", "c"], { tmpRoot: root, maxCopyBytes: 100_000 });
    expect(set).not.toBeNull();
    try {
      for (const id of ["a", "b", "c"]) {
        const dir = set!.workspaces.get(id)!.dir;
        expect(await realpath(join(dir, "venv"))).toBe(await realpath(join(repo, "venv")));
        expect(await touchedPaths(set!.workspaces.get(id)!)).toEqual([]);
      }
    } finally { await set?.cleanup(); }
    expect(await readFile(join(repo, "venv/big.bin"), "utf8")).toHaveLength(40_000);
  });

  it("does not charge an unchanged tracked file to the copy budget", async () => {
    const repo = await makeGitRepo("atag-direct-tracked-");
    cleanup.push(repo);
    await writeRepoFile(repo, "data.bin", "d".repeat(30_000));
    await writeRepoFile(repo, "dirty.txt", "committed\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "dirty.txt", "uncommitted edit\n");
    const { root } = await fixture();
    const set = await createBranchSet(repo, ["a", "b", "c"], { tmpRoot: root, maxCopyBytes: 100_000 });
    expect(set).not.toBeNull();
    try {
      for (const id of ["a", "b", "c"]) {
        const dir = set!.workspaces.get(id)!.dir;
        expect(await readFile(join(dir, "data.bin"), "utf8")).toBe("d".repeat(30_000));
        expect(await readFile(join(dir, "dirty.txt"), "utf8")).toBe("uncommitted edit\n");
        expect(await touchedPaths(set!.workspaces.get(id)!)).toEqual([]);
      }
    } finally { await set?.cleanup(); }
  });
});

describe("work the ignore rules keep out of a direct merge", () => {
  async function generatedWave(files?: string[], provides?: { task: string; kind: "file"; name: string }[]) {
    const repo = await makeGitRepo("atag-direct-generated-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "src/generated/\n");
    await writeRepoFile(repo, "src/a.ts", "x\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    const { root } = await fixture();
    const result = await runIsolatedWave({
      realDir: repo, tasks: [{ ...task("one"), ...(files === undefined ? {} : { files }) }], writeScope: [repo], inputs: [],
      ...(provides === undefined ? {} : { provides }),
      options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        await writeRepoFile(dir, "src/generated/api.ts", "export const api = 1;\n");
        await writeFile(join(dir, "src/a.ts"), "y\n");
        return [row("one")];
      },
    });
    return { repo, result };
  }

  it("reports a file created in a new ignored directory instead of dropping it silently", async () => {
    const { repo, result } = await generatedWave();
    expect(result.outcomes[0]!.applied).toEqual([join("src", "a.ts")]);
    expect(result.outcomes[0]!.ignoredChanges).toEqual([join("src", "generated", "api.ts")]);
    expect(result.results[0]!.status).toBe("ok");
    expect(result.results[0]!.notes?.join("\n")).toContain("src/generated/api.ts");
    expect(await readdir(join(repo, "src"))).not.toContain("generated");
  });

  it.each([
    ["declared files", ["src/generated/api.ts"], undefined],
    ["a file provide", undefined, [{ task: "one", kind: "file" as const, name: "src/generated/api.ts" }]],
  ])("needs the orchestrator when %s lie under an ignored path", async (_label, files, provides) => {
    const { result } = await generatedWave(files, provides);
    expect(result.results[0]!.status).toBe("needs_orchestrator");
    expect(result.results[0]!.error).toContain("src/generated/api.ts");
  });
});

describe("workspace removal never lets git walk a generated link", () => {
  async function linkedRepo(): Promise<string> {
    const repo = await makeGitRepo("atag-cleanup-links-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "node_modules/\nvenv/\n");
    await writeRepoFile(repo, "tracked.txt", "tracked\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "node_modules/dep/index.js", "dependency\n");
    await writeRepoFile(repo, "venv/lib.py", "venv\n");
    return repo;
  }
  /** Git, recording each `worktree remove` whose target still existed. */
  function recordingGit(removedWhileThere: string[]) {
    return async (args: readonly string[], cwd: string) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        const target = args[args.length - 1]!;
        if (await lstat(target).then(() => true, () => false)) removedWhileThere.push(target);
      }
      return defaultGitExec(args, cwd);
    };
  }

  it("removes the workspace folders with Node before git forgets the worktrees", async () => {
    const repo = await linkedRepo();
    const { root } = await fixture();
    const removedWhileThere: string[] = [];
    const set = await createBranchSet(repo, ["a", "b"], { tmpRoot: root, git: recordingGit(removedWhileThere) });
    expect(set).not.toBeNull();
    const kept = set!.workspaces.get("a")!.dir;
    await set!.cleanup(["a"]);
    expect(await lstat(set!.workspaces.get("b")!.dir).then(() => true, () => false)).toBe(false);
    expect(await readFile(join(kept, "node_modules/dep/index.js"), "utf8")).toBe("dependency\n");
    await set!.cleanup();
    expect(removedWhileThere).toEqual([]);
    expect(await readFile(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("dependency\n");
    expect(await readFile(join(repo, "venv/lib.py"), "utf8")).toBe("venv\n");
    expect((await runGitRaw(repo, ["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  it("sweeps a dead run's worktrees the same way", async () => {
    const repo = await linkedRepo();
    const { root } = await fixture();
    const dead = await createBranchSet(repo, ["a"], { tmpRoot: root });
    expect(dead).not.toBeNull();
    // A run whose process is gone: its owner record names no live pid.
    const runRoot = join(dead!.baseDir, "..");
    await writeFile(join(runRoot, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const removedWhileThere: string[] = [];
    const next = await createBranchSet(repo, ["b"], { tmpRoot: root, git: recordingGit(removedWhileThere) });
    try {
      expect(await lstat(runRoot).then(() => true, () => false)).toBe(false);
      expect(removedWhileThere).toEqual([]);
      expect(await readFile(join(repo, "node_modules/dep/index.js"), "utf8")).toBe("dependency\n");
      expect((await runGitRaw(repo, ["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(3);
    } finally { await next?.cleanup(); }
    expect((await runGitRaw(repo, ["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(1);
  });
});

describe("tracked paths under excluded directory names", () => {
  it("merges a tracked change under a directory named build and never merges ignored dist, which is linked", async () => {
    const repo = await makeGitRepo("atag-tracked-build-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "dist/\n");
    await writeRepoFile(repo, "scripts/build/pack.sh", "echo old\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "dist/out.js", "old build\n");
    const { root } = await fixture();
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task("one")], writeScope: [repo], inputs: [],
      options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        await writeFile(join(dir, "scripts/build/pack.sh"), "echo new\n");
        await writeFile(join(dir, "scripts/build/extra.sh"), "echo extra\n");
        await writeFile(join(dir, "dist/out.js"), "private build\n");
        return [row("one")];
      },
    });
    expect(result.outcomes[0]!.applied).toEqual(["scripts/build/extra.sh", "scripts/build/pack.sh"]);
    expect(await readFile(join(repo, "scripts/build/pack.sh"), "utf8")).toBe("echo new\n");
    // Direct mode is not a sandbox: the ignored build output is the original's, through a link.
    expect(await readFile(join(repo, "dist/out.js"), "utf8")).toBe("private build\n");
  });

  it("reports a tracked change under a directory named build as touched for the recovery patch", async () => {
    const repo = await makeGitRepo("atag-tracked-build-touched-");
    cleanup.push(repo);
    await writeRepoFile(repo, "scripts/build/pack.sh", "echo old\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    const { root } = await fixture();
    const set = await createBranchSet(repo, ["one"], { tmpRoot: root });
    try {
      const ws = set!.workspaces.get("one")!;
      await writeFile(join(ws.dir, "scripts/build/pack.sh"), "echo changed and longer\n");
      expect(await touchedPaths(ws)).toEqual([join("scripts", "build", "pack.sh")]);
    } finally { await set?.cleanup(); }
  });
});

describe("private branch dependencies", () => {
  it("shares ignored caches and dependencies with the original by links in direct mode", async () => {
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
        // Shared with the original by a link, never copied or merged.
        expect(await realpath(join(dir, "node_modules"))).toBe(await realpath(join(repo, "node_modules")));
        expect(await realpath(join(dir, "cache"))).toBe(await realpath(join(repo, "cache")));
        return [{ ...row("failed"), status: "failed" }];
      },
    });
    expect(runs).toBe(1);
    expect(result.results[0]!.status).toBe("failed");
    // A write through the link is not undone with the workspace (as on `verify.run`).
    expect(await readFile(join(repo, "cache/state.txt"), "utf8")).toBe("bad cache\n");
    expect(await readFile(join(repo, "node_modules/dependency/index.js"), "utf8")).toBe("original dependency\n");
  });

  it("copies non-dependency excluded directories privately outside git and does not share git metadata", async () => {
    const { root, dir } = await fixture();
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "marker"), "original git metadata");
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "dependency.js"), "dependency\n");
    const set = await createBranchSet(dir, ["one", "two"], { tmpRoot: root, git: async () => null });
    expect(set).not.toBeNull();
    try {
      const one = set!.workspaces.get("one")!.dir;
      const two = set!.workspaces.get("two")!.dir;
      expect(await readFile(join(one, "dist/dependency.js"), "utf8")).toBe("dependency\n");
      await writeFile(join(one, "dist/dependency.js"), "changed\n");
      expect(await readFile(join(two, "dist/dependency.js"), "utf8")).toBe("dependency\n");
      expect(await readFile(join(dir, "dist/dependency.js"), "utf8")).toBe("dependency\n");
      expect(await readdir(one)).not.toContain(".git");
    } finally { await set?.cleanup(); }
  });

  it("does not charge a linked ignored directory to the copy limit", async () => {
    const repo = await makeGitRepo("atag-private-limit-");
    cleanup.push(repo);
    await writeRepoFile(repo, ".gitignore", "cache/\n");
    await runGitRaw(repo, ["add", ".gitignore"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "cache/state.bin", "large cache".repeat(10_000));
    const { root } = await fixture();
    let runs = 0;
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task("one"), task("two")], writeScope: [repo], inputs: [],
      options: { tmpRoot: root, maxCopyBytes: 10_000 },
      run: async () => { runs += 1; return [row("one"), row("two")]; },
    });
    expect(runs).toBe(1);
    expect(result.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect((await readdir(root)).filter((name) => name.startsWith("atag-fusion-"))).toEqual([]);
  });

  it("delivers a green task's outputs and ignored files, its cache writes landing through the link", async () => {
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
    expect(await readFile(join(repo, "cache/state.txt"), "utf8")).toBe("private cache\n");
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

describe("declared-file status in a fresh private workspace", () => {
  async function runIdle(method: "copy" | "worktree", act?: (dir: string) => Promise<void>): Promise<WorkerTaskResult> {
    const repo = await makeGitRepo("atag-fresh-stamp-");
    cleanup.push(repo);
    await writeRepoFile(repo, "core.js", "export const core = 1;\n");
    // An original written long ago: only the copy into the workspace is fresh.
    const past = new Date(Date.now() - 3_600_000);
    await utimes(join(repo, "core.js"), past, past);
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    const { root } = await fixture();
    const set = await createBranchSet(repo, ["core"], { tmpRoot: root, ...(method === "copy" ? { git: async () => null } : {}) });
    expect(set?.method).toBe(method);
    try {
      const ws = set!.workspaces.get("core")!.dir;
      const deps: WorkerRunnerDeps = {
        runTurn: async (session) => {
          await act?.(ws);
          return { session, reason: "reply", stepCount: 1 } as RunTurnResult;
        },
        createEphemeralSession: (meta: FusionWorkerMeta, workingDir?: string) =>
          createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${meta.taskId}`, workingDir: workingDir ?? repo, metadata: { fusionWorker: { ...meta } } }),
        approvals: { setSessionPolicy: () => undefined, clearSessionPolicy: () => undefined },
        emitEvent: () => undefined,
        workingDir: repo,
      };
      const [result] = await runWorkerTasks(deps, {
        parentSessionId: "s-parent", providerId: "local-llama", workerModel: "m", workerMaxSteps: 3, workerTimeoutMs: 60_000,
        tasks: [{ id: "core", title: "Core", instructions: "provide core", files: ["core.js"] }],
        maxWorkers: 1,
        signal: new AbortController().signal,
        taskWorkspace: () => ({ workingDir: ws, writeScope: [ws] }),
      });
      return result!;
    } finally { await set?.cleanup(); }
  }

  it.each(["copy", "worktree"] as const)("reports no_changes for an idle worker in a %s workspace made just before it ran", async (method) => {
    const result = await runIdle(method);
    expect(result.status).toBe("no_changes");
    expect(result.notes).toContain("core.js unchanged by this task");
  });

  it.each(["copy", "worktree"] as const)("still sees an immediate same-size shell edit in a %s workspace", async (method) => {
    const result = await runIdle(method, async (ws) => {
      const file = join(ws, "core.js");
      const before = await stat(file);
      await writeFile(file, "export const core = 2;\n");
      const after = await stat(file);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).not.toBe(before.mtimeMs);
    });
    expect(result.status).toBe("ok");
    expect(result.notes ?? []).not.toContain("core.js unchanged by this task");
  });
});

describe("removing a workspace tree with read-only directories", () => {
  it("unlocks directories (never through links) and retries once when removal is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "atag-rm-"));
    const outside = await mkdtemp(join(tmpdir(), "atag-rm-outside-"));
    try {
      const tree = join(root, "ws");
      await mkdir(join(tree, "locked", "inner"), { recursive: true });
      await writeFile(join(tree, "locked", "inner", "f.txt"), "x");
      await symlink(outside, join(tree, "locked", "link"), "dir");
      await chmod(join(tree, "locked", "inner"), 0o500);
      await chmod(join(tree, "locked"), 0o500);
      await chmod(outside, 0o500);
      // Root ignores directory modes, so the refusal a non-root user gets
      // is simulated: refused while any directory in the tree lacks owner write.
      let calls = 0;
      const remove = async (target: string): Promise<void> => {
        calls++;
        for (const dir of [join(target, "locked"), join(target, "locked", "inner")]) {
          if (((await stat(dir)).mode & 0o200) === 0) throw Object.assign(new Error("EACCES: permission denied, rmdir"), { code: "EACCES" });
        }
        await rm(target, { recursive: true, force: true });
      };
      await removeWorkspaceTree(tree, remove);
      expect(calls).toBe(2);
      await expect(lstat(tree)).rejects.toThrow();
      expect((await stat(outside)).mode & 0o777).toBe(0o500);
    } finally {
      await chmod(outside, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rethrows a refusal other than a permission error", async () => {
    await expect(removeWorkspaceTree("/nowhere", async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); })).rejects.toThrow("EBUSY");
  });
});
