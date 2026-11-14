import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBranchSet, defaultGitExec, planBranchSetCopy, type GitExec } from "./branch-workspace.js";
import { makeGitRepo, runGitRaw } from "../os/git/test-helpers.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(git = false) {
  const root = await mkdtemp(join(tmpdir(), "atag-copy-plan-")); roots.push(root);
  const project = git ? await makeGitRepo("atag-copy-plan-git-") : join(root, "project");
  if (git) roots.push(project); else await mkdir(project);
  const copies = join(root, "copies"); await mkdir(copies);
  await writeFile(join(project, "a.txt"), "baseline");
  if (git) { await runGitRaw(project, ["add", "."]); await runGitRaw(project, ["commit", "-qm", "baseline"]); }
  return { project, copies };
}

it.each([false, true])("measures exactly the complete unchanged future branch-set copy (Git=%s)", async git => {
  const f = await fixture(git);
  await mkdir(join(f.project, "node_modules")); await writeFile(join(f.project, "node_modules", "dep"), Buffer.alloc(100));
  await mkdir(join(f.project, "cache")); await writeFile(join(f.project, "cache", "data"), Buffer.alloc(80));
  await writeFile(join(f.project, "payload.bin"), Buffer.alloc(64));
  await writeFile(join(f.project, ".gitignore"), "cache/\nnode_modules/\n");
  const options = { maxCopyBytes: 100_000, tmpRoot: f.copies, privateDependencyDirectories: true, ...(!git ? { git: async () => null } : {}) };
  const plan = await planBranchSetCopy(f.project, ["checked"], options);
  expect(plan).not.toBeNull(); expect(await readdir(f.copies)).toEqual([]);
  const actual = await plan!.create(options);
  try { expect(plan!.bytes).toBe(options.maxCopyBytes - actual!.remainingCopyBytes!()); }
  finally { await actual?.cleanup(); }
});

it("preserves the Git method for an empty exit-one stash only after both tracked diffs prove clean", async () => {
  const f = await fixture(true); const probes: string[][] = [];
  const git: GitExec = async (args, cwd) => {
    if (args[0] === "stash") return { command: "git", args: [...args], exitCode: 1, stdout: "", stderr: "", signal: null, durationMs: 0, timedOut: false, truncated: false, inputTruncated: false };
    if (args[0] === "diff") probes.push([...args]);
    return defaultGitExec(args, cwd);
  };
  const set = await createBranchSet(f.project, ["a"], { tmpRoot: f.copies, git });
  try { expect(set?.method).toBe("worktree"); expect(probes).toEqual([["diff", "--quiet"], ["diff", "--cached", "--quiet"]]); }
  finally { await set?.cleanup(); }
});

it.each(["dirty", "error"])("does not accept a %s stash failure as a verified clean Git snapshot", async kind => {
  const f = await fixture(true);
  if (kind === "dirty") await writeFile(join(f.project, "a.txt"), "changed");
  const git: GitExec = async (args, cwd) => args[0] === "stash"
    ? { command: "git", args: [...args], exitCode: 1, stdout: "", stderr: kind === "error" ? "real stash error" : "", signal: null, durationMs: 0, timedOut: false, truncated: false, inputTruncated: false }
    : defaultGitExec(args, cwd);
  const set = await createBranchSet(f.project, ["a"], { tmpRoot: f.copies, git });
  try { expect(set?.method).toBe("copy"); }
  finally { await set?.cleanup(); }
});

it("refuses loss of Git after planning instead of falling back to an unreserved folder copy", async () => {
  const f = await fixture(true);
  const options = { maxCopyBytes: 100_000, tmpRoot: f.copies, privateDependencyDirectories: true };
  const plan = await planBranchSetCopy(f.project, ["checked"], options);
  await expect(plan!.create({ ...options, git: async () => null })).rejects.toThrow(/planned final Git workspace method or root changed/);
  expect(await readdir(f.copies)).toEqual([]);
});

it("cleans incomplete measurement workspaces when its caller cancels", async () => {
  const f = await fixture(); const abort = new AbortController();
  await expect(planBranchSetCopy(f.project, ["checked"], {
    tmpRoot: f.copies, signal: abort.signal, git: async () => { abort.abort(new Error("cancel measured copy")); return null; },
  })).rejects.toThrow("cancel measured copy");
  expect(await readdir(f.copies)).toEqual([]);
});
