import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runIsolatedWave } from "./branch-merge.js";
import { createBranchSet } from "./branch-workspace.js";
import { createCandidateIntegration } from "./candidate-integration.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";

// Simulated Windows link policy: `deny` names the error for one
// (target, type) pair; a "junction" here is a plain link on POSIX.
const links = vi.hoisted(() => ({
  deny: (_target: string, _type: string | undefined): string | undefined => undefined,
  calls: [] as { target: string; path: string; type: string | undefined }[],
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const symlink = (async (target: string, path: string, type?: string) => {
    const code = links.deny(String(target), type ?? undefined);
    if (code !== undefined) throw Object.assign(new Error(`simulated ${code} for a ${type ?? "default"} link`), { code });
    links.calls.push({ target: String(target), path: String(path), type: type ?? undefined });
    return actual.symlink(target, path, process.platform === "win32" ? type as never : undefined);
  }) as typeof actual.symlink;
  return { ...actual, symlink, default: { ...actual, symlink } };
});

const roots: string[] = [];
afterEach(async () => {
  links.deny = () => undefined; links.calls.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const DEP_BYTES = 1000;
async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atag-dep-links-"))); roots.push(root);
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "node_modules", "dep", "index.js"), "d".repeat(DEP_BYTES));
  await writeFile(join(root, "input.txt"), "original input\n");
  return root;
}
const inside = (path: string, root: string): boolean => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep)); };
const noDirSymlinks = (_target: string, type: string | undefined): string | undefined => type === "dir" ? "EPERM" : undefined;
const task = (id: string): DelegateTask => ({ id, title: id, instructions: "edit input.txt" });
const row = (id: string): WorkerTaskResult => ({ id, title: id, status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } });

it("shares dependency directories through a junction when directory symlinks are denied", async () => {
  links.deny = noDirSymlinks;
  const root = await project();
  // Less than one dependency copy: only links keep isolation available.
  const set = await createBranchSet(root, ["a", "b", "c"], { git: async () => null, maxCopyBytes: DEP_BYTES / 2 });
  expect(set).not.toBeNull();
  try {
    expect(links.calls.filter(call => call.type === "junction" && call.target === join(root, "node_modules"))).toHaveLength(4);
    for (const dir of [set!.baseDir, ...[...set!.workspaces.values()].map(ws => ws.dir)]) {
      expect((await lstat(join(dir, "node_modules"))).isSymbolicLink()).toBe(true);
      expect(await realpath(join(dir, "node_modules"))).toBe(join(root, "node_modules"));
    }
  } finally { await set?.cleanup(); }
});

it("copies dependencies once and links task directories to the base copy when the original cannot be linked", async () => {
  // Junctions cannot reach the original (e.g. a network share) but work locally.
  links.deny = (target, type) => type === "dir" || inside(target, roots[0]!) ? "EPERM" : undefined;
  const root = await project();
  const set = await createBranchSet(root, ["a", "b", "c"], { git: async () => null, maxCopyBytes: DEP_BYTES + 200 });
  expect(set).not.toBeNull();
  try {
    expect((await lstat(join(set!.baseDir, "node_modules"))).isSymbolicLink()).toBe(false);
    for (const ws of set!.workspaces.values()) {
      expect((await lstat(join(ws.dir, "node_modules"))).isSymbolicLink()).toBe(true);
      expect(await realpath(join(ws.dir, "node_modules"))).toBe(await realpath(join(set!.baseDir, "node_modules")));
    }
    await writeFile(join(set!.workspaces.get("a")!.dir, "node_modules", "dep", "index.js"), "rebuilt");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("d".repeat(DEP_BYTES));
  } finally { await set?.cleanup(); }
});

it("says dependency folders could not be linked when their copies exceed the limit", async () => {
  links.deny = () => "EPERM";
  const root = await project();
  const reasons: string[] = [];
  const set = await createBranchSet(root, ["a", "b", "c"], { git: async () => null, maxCopyBytes: 2 * DEP_BYTES, onRefusal: reason => reasons.push(reason) });
  expect(set).toBeNull();
  expect(reasons).toEqual([`dependency folders could not be linked on this system and copying them exceeds the copy limit (${2 * DEP_BYTES} bytes)`]);
  let runs = 0;
  const result = await runIsolatedWave({
    realDir: root, tasks: [task("a"), task("b"), task("c")], writeScope: [root], inputs: [],
    options: { git: async () => null, maxCopyBytes: 2 * DEP_BYTES },
    run: async () => { runs += 1; return [row("a")]; },
  });
  expect(runs).toBe(0);
  expect(result.results[0]!.error).toBe(`not started: could not create a private workspace: dependency folders could not be linked on this system and copying them exceeds the copy limit (${2 * DEP_BYTES} bytes)`);
});

