import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBranchSet } from "./branch-workspace.js";
import { createCandidateIntegration } from "./candidate-integration.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";

// Pass-through spy: counts byte reads per absolute path (promotion work bound).
const reads = vi.hoisted(() => new Map<string, number>());
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream = ((path: Parameters<typeof actual.createReadStream>[0], ...rest: unknown[]) => {
    reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
    return (actual.createReadStream as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.createReadStream;
  return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), "atag-candidate-test-")); roots.push(root);
  await writeFile(join(root, "api.json"), '{"name":"before"}');
  await writeFile(join(root, "dirty.txt"), "user's uncommitted bytes\r\n");
  return root;
}
const rows: WorkerTaskResult[] = [{ id: "api", title: "api", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
const contract = { checks: [{ kind: "command", command: "integration" }] };
const signal = new AbortController().signal;

it("rejects individually valid files with incompatible final API and retains a patch", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "api.json"), '{"name":"renamed"}');
    await writeFile(join(candidate.dir, "consumer.json"), '{"requires":"before"}');
    const report = await candidate.finish({ rows, contract, signal, runChecks: async (_, ctx) => {
      expect(ctx.workingDir).toBe(candidate.dir);
      const api = JSON.parse(await readFile(join(ctx.workingDir, "api.json"), "utf8"));
      const consumer = JSON.parse(await readFile(join(ctx.workingDir, "consumer.json"), "utf8"));
      return { ok: api.name === consumer.requires, results: [{ ok: api.name === consumer.requires }] };
    } });
    expect(report.status).toBe("rejected"); expect(report.patch?.path).toBeTruthy();
    expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"before"}');
    await expect(readFile(join(root, "consumer.json"))).rejects.toThrow();
  } finally { await candidate.cleanup(); }
});

it("promotes checked final bytes, additions and deletions while retaining original dirty inputs", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "api.json"), Buffer.from([0, 1, 2, 255]));
    await mkdir(join(candidate.dir, "new")); await writeFile(join(candidate.dir, "new", "out.txt"), "delivered");
    await writeFile(join(root, "remove.txt"), "later user input");
    // Any new user path prevents promotion, even if unrelated to candidate writes.
    expect((await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) })).status).toBe("rejected");
    expect(await readFile(join(root, "dirty.txt"), "utf8")).toBe("user's uncommitted bytes\r\n");
  } finally { await candidate.cleanup(); }
  await rm(join(root, "remove.txt"));
  const next = await createCandidateIntegration(root);
  try {
    await writeFile(join(next.dir, "api.json"), Buffer.from([0, 1, 2, 255]));
    await mkdir(join(next.dir, "new")); await writeFile(join(next.dir, "new", "out.txt"), "delivered");
    await rm(join(next.dir, "dirty.txt"));
    const report = await next.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("promoted"); expect(await readFile(join(root, "api.json"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(join(root, "new", "out.txt"), "utf8")).toBe("delivered");
    await expect(readFile(join(root, "dirty.txt"))).rejects.toThrow();
  } finally { await next.cleanup(); }
});

it.each(["max_steps", "needs_orchestrator", "cancelled", "no_changes"] as const)("does not promote a %s row even with a passing check", async status => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "api.json"), "changed");
    const report = await candidate.finish({ rows: [{ ...rows[0]!, status }], contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("rejected"); expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"before"}');
  } finally { await candidate.cleanup(); }
});

it("fails closed for missing check evidence and protects declared inputs", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "dirty.txt"), "replacement");
    expect((await candidate.finish({ rows, signal })).reason).toMatch(/integration check/);
  } finally { await candidate.cleanup(); }
  await writeFile(join(root, "input.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  const next = await createCandidateIntegration(root);
  try {
    await writeFile(join(next.dir, "input.txt"), "replacement");
    const report = await next.finish({ rows, contract: { ...contract, inputs: ["input.txt"] }, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/declared input/);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
  } finally { await next.cleanup(); }
});

it("rolls back partial delivery on failure without overwriting a concurrent user edit", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root, { beforeApply: async (path, index) => {
    if (index !== 1) return;
    await writeFile(join(root, "api.json"), "user edit during delivery");
    throw new Error(`simulated delivery failure at ${path}`);
  } });
  try {
    await writeFile(join(candidate.dir, "api.json"), "candidate api");
    await writeFile(join(candidate.dir, "dirty.txt"), "candidate dirty");
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/delivery/);
    expect(await readFile(join(root, "api.json"), "utf8")).toBe("user edit during delivery");
    expect(await readFile(join(root, "dirty.txt"), "utf8")).toBe("user's uncommitted bytes\r\n");
    // An incomplete rollback keeps the promotion journal for manual recovery.
    expect(report.rollbackConflicts).toEqual(["api.json"]);
    const journal = JSON.parse(await readFile(join(root, report.promotionJournal!), "utf8"));
    expect(journal.state).toBe("rolled-back-with-conflicts");
    expect(journal.steps.map((step: { path: string; status: string }) => [step.path, step.status])).toEqual([["api.json", "rollback-conflict"]]);
  } finally { await candidate.cleanup(); }
});

