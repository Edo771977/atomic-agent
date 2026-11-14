import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createBranchSet, planBranchSetCopy } from "./branch-workspace.js";
import { createCandidateIntegration } from "./candidate-integration.js";
import { makeGitRepo, runGitRaw } from "../os/git/test-helpers.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { materializePrivateGitWorkspace, preparePrivateGitSnapshot } from "./private-git-workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(incompressible = false) {
  const project = await makeGitRepo("atag-private-git-project-"); roots.push(project);
  const copies = await mkdtemp(join(tmpdir(), "atag-private-git-copies-")); roots.push(copies);
  // A large tracked payload must remain a Git materialization, not two
  // charged copies that refuse an otherwise sufficient 1 MiB allowance.
  await writeFile(join(project, "large.bin"), incompressible ? randomBytes(700 * 1024) : Buffer.alloc(700 * 1024, 0x61));
  await writeFile(join(project, "edit.txt"), "committed\n");
  await writeFile(join(project, "remove.txt"), "remove\n");
  await runGitRaw(project, ["add", "."]); await runGitRaw(project, ["commit", "-qm", "baseline"]);
  return { project: await realpath(project), copies: await realpath(copies) };
}
async function common(dir: string) {
  const result = await runGitRaw(dir, ["rev-parse", "--git-common-dir"]);
  return realpath(resolve(dir, result.stdout.trim()));
}
async function metadata(project: string) {
  const dir = await common(project);
  const indexPath = resolve(project, (await runGitRaw(project, ["rev-parse", "--git-path", "index"])).stdout.trim());
  const shared = new Map<string, Buffer>();
  for (const file of await readdir(resolve(indexPath, ".."))) if (file.startsWith("sharedindex.")) shared.set(file, await readFile(resolve(indexPath, "..", file)));
  return { dir, index: await readFile(indexPath), shared, config: await readFile(join(dir, "config")), refs: (await runGitRaw(project, ["show-ref", "--head"])).stdout,
    registrations: (await runGitRaw(project, ["worktree", "list", "--porcelain"])).stdout };
}

it("keeps independent Git metadata for every workspace and preserves dirty/index/untracked bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.project, "edit.txt"), "staged\n"); await runGitRaw(f.project, ["add", "edit.txt"]);
  await writeFile(join(f.project, "edit.txt"), "dirty\r\n");
  await runGitRaw(f.project, ["rm", "remove.txt"]);
  await writeFile(join(f.project, "added.txt"), "newly staged\n"); await runGitRaw(f.project, ["add", "added.txt"]);
  const binary = Buffer.from([0, 255, 10, 13, 0]); await writeFile(join(f.project, "untracked.bin"), binary);
  await utimes(join(f.project, "edit.txt"), new Date("2020-01-01"), new Date("2020-01-01"));
  const before = await metadata(f.project);
  const set = await createBranchSet(f.project, ["one", "two"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    expect(set?.method).toBe("worktree");
    const one = set!.workspaces.get("one")!.dir, two = set!.workspaces.get("two")!.dir;
    const dirs = await Promise.all([common(f.project), common(set!.baseDir), common(one), common(two)]);
    expect(new Set(dirs).size).toBe(4);
    expect((await lstat(join(one, ".git"))).isDirectory()).toBe(true);
    await runGitRaw(one, ["config", "--local", "audit.private", "one"]);
    await runGitRaw(one, ["tag", "worker-only"]);
    expect((await runGitRaw(two, ["config", "--local", "--list"])).stdout).not.toContain("audit.private");
    expect((await runGitRaw(two, ["tag", "--list", "worker-only"])).stdout).toBe("");
    expect(await readFile(join(one, "edit.txt"), "utf8")).toBe("dirty\r\n");
    expect(await readFile(join(one, "added.txt"), "utf8")).toBe("newly staged\n");
    await expect(lstat(join(one, "remove.txt"))).rejects.toThrow();
    expect(await readFile(join(one, "untracked.bin"))).toEqual(binary);
    await expect(lstat(join(await common(one), "objects", "info", "alternates"))).rejects.toThrow();
    expect((await runGitRaw(one, ["remote"])).stdout).toBe("");
  } finally { await set?.cleanup(); }
  expect(await metadata(f.project)).toEqual(before);
  expect(await readFile(join(f.project, "edit.txt"), "utf8")).toBe("dirty\r\n");
  expect(await readFile(join(f.project, "untracked.bin"))).toEqual(binary);
  expect(await readdir(f.copies)).toEqual([]);
});