it("keeps the plain size reason when no dependency folder had to be copied", async () => {
  const root = await project();
  const reasons: string[] = [];
  expect(await createBranchSet(root, ["a"], { git: async () => null, maxCopyBytes: 10, onRefusal: reason => reasons.push(reason) })).toBeNull();
  expect(reasons).toEqual(["the folder is too large to copy"]);
});

it("copies a candidate's dependency directory from the original only once when nothing can be linked", async () => {
  links.deny = () => "EPERM";
  const root = await project();
  // One dependency copy plus the project's own files, twice (base and candidate).
  const candidate = await createCandidateIntegration(root, { git: async () => null, maxCopyBytes: DEP_BYTES + 100 });
  try {
    expect((await lstat(join(candidate.dir, "node_modules"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(candidate.dir, "node_modules", "dep", "index.js"), "utf8")).toBe("d".repeat(DEP_BYTES));
    await writeFile(join(candidate.dir, "node_modules", "dep", "index.js"), "private rebuild");
    expect(await readFile(join(root, "node_modules", "dep", "index.js"), "utf8")).toBe("d".repeat(DEP_BYTES));
    expect((await candidate.reject("test")).status).toBe("rejected");
  } finally { await candidate.cleanup(); }
});

it("links a nested wave inside a candidate to the candidate's private copy, never to the original", async () => {
  links.deny = noDirSymlinks;
  const root = await project();
  const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    links.calls.length = 0;
    const set = await createBranchSet(candidate.dir, ["a"], { git: async () => null, maxCopyBytes: DEP_BYTES / 2 });
    expect(set).not.toBeNull();
    try {
      const nested = join(set!.workspaces.get("a")!.dir, "node_modules");
      expect(await realpath(nested)).toBe(await realpath(join(candidate.dir, "node_modules")));
      expect(links.calls.every(call => !inside(call.target, root))).toBe(true);
      expect(await readlink(nested)).not.toContain(root);
    } finally { await set?.cleanup(); }
  } finally { await candidate.cleanup(); }
});

async function workspaceProject(): Promise<string> {
  const root = await project();
  await mkdir(join(root, "packages", "pkg"), { recursive: true });
  await writeFile(join(root, "packages", "pkg", "index.js"), "original package\n");
  await mkdir(join(root, "node_modules", "@s"), { recursive: true });
  // npm workspaces on Windows and pnpm: absolute links into the project.
  await symlink(join(root, "packages", "pkg"), join(root, "node_modules", "@s", "pkg"), "dir");
  await symlink(join("..", "..", "packages", "pkg"), join(root, "node_modules", "@s", "rel"), "dir");
  links.calls.length = 0;
  return root;
}

it.each([
  ["symlinks allowed", () => undefined],
  ["only junctions allowed", (_target: string, type: string | undefined) => type === "junction" ? undefined : "EPERM"],
] as const)("points a candidate's dependency links into the project at the candidate (%s)", async (_label, deny) => {
  const root = await workspaceProject();
  links.deny = deny;
  const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    for (const name of ["pkg", "rel"]) {
      const link = join(candidate.dir, "node_modules", "@s", name);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await realpath(link)).toBe(join(await realpath(candidate.dir), "packages", "pkg"));
      await writeFile(join(link, "index.js"), `candidate wrote through ${name}\n`);
      expect(await readFile(join(root, "packages", "pkg", "index.js"), "utf8")).toBe("original package\n");
    }
    expect((await candidate.reject("test")).status).toBe("rejected");
  } finally { await candidate.cleanup(); }
});

it("keeps a candidate's dependency link outside the project pointing where it did", async () => {
  const root = await project();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "atag-dep-outside-"))); roots.push(outside);
  await symlink(outside, join(root, "node_modules", "global"), "dir");
  const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    expect(await readlink(join(candidate.dir, "node_modules", "global"))).toBe(outside);
  } finally { await candidate.cleanup(); }
});

it("names the link a candidate cannot recreate when no link kind is available", async () => {
  const root = await workspaceProject();
  links.deny = () => "EPERM";
  await expect(createCandidateIntegration(root, { git: async () => null })).rejects.toThrow(
    `cannot recreate the link ${join("node_modules", "@s", "pkg")} in a private workspace`,
  );
  expect(await readFile(join(root, "packages", "pkg", "index.js"), "utf8")).toBe("original package\n");
});