it("rejects cancellation occurring inside the final integration check", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root); const abort = new AbortController();
  try {
    await writeFile(join(candidate.dir, "api.json"), "candidate api");
    const report = await candidate.finish({ rows, contract, signal: abort.signal, runChecks: async () => { abort.abort(); return { ok: true, results: [{ ok: true }] }; } });
    expect(report.status).toBe("rejected"); expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"before"}');
  } finally { await candidate.cleanup(); }
});

it("includes files generated by the final check and detects restored-mtime candidate writes", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    const before = await stat(join(candidate.dir, "api.json"));
    await writeFile(join(candidate.dir, "api.json"), '{"name":"AFTER!"}');
    await utimes(join(candidate.dir, "api.json"), before.atime, before.mtime);
    const report = await candidate.finish({ rows, contract, signal, runChecks: async (_, ctx) => {
      await writeFile(join(ctx.workingDir, "generated.bin"), Buffer.from([0, 255, 0])); return { ok: true, results: [{ ok: true }] };
    } });
    expect(report.status).toBe("promoted");
    expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"AFTER!"}');
    expect(await readFile(join(root, "generated.bin"))).toEqual(Buffer.from([0, 255, 0]));
    expect(report.artifactManifest?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "generated.bin", state: "hashed" })]));
  } finally { await candidate.cleanup(); }
});

it("refuses cancelled or oversized staging and retains overgrown candidates for manual recovery", async () => {
  const root = await project(); const abort = new AbortController(); abort.abort();
  await expect(createCandidateIntegration(root, { signal: abort.signal })).rejects.toThrow();
  await expect(createCandidateIntegration(root, { maxInventoryBytes: 1 })).rejects.toThrow(/byte limit/);
  const candidate = await createCandidateIntegration(root, { maxInventoryBytes: 100 });
  try {
    await writeFile(join(candidate.dir, "too-large.bin"), Buffer.alloc(101));
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("rejected"); expect(report.retainedWorkspace).toBe(candidate.dir);
    roots.push(dirname(candidate.dir));
    await candidate.cleanup(); expect((await readFile(join(candidate.dir, "too-large.bin"))).length).toBe(101);
  } finally { await candidate.cleanup(); }
});

it("copies held task patches out of the candidate before cleanup", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  let held: string | undefined;
  try {
    const dir = join(candidate.dir, ".atomic-agent", "fusion-merge"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "failed.patch"), "GIT binary patch\nkept failed task evidence\n");
    const report = await candidate.finish({ rows: [{ ...rows[0]!, status: "failed" }], contract, signal });
    held = report.heldArtifactsDir; expect(held).toBeTruthy();
  } finally { await candidate.cleanup(); }
  expect(await readFile(join(root, held!, "failed.patch"), "utf8")).toContain("kept failed task evidence");
});

