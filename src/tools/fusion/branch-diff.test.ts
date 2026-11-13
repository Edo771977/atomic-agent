import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";
import { runCommand } from "../../sandbox/command-runner.js";
import { workspaceChanges, writeTaskPatch } from "./branch-diff.js";
import { createBranchSet, touchedPaths, type BranchSet } from "./branch-workspace.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const BIN = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13]);
const BIN2 = Buffer.from([9, 0, 8, 0, 7, 0, 200]);
const modes = process.platform !== "win32";

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function fixture(files: Record<string, string | Buffer>, git: boolean): Promise<string> {
  const dir = git ? await makeGitRepo("atag-diff-") : await tmp("atag-diff-plain-");
  if (git) cleanup.push(dir);
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === "string") await writeRepoFile(dir, path, content);
    else await writeFile(join(dir, path), content);
  }
  if (git) {
    await runGitRaw(dir, ["add", "-A"]);
    await runGitRaw(dir, ["commit", "-q", "-m", "init"]);
  }
  return dir;
}

/** Every entry under `root` (no `.git`): kind, exec bit, content or link target. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".atomic-agent") continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) out[rel] = `link:${await readlink(full)}`;
      else {
        const exec = modes && ((await lstat(full)).mode & 0o111) !== 0 ? "x" : "-";
        out[rel] = `${exec}:${(await readFile(full)).toString("base64")}`;
      }
    }
  };
  await walk(root);
  return out;
}

/** The task's edits: text, binary (new and changed), empty, removed, mode, symlink. */
async function edit(dir: string): Promise<void> {
  await writeFile(join(dir, "text.txt"), "one\nTWO\nthree\n");
  await writeFile(join(dir, "bin.dat"), BIN2);
  await writeFile(join(dir, "new.bin"), BIN);
  await writeFile(join(dir, "empty.txt"), "");
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, "sub", "added.txt"), "added\n");
  await unlink(join(dir, "gone.txt"));
  if (modes) {
    await chmod(join(dir, "run.sh"), 0o755);
    await symlink("text.txt", join(dir, "link"));
  }
}

const FILES = {
  "text.txt": "one\ntwo\nthree\n",
  "bin.dat": BIN,
  "gone.txt": "bye\n",
  "run.sh": "echo hi\n",
};

async function apply(patchFile: string, cwd: string): Promise<void> {
  const result = await runCommand("git", ["apply", "--whitespace=nowarn", patchFile], { cwd });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}

describe("the saved patch of a held-back task", () => {
  for (const git of [true, false]) {
    it(`reproduces the workspace with git apply (${git ? "git worktree" : "folder copy"})`, async () => {
      const repo = await fixture(FILES, git);
      const set = (await createBranchSet(repo, ["t"], { tmpRoot: await tmp("atag-diff-tmp-") })) as BranchSet;
      try {
        const ws = set.workspaces.get("t")!;
        await edit(ws.dir);
        const touched = await touchedPaths(ws);
        if (modes) expect(touched).toEqual(expect.arrayContaining(["run.sh", "link"]));
        const changes = await workspaceChanges(set, ws);
        const saved = await writeTaskPatch({ realDir: repo, set, workspace: ws, taskId: "t", changes });
        expect(saved.method).toBe("git");
        expect(saved.filesDir).toBeUndefined();
        const patchText = await readFile(join(repo, saved.path), "utf8");
        expect(patchText).toContain("GIT binary patch");
        expect(patchText).toContain("diff --git a/empty.txt b/empty.txt");
        // Apply onto a pristine copy of the base and compare with the workspace.
        await apply(join(repo, saved.path), set.baseDir);
        expect(await snapshot(set.baseDir)).toEqual(await snapshot(ws.dir));
      } finally {
        await set.cleanup();
      }
    });
  }

  it("without git, saves what a text patch cannot carry next to the patch and says so", async () => {
    const repo = await fixture(FILES, false);
    const set = (await createBranchSet(repo, ["t"], {
      tmpRoot: await tmp("atag-diff-tmp-"),
      git: async () => null,
    })) as BranchSet;
    try {
      const ws = set.workspaces.get("t")!;
      await edit(ws.dir);
      const changes = await workspaceChanges(set, ws);
      const saved = await writeTaskPatch({
        realDir: repo,
        set,
        workspace: ws,
        taskId: "t",
        changes,
        patchGit: async () => null,
      });
      expect(saved.method).toBe("text");
      expect(saved.filesDir).toBeDefined();
      const kept = join(repo, saved.filesDir!);
      expect(await readFile(join(kept, "bin.dat"))).toEqual(BIN2);
      expect(await readFile(join(kept, "new.bin"))).toEqual(BIN);
      expect(await readFile(join(kept, "empty.txt"), "utf8")).toBe("");
      if (modes) expect(await readlink(join(kept, "link"))).toBe("text.txt");
      expect(saved.saved).toBeGreaterThanOrEqual(3);
      // The text part still applies.
      await apply(join(repo, saved.path), set.baseDir);
      expect(await readFile(join(set.baseDir, "text.txt"), "utf8")).toBe("one\nTWO\nthree\n");
      expect(await readFile(join(set.baseDir, "sub", "added.txt"), "utf8")).toBe("added\n");
      await expect(readFile(join(set.baseDir, "gone.txt"))).rejects.toThrow();
    } finally {
      await set.cleanup();
    }
  });
});