it("keeps nested tasks and the final planned source independent from the candidate and each other", async () => {
  const f = await fixture();
  const outer = await createBranchSet(f.project, ["candidate"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  const candidate = outer!.workspaces.get("candidate")!.dir;
  const before = await metadata(candidate);
  const nested = await createBranchSet(candidate, ["a", "b"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  const plan = await planBranchSetCopy(candidate, ["checked"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  const checked = await plan!.create({ tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    const dirs = await Promise.all([common(candidate), ...[...nested!.workspaces.values(), ...checked!.workspaces.values()].map(workspace => common(workspace.dir))]);
    expect(new Set(dirs).size).toBe(dirs.length);
    const task = nested!.workspaces.get("a")!.dir;
    await runGitRaw(task, ["config", "--local", "audit.nested", "changed"]);
    await runGitRaw(task, ["tag", "nested-only"]);
    expect(await metadata(candidate)).toEqual(before);
    expect((await runGitRaw(checked!.workspaces.get("checked")!.dir, ["tag", "--list", "nested-only"])).stdout).toBe("");
  } finally { await checked?.cleanup(); await nested?.cleanup(); await outer?.cleanup(); }
  expect(await readdir(f.copies)).toEqual([]);
});

it("preserves dirty tracked sibling-package bytes outside the selected monorepo subdirectory", async () => {
  const f = await fixture();
  await mkdir(join(f.project, "packages", "app"), { recursive: true });
  await mkdir(join(f.project, "packages", "lib"));
  await writeFile(join(f.project, "packages", "app", "app.txt"), "app\n");
  await writeFile(join(f.project, "packages", "lib", "lib.txt"), "committed library\n");
  await runGitRaw(f.project, ["add", "packages"]); await runGitRaw(f.project, ["commit", "-qm", "packages"]);
  await writeFile(join(f.project, "packages", "lib", "lib.txt"), "staged library\n");
  await runGitRaw(f.project, ["add", "packages/lib/lib.txt"]);
  await writeFile(join(f.project, "packages", "lib", "lib.txt"), "dirty library\r\n");
  const before = await metadata(f.project);
  const set = await createBranchSet(join(f.project, "packages", "app"), ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    expect(set?.method).toBe("worktree");
    const dir = set!.workspaces.get("one")!.dir;
    expect(await readFile(join(dir, "..", "lib", "lib.txt"), "utf8")).toBe("dirty library\r\n");
    expect(await common(dir)).not.toBe(before.dir);
  } finally { await set?.cleanup(); }
  expect(await metadata(f.project)).toEqual(before);
});

it("never imports source remotes, includes, or mutable config into private workspace metadata", async () => {
  const f = await fixture();
  const include = join(f.copies, "included-config"); await writeFile(include, "[audit]\n  imported = forbidden\n");
  await runGitRaw(f.project, ["config", "include.path", include]);
  await runGitRaw(f.project, ["remote", "add", "origin", f.project]);
  await runGitRaw(f.project, ["config", "audit.original", "forbidden"]);
  const before = await metadata(f.project);
  const set = await createBranchSet(f.project, ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    const dir = set!.workspaces.get("one")!.dir;
    const config = (await runGitRaw(dir, ["config", "--local", "--list"])).stdout;
    expect(config).not.toMatch(/include\.path|audit\.original|remote\.origin/);
    expect((await runGitRaw(dir, ["config", "--list"])).stdout).not.toContain("audit.imported=forbidden");
    expect((await runGitRaw(dir, ["remote"])).stdout).toBe("");
  } finally { await set?.cleanup(); }
  expect(await metadata(f.project)).toEqual(before);
});

it("bounds Git object imports separately from the payload copy allowance and fails closed", async () => {
  const f = await fixture(); const before = await metadata(f.project);
  const options = { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024, maxGitObjectBytes: 64 };
  await expect(createBranchSet(f.project, ["one"], options)).rejects.toThrow(/Git object import.*limit/i);
  expect(await metadata(f.project)).toEqual(before);
  expect(await readdir(f.copies)).toEqual([]);
});

it("stops an actual pack stream at the byte ceiling and cleans both importing stores", async () => {
  const f = await fixture(true), before = await metadata(f.project);
  // Raw reachable bytes fit; raw + the incompressible transfer does not.
  await expect(createBranchSet(f.project, ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024, maxGitObjectBytes: 1024 * 1024 })).rejects.toThrow(/Git object import.*limit/);
  expect(await metadata(f.project)).toEqual(before); expect(await readdir(f.copies)).toEqual([]);
});

it("preserves available source branch/tag refs and commit history as private data", async () => {
  const f = await fixture();
  await writeFile(join(f.project, "edit.txt"), "second commit\n");
  await runGitRaw(f.project, ["add", "edit.txt"]); await runGitRaw(f.project, ["commit", "-qm", "second"]);
  await runGitRaw(f.project, ["branch", "operator-branch"]); await runGitRaw(f.project, ["tag", "operator-tag"]);
  await runGitRaw(f.project, ["update-ref", "refs/remotes/upstream/main", "HEAD~1"]);
  await runGitRaw(f.project, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main"]);
  const set = await createBranchSet(f.project, ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    const dir = set!.workspaces.get("one")!.dir;
    expect((await runGitRaw(dir, ["for-each-ref", "--format=%(refname)"])).stdout).toContain("refs/heads/operator-branch");
    expect((await runGitRaw(dir, ["for-each-ref", "--format=%(refname)"])).stdout).toContain("refs/tags/operator-tag");
    expect(Number((await runGitRaw(dir, ["rev-list", "--count", "HEAD"])).stdout.trim())).toBeGreaterThanOrEqual(2);
    expect((await runGitRaw(dir, ["show", "operator-branch:edit.txt"])).stdout).toBe("second commit\n");
    expect((await runGitRaw(dir, ["show", "upstream/main:edit.txt"])).stdout).toBe("committed\n");
    expect((await runGitRaw(dir, ["symbolic-ref", "refs/remotes/upstream/HEAD"])).stdout.trim()).toBe("refs/remotes/upstream/main");
    expect(await readFile(join(dir, "edit.txt"), "utf8")).toBe("second commit\n");
  } finally { await set?.cleanup(); }
});

it("preserves the available history of a shallow source without following its original remote", async () => {
  const f = await fixture(); await writeFile(join(f.project, "edit.txt"), "second\n");
  await runGitRaw(f.project, ["add", "edit.txt"]); await runGitRaw(f.project, ["commit", "-qm", "second"]);
  const shallow = join(f.copies, "shallow-source");
  await runGitRaw(f.project, ["clone", "--quiet", "--no-local", "--depth=1", pathToFileURL(f.project).href, shallow]);
  const before = await metadata(shallow);
  const set = await createBranchSet(shallow, ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    const dir = set!.workspaces.get("one")!.dir;
    expect((await runGitRaw(dir, ["rev-list", "--count", "main"])).stdout.trim()).toBe("1");
    expect(Number((await runGitRaw(dir, ["rev-list", "--count", "HEAD"])).stdout.trim())).toBeLessThanOrEqual(2);
    expect(await readFile(join(dir, "edit.txt"))).toEqual(await readFile(join(shallow, "edit.txt")));
    expect((await runGitRaw(dir, ["rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe("true");
    expect((await runGitRaw(dir, ["remote"])).stdout).toBe("");
  } finally { await set?.cleanup(); }
  expect(await metadata(shallow)).toEqual(before);
});

it("preserves a linked source worktree's split index, shared indexes and common worktree registrations", async () => {
  const f = await fixture(); const linked = join(f.copies, "linked-source");
  await runGitRaw(f.project, ["worktree", "add", "--detach", linked, "HEAD"]);
  await writeFile(join(linked, "edit.txt"), "staged in linked\n"); await runGitRaw(linked, ["add", "edit.txt"]);
  await runGitRaw(linked, ["update-index", "--split-index"]); await writeFile(join(linked, "edit.txt"), "dirty linked\r\n");
  const before = await metadata(linked), original = await metadata(f.project);
  const set = await createBranchSet(linked, ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  try {
    expect(await readFile(join(set!.workspaces.get("one")!.dir, "edit.txt"), "utf8")).toBe("dirty linked\r\n");
    expect(await common(set!.workspaces.get("one")!.dir)).not.toBe(before.dir);
  } finally { await set?.cleanup(); }
  expect(await metadata(linked)).toEqual(before); expect(await metadata(f.project)).toEqual(original);
});

it("cancels a private import without writing source metadata or leaving incomplete stores", async () => {
  const f = await fixture(); const before = await metadata(f.project), controller = new AbortController();
  const signal = controller.signal;
  const pending = createBranchSet(f.project, ["one", "two"], { tmpRoot: f.copies, signal, maxCopyBytes: 1024 * 1024 });
  const timer = setTimeout(() => controller.abort(new Error("cancel private import")), 150);
  try { await expect(pending).rejects.toThrow(/cancel private import/); } finally { clearTimeout(timer); }
  expect(await metadata(f.project)).toEqual(before); expect(await readdir(f.copies)).toEqual([]);
});

it("keeps info/global ignore inputs as frozen private data for nested Git classification", async () => {
  const f = await fixture(), rules = join(f.copies, "global-rules");
  await writeFile(rules, "global.log\n"); await runGitRaw(f.project, ["config", "core.excludesFile", rules]);
  await writeFile(join(f.project, ".git", "info", "exclude"), "cache/\n");
  await mkdir(join(f.project, "cache")); await writeFile(join(f.project, "cache", "data"), "private cache");
  await writeFile(join(f.project, "global.log"), "private log"); const before = await metadata(f.project);
  const set = await createBranchSet(f.project, ["one"], { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024, privateDependencyDirectories: true });
  try {
    const dir = set!.workspaces.get("one")!.dir;
    expect((await runGitRaw(dir, ["check-ignore", "cache/data", "global.log"])).stdout.trim().split("\n")).toEqual(["cache/data", "global.log"]);
    await writeFile(rules, "changed-global\n"); await writeFile(join(f.project, ".git", "info", "exclude"), "changed-info\n");
    expect((await runGitRaw(dir, ["check-ignore", "cache/data", "global.log"])).stdout.trim().split("\n")).toEqual(["cache/data", "global.log"]);
  } finally { await set?.cleanup(); }
  expect((await metadata(f.project)).index).toEqual(before.index);
});

it("does not carry an expired preparation deadline into a later materialization", async () => {
  const f = await fixture(), deadlines: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const controller = new AbortController(); deadlines.push(controller); return controller.signal; });
  try {
    const snapshot = await preparePrivateGitSnapshot({ source: f.project, head: (await runGitRaw(f.project, ["rev-parse", "HEAD"])).stdout.trim(), seed: join(f.copies, "snapshot.git") });
    expect(deadlines.length).toBeGreaterThan(0);
    for (const controller of deadlines) controller.abort(new Error("old preparation deadline expired"));
    const later = join(f.copies, "later");
    await materializePrivateGitWorkspace(later, snapshot);
    expect((await runGitRaw(later, ["rev-parse", "HEAD"])).stdout.trim()).toBe(snapshot.commit);
  } finally { timeout.mockRestore(); }
});

it("executes candidate final checks with autonomous Git metadata while retaining efficient tracked materialization", async () => {
  const f = await fixture(); const before = await metadata(f.project);
  const candidate = await createCandidateIntegration(f.project, { tmpRoot: f.copies, maxCopyBytes: 1024 * 1024 });
  const rows: WorkerTaskResult[] = [{ id: "one", title: "one", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
  try {
    await writeFile(join(candidate.dir, "edit.txt"), "checked\n");
    const candidateBefore = await metadata(candidate.dir);
    const report = await candidate.finish({ rows, contract: { checks: [{ kind: "command", command: "integration" }] }, signal: new AbortController().signal,
      runChecks: async (_checks, context) => {
        expect(await common(context.workingDir)).not.toBe(await common(candidate.dir));
        await runGitRaw(context.workingDir, ["config", "--local", "audit.final", "changed"]);
        expect(await metadata(candidate.dir)).toEqual(candidateBefore);
        return { ok: true, results: [{ ok: true }] };
      } });
    expect(report.status, report.reason).toBe("promoted");
    expect(await readFile(join(f.project, "edit.txt"), "utf8")).toBe("checked\n");
  } finally { await candidate.cleanup(); }
  expect(await metadata(f.project)).toEqual(before);
});
import { randomBytes } from "node:crypto";