it("promotes inside a Git subdirectory while retaining dirty and untracked original bytes", async () => {
  const repo = await makeGitRepo("atag-candidate-git-"); roots.push(repo);
  await writeRepoFile(repo, "project/api.json", '{"name":"committed"}');
  await writeRepoFile(repo, "project/dirty.txt", "committed\n");
  await runGitRaw(repo, ["add", "-A"]); await runGitRaw(repo, ["commit", "-qm", "fixture"]);
  const root = join(repo, "project"); await writeFile(join(root, "dirty.txt"), "dirty original\r\n");
  await writeFile(join(root, "personal.txt"), "untracked\r\n");
  const candidate = await createCandidateIntegration(root);
  try {
    expect((await runGitRaw(candidate.dir, ["rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true");
    await writeFile(join(candidate.dir, "api.json"), '{"name":"checked"}');
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("promoted"); expect(await readFile(join(root, "dirty.txt"), "utf8")).toBe("dirty original\r\n");
    expect(await readFile(join(root, "personal.txt"), "utf8")).toBe("untracked\r\n");
    expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"checked"}');
  } finally { await candidate.cleanup(); }
});

async function ignoreRepo() {
  const repo = await makeGitRepo("atag-candidate-ignore-"); roots.push(repo);
  await writeRepoFile(repo, "scripts/build/pack.sh", "echo old\n");
  await writeRepoFile(repo, ".gitignore", ".env\nnode_modules/\n");
  await writeRepoFile(repo, "a.txt", "a\n");
  await writeRepoFile(repo, ".atomic-agent/approval-rules.json", '{"rules":[]}');
  await runGitRaw(repo, ["add", "-A"]); await runGitRaw(repo, ["commit", "-qm", "fixture"]);
  await writeFile(join(repo, ".env"), "SECRET=1\n");
  await mkdir(join(repo, "node_modules")); await writeFile(join(repo, "node_modules", "dep.js"), "dep\n");
  return repo;
}
const pass = async () => ({ ok: true, results: [{ ok: true }] });

it("promotes a tracked file under a directory named like a dependency/build folder", async () => {
  const root = await ignoreRepo(); const candidate = await createCandidateIntegration(root);
  try {
    expect(await readFile(join(candidate.dir, "scripts", "build", "pack.sh"), "utf8")).toBe("echo old\n");
    await writeFile(join(candidate.dir, "scripts", "build", "pack.sh"), "echo new\n");
    await writeFile(join(candidate.dir, "node_modules", "dep.js"), "private rebuild\n");
    const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("promoted");
    expect(report.changes).toEqual(["scripts/build/pack.sh"]);
    expect(await readFile(join(root, "scripts", "build", "pack.sh"), "utf8")).toBe("echo new\n");
    expect(await readFile(join(root, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
  } finally { await candidate.cleanup(); }
});

it("never promotes deletion or modification of ignored standalone files", async () => {
  const root = await ignoreRepo(); const candidate = await createCandidateIntegration(root);
  try {
    expect(await readFile(join(candidate.dir, ".env"), "utf8")).toBe("SECRET=1\n");
    await rm(join(candidate.dir, ".env"));
    await writeFile(join(candidate.dir, "a.txt"), "a2\n");
    const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("promoted"); expect(report.changes).toEqual(["a.txt"]);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
  } finally { await candidate.cleanup(); }
  const next = await createCandidateIntegration(root);
  try {
    await writeFile(join(next.dir, ".env"), "SECRET=worker\n");
    await writeFile(join(next.dir, ".env.local"), "created\n");
    const report = await next.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("promoted"); expect(report.changes).toEqual([".env.local"]);
    expect(report.ignoredChanges).toEqual([".env"]);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
  } finally { await next.cleanup(); }
});

it("refuses to promote changes to the project's agent state directory", async () => {
  const root = await ignoreRepo();
  for (const change of [
    (dir: string) => rm(join(dir, ".atomic-agent", "approval-rules.json")),
    (dir: string) => writeFile(join(dir, ".atomic-agent", "approval-rules.json"), '{"rules":[{"allow":"*"}]}'),
    (dir: string) => writeFile(join(dir, ".atomic-agent", "new-state.json"), "{}"),
  ]) {
    const candidate = await createCandidateIntegration(root);
    try {
      await change(candidate.dir); await writeFile(join(candidate.dir, "a.txt"), "a2\n");
      const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
      expect(report.status).toBe("rejected"); expect(report.reason).toContain(".atomic-agent");
      expect(await readFile(join(root, ".atomic-agent", "approval-rules.json"), "utf8")).toBe('{"rules":[]}');
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a\n");
    } finally { await candidate.cleanup(); }
  }
});

it("keeps worker writes under a shared dependency folder private to the candidate, even after rejection", async () => {
  const root = await ignoreRepo(); const candidate = await createCandidateIntegration(root);
  try {
    // The candidate's dependency folder is its own copy, never a link to the original.
    expect((await lstat(join(candidate.dir, "node_modules"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(candidate.dir, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
    // Per-task workspaces made inside the candidate share the candidate's copy.
    const inner = await createBranchSet(candidate.dir, ["worker"]);
    expect(inner).not.toBeNull();
    try {
      const task = inner!.workspaces.get("worker")!;
      expect(await realpath(join(task.dir, "node_modules"))).toBe(await realpath(join(candidate.dir, "node_modules")));
      await writeFile(join(task.dir, "node_modules", "dep.js"), "worker write\n");
      await writeFile(join(task.dir, "node_modules", "added.js"), "worker add\n");
    } finally { await inner!.cleanup(); }
    expect(await readFile(join(root, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
    await expect(lstat(join(root, "node_modules", "added.js"))).rejects.toThrow();
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: false, results: [{ ok: false }] }) });
    expect(report.status).toBe("rejected");
    expect(await readFile(join(root, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
    await expect(lstat(join(root, "node_modules", "added.js"))).rejects.toThrow();
  } finally { await candidate.cleanup(); }
  expect(await readFile(join(root, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
});

it("gives a folder-copy candidate its own dependency folder too", async () => {
  const root = await project();
  await mkdir(join(root, "node_modules")); await writeFile(join(root, "node_modules", "dep.js"), "dep\n");
  const candidate = await createCandidateIntegration(root);
  try {
    expect((await lstat(join(candidate.dir, "node_modules"))).isSymbolicLink()).toBe(false);
    await writeFile(join(candidate.dir, "node_modules", "dep.js"), "worker write\n");
    expect((await candidate.reject("test")).status).toBe("rejected");
  } finally { await candidate.cleanup(); }
  expect(await readFile(join(root, "node_modules", "dep.js"), "utf8")).toBe("dep\n");
});

it.each([".ATOMIC-AGENT", ".Atomic-Agent", ".atomic-agent.", ".atomic-agent "])("refuses agent state spelled %j, as a case-insensitive or Win32 filesystem opens it", async name => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await mkdir(join(candidate.dir, name));
    await writeFile(join(candidate.dir, name, "approval-rules.json"), '{"rules":[{"allow":"*"}]}');
    const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("rejected"); expect(report.reason).toContain("agent state");
    await expect(lstat(join(root, name))).rejects.toThrow();
  } finally { await candidate.cleanup(); }
});

async function droppedRepo() {
  const repo = await makeGitRepo("atag-candidate-dropped-"); roots.push(repo);
  await writeRepoFile(repo, ".gitignore", "*.log\nout/\n");
  await writeRepoFile(repo, "src/notes.md", "keep me\n");
  await writeRepoFile(repo, "a.txt", "a\n");
  await runGitRaw(repo, ["add", "-A"]); await runGitRaw(repo, ["commit", "-qm", "fixture"]);
  return repo;
}

it("rejects a tracked file renamed onto an ignored name instead of silently deleting it", async () => {
  const root = await droppedRepo(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "src", "notes.log"), await readFile(join(candidate.dir, "src", "notes.md")));
    await rm(join(candidate.dir, "src", "notes.md"));
    const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("rejected");
    expect(report.reason).toContain("src/notes.md"); expect(report.reason).toContain("src/notes.log");
    expect(await readFile(join(root, "src", "notes.md"), "utf8")).toBe("keep me\n");
  } finally { await candidate.cleanup(); }
});

it("rejects a declared provide that only exists under an ignored path", async () => {
  const root = await droppedRepo(); const candidate = await createCandidateIntegration(root);
  try {
    await mkdir(join(candidate.dir, "out")); await writeFile(join(candidate.dir, "out", "bundle.js"), "export {}\n");
    await writeFile(join(candidate.dir, "a.txt"), "a2\n");
    const tasks = [{ id: "api", title: "api", instructions: "build" }] as never;
    const report = await candidate.finish({ rows, tasks, contract: { ...contract, provides: [{ task: "api", kind: "file", name: "out/bundle.js" }] } as never, signal, runChecks: pass });
    expect(report.status).toBe("rejected"); expect(report.reason).toContain("out/bundle.js");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a\n");
  } finally { await candidate.cleanup(); }
});

it("promotes but reports new ignored paths it kept private", async () => {
  const root = await droppedRepo(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "a.txt"), "a2\n");
    await writeFile(join(candidate.dir, "run.log"), "log\n");
    await mkdir(join(candidate.dir, "out")); await writeFile(join(candidate.dir, "out", "x.js"), "x\n");
    const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("promoted"); expect(report.changes).toEqual(["a.txt"]);
    expect(report.ignoredChanges).toEqual(["out", "run.log"]);
  } finally { await candidate.cleanup(); }
});

it("verifies only the paths it promotes instead of re-hashing the untouched original tree per step", async () => {
  const root = await project();
  for (let i = 0; i < 30; i += 1) await writeFile(join(root, `keep-${i}.txt`), `untouched ${i}\n`);
  const candidate = await createCandidateIntegration(root);
  try {
    for (let i = 0; i < 6; i += 1) await writeFile(join(candidate.dir, `new-${i}.txt`), `new ${i}\n`);
    await writeFile(join(candidate.dir, "api.json"), '{"name":"after"}');
    reads.clear();
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("promoted");
    // One full inventory of the original confirms it still matches the
    // snapshot; per-step and final checks touch only the promoted paths.
    const untouched = [...reads].filter(([path]) => path.startsWith(join(root, "keep-")));
    expect(untouched.length).toBe(30);
    expect(Math.max(...untouched.map(([, n]) => n))).toBe(1);
    expect(await readFile(join(root, "new-5.txt"), "utf8")).toBe("new 5\n");
  } finally { await candidate.cleanup(); }
});

it("treats a user edit between the step's verification and the rename as a concurrent change", async () => {
  const root = await project();
  const candidate = await createCandidateIntegration(root, { beforeCommit: async path => {
    if (path === "dirty.txt") await writeFile(join(root, "dirty.txt"), "user edit in the commit window");
  } });
  try {
    await writeFile(join(candidate.dir, "api.json"), "candidate api");
    await writeFile(join(candidate.dir, "dirty.txt"), "candidate dirty");
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/changed during candidate delivery/);
    expect(await readFile(join(root, "dirty.txt"), "utf8")).toBe("user edit in the commit window");
    // The already-delivered sibling is rolled back.
    expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"before"}');
  } finally { await candidate.cleanup(); }
});

const mergeDir = (root: string) => join(root, ".atomic-agent", "fusion-merge");
const promotionFiles = async (root: string) => (await readdir(mergeDir(root)).catch(() => [] as string[])).filter(name => name.includes(".promotion"));

it("journals each promotion step durably with pre-image backups so a crash mid-delivery is recoverable", async () => {
  const root = await project();
  let journalAtCrash: { state: string; steps: { path: string; status: string; original: { kind: string; sha256?: string } | null; backup?: string }[] } | undefined;
  let backupBytes: Record<string, string> = {};
  const candidate = await createCandidateIntegration(root, { beforeApply: async (_path, index) => {
    if (index !== 2) return;
    // The process "dies" here: inspect exactly what a human would find on disk.
    const names = await promotionFiles(root);
    const journal = names.find(name => name.endsWith(".promotion.json"));
    expect(journal).toBeTruthy();
    journalAtCrash = JSON.parse(await readFile(join(mergeDir(root), journal!), "utf8"));
    for (const step of journalAtCrash!.steps) if (step.backup !== undefined) backupBytes[step.path] = await readFile(join(mergeDir(root), step.backup), "utf8");
    throw new Error("simulated crash");
  } });
  try {
    await writeFile(join(candidate.dir, "api.json"), "candidate api");
    await rm(join(candidate.dir, "dirty.txt"));
    await writeFile(join(candidate.dir, "new.txt"), "new");
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
    expect(report.status).toBe("rejected");
  } finally { await candidate.cleanup(); }
  expect(journalAtCrash?.state).toBe("promoting");
  expect(journalAtCrash?.steps.map(step => [step.path, step.status])).toEqual([["api.json", "applied"], ["dirty.txt", "applied"]]);
  expect(journalAtCrash?.steps.map(step => step.original?.kind)).toEqual(["file", "file"]);
  expect(backupBytes).toEqual({ "api.json": '{"name":"before"}', "dirty.txt": "user's uncommitted bytes\r\n" });
  // A full rollback restored the original, so the journal and backups are gone.
  expect(await readFile(join(root, "api.json"), "utf8")).toBe('{"name":"before"}');
  expect(await readFile(join(root, "dirty.txt"), "utf8")).toBe("user's uncommitted bytes\r\n");
  expect(await promotionFiles(root)).toEqual([]);
  backupBytes = {};
  const next = await createCandidateIntegration(root);
  try {
    await writeFile(join(next.dir, "api.json"), "promoted api");
    expect((await next.finish({ rows, contract, signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) })).status).toBe("promoted");
  } finally { await next.cleanup(); }
  expect(await promotionFiles(root)).toEqual([]);
});
