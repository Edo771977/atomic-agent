import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";

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

