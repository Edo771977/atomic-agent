import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";
import { runIsolatedWave } from "./branch-merge.js";
import type { CreateBranchSetOptions } from "./branch-workspace.js";
import type { WorkerTaskResult } from "./worker-result.js";

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

const task = { id: "one", title: "one", instructions: "produce output.txt" };
const row = (): WorkerTaskResult => ({ ...task, status: "ok", reply: "done", stepCount: 1, durationMs: 1,
  tools: { calls: 1, errors: 0, writes: 1, byTool: {} } });

async function fixture(git: boolean): Promise<{ repo: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "atag-ignore-policy-"));
  const repo = git ? await makeGitRepo("atag-ignore-repo-") : join(root, "project");
  cleanup.push(root, ...(git ? [repo] : []));
  await mkdir(repo, { recursive: true });
  await writeRepoFile(repo, ".gitignore", "cache/\ncache space/\n*.local\n");
  if (git) { await runGitRaw(repo, ["add", ".gitignore"]); await runGitRaw(repo, ["commit", "-q", "-m", "init"]); }
  return { repo, root };
}

describe("frozen disposable-directory policy", () => {
  it.each(["worktree", "snapshot unavailable", "plain folder"] as const)("discards newly created ignored directories and existing caches in %s", async (method) => {
    const { repo, root } = await fixture(method !== "plain folder");
    await writeRepoFile(repo, "nested/.gitignore", "cache*/\n!cache-keep/\n");
    await writeRepoFile(repo, "nested/cache-old/state.txt", "original cache\n");
    const options: CreateBranchSetOptions = { tmpRoot: root,
      ...(method === "worktree" ? {} : { git: async () => null }) };
    const result = await runIsolatedWave({
      realDir: repo, tasks: [task], writeScope: [repo], inputs: [], options,
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        await writeRepoFile(dir, "cache/state.txt", "new scratch\n");
        await writeRepoFile(dir, "cache space/state.txt", "spaced scratch\n");
        await writeRepoFile(dir, "nested/cache-old/state.txt", "modified scratch\n");
        await writeRepoFile(dir, "nested/cache-new/state.txt", "nested scratch\n");
        await writeRepoFile(dir, "nested/cache-keep/output.txt", "deliverable\n");
        await writeRepoFile(dir, "settings.local", "standalone ignored file\n");
        return [row()];
      },
    });
    expect(result.results[0]!.status).toBe("ok");
    expect(await readFile(join(repo, "nested/cache-old/state.txt"), "utf8")).toBe("original cache\n");
    expect(await readdir(repo)).not.toContain("cache");
    expect(await readdir(repo)).not.toContain("cache space");
    expect(await readdir(join(repo, "nested"))).not.toContain("cache-new");
    expect(await readFile(join(repo, "nested/cache-keep/output.txt"), "utf8")).toBe("deliverable\n");
    expect(await readFile(join(repo, "settings.local"), "utf8")).toBe("standalone ignored file\n");
  });

  it("freezes project, info and global rules before dispatch, including for a repository subdirectory", async () => {
    const { repo, root } = await fixture(true);
    const globalIgnore = join(root, "global ignore");
    await writeFile(globalIgnore, "global-cache/\n");
    await runGitRaw(repo, ["config", "core.excludesFile", globalIgnore]);
    await writeFile(join(repo, ".git/info/exclude"), "info-cache/\n");
    const workingDir = join(repo, "packages/app");
    await mkdir(workingDir, { recursive: true });
    const result = await runIsolatedWave({
      realDir: workingDir, tasks: [task], writeScope: [workingDir], inputs: [], options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        await writeFile(join(repo, ".gitignore"), "");
        await writeFile(globalIgnore, "");
        await writeFile(join(repo, ".git/info/exclude"), "");
        for (const cache of ["cache", "global-cache", "info-cache"]) await writeRepoFile(dir, `${cache}/state.txt`, "private\n");
        await writeRepoFile(dir, "output.txt", "deliverable\n");
        return [row()];
      },
    });
    expect(result.results[0]!.status).toBe("ok");
    expect((await readdir(workingDir)).sort()).toEqual(["output.txt"]);
  });

  it("fails closed with ignore files and no Git evaluator, but keeps plain no-ignore copies usable", async () => {
    const { repo, root } = await fixture(false);
    let runs = 0;
    const options: CreateBranchSetOptions = { tmpRoot: root, git: async () => null, ignoreGit: async () => null };
    const run = async () => { runs += 1; return [row()]; };
    const blocked = await runIsolatedWave({ realDir: repo, tasks: [task], writeScope: [repo], inputs: [], options, run });
    expect(runs).toBe(0);
    expect(blocked.results[0]!.error).toMatch(/not started:.*Git.*ignore/i);
    await rm(join(repo, ".gitignore"));
    const allowed = await runIsolatedWave({ realDir: repo, tasks: [task], writeScope: [repo], inputs: [], options, run });
    expect(runs).toBe(1);
    expect(allowed.results[0]!.status).toBe("ok");
  });

  it("does not miss ancestor repository rules when Git is unavailable in a subdirectory", async () => {
    const { repo, root } = await fixture(true);
    const dir = join(repo, "packages/app");
    await mkdir(dir, { recursive: true });
    let runs = 0;
    const result = await runIsolatedWave({
      realDir: dir, tasks: [task], writeScope: [dir], inputs: [],
      options: { tmpRoot: root, git: async () => null, ignoreGit: async () => null },
      run: async () => { runs += 1; return [row()]; },
    });
    expect(runs).toBe(0);
    expect(result.results[0]!.error).toMatch(/not started:.*Git.*ignore/i);
  });
});
