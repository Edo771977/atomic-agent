import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import { makeGitRepo, runGitRaw } from "../os/git/test-helpers.js";
import type { WorkerTaskResult } from "./worker-result.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const KiB = 1024;
const MiB = KiB * KiB;
const rows: WorkerTaskResult[] = [{ id: "a", title: "a", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
const contract = { checks: [{ kind: "command", cmd: "fixture-check" }] };
const signal = new AbortController().signal;
async function fixture(git = false) {
  const root = await mkdtemp(join(tmpdir(), "atag-candidate-budget-")); roots.push(root);
  const project = git ? await makeGitRepo("atag-candidate-budget-git-") : join(root, "project"); if (git) roots.push(project); else await mkdir(project);
  await writeFile(join(project, "output.txt"), "before");
  if (git) { await runGitRaw(project, ["add", "."]); await runGitRaw(project, ["commit", "-qm", "fixture"]); }
  const copies = join(root, "copies"); await mkdir(copies);
  return { root, project, copies };
}

it.each(["folder", "untracked", "ignored-file", "ignored-directory"])("refuses the measured whole final copy before workers for %s payload", async kind => {
  const f = await fixture(kind !== "folder");
  let path = "payload.bin";
  if (kind === "ignored-directory") { await mkdir(join(f.project, "cache")); path = "cache/payload.bin"; }
  if (kind.startsWith("ignored")) {
    await writeFile(join(f.project, ".gitignore"), kind === "ignored-file" ? "payload.bin\n" : "cache/\n");
    await runGitRaw(f.project, ["add", ".gitignore"]); await runGitRaw(f.project, ["commit", "-qm", "ignore fixture"]);
  }
  await writeFile(join(f.project, path), Buffer.alloc(400 * KiB));
  let candidate: Awaited<ReturnType<typeof createCandidateIntegration>> | undefined;
  try {
    await expect((async () => { candidate = await createCandidateIntegration(f.project, { maxCopyBytes: MiB, tmpRoot: f.copies, ...(kind === "folder" ? { git: async () => null } : {}) }); })()).rejects.toThrow(/candidate workspace unavailable:.*final.*remaining candidate copy budget/i);
    expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("before");
    expect(await readdir(f.copies)).toEqual([]);
  } finally { await candidate?.cleanup(); }
});

it("includes ordinary payload beside dependencies even when the dependency minimum fits", async () => {
  const f = await fixture();
  await mkdir(join(f.project, "node_modules")); await writeFile(join(f.project, "node_modules", "dep.js"), Buffer.alloc(100 * KiB));
  await writeFile(join(f.project, "payload.bin"), Buffer.alloc(200 * KiB));
  let candidate: Awaited<ReturnType<typeof createCandidateIntegration>> | undefined;
  try {
    await expect((async () => { candidate = await createCandidateIntegration(f.project, { maxCopyBytes: 900 * KiB, tmpRoot: f.copies, git: async () => null }); })()).rejects.toThrow(/final.*remaining candidate copy budget/i);
  } finally { await candidate?.cleanup(); }
});

it("includes tracked byte overlays in the measured final copy", async () => {
  const f = await fixture(true);
  await writeFile(join(f.project, ".gitattributes"), "payload.txt text eol=crlf\n");
  await writeFile(join(f.project, "payload.txt"), "x\n".repeat(200 * KiB));
  await runGitRaw(f.project, ["add", "."]); await runGitRaw(f.project, ["commit", "-qm", "tracked filtered payload"]);
  let candidate: Awaited<ReturnType<typeof createCandidateIntegration>> | undefined;
  try {
    await expect((async () => { candidate = await createCandidateIntegration(f.project, { maxCopyBytes: MiB, tmpRoot: f.copies }); })()).rejects.toThrow(/final.*remaining candidate copy budget/i);
  } finally { await candidate?.cleanup(); }
});

it.each([400 * KiB, 700 * KiB, 1200 * KiB])("retains Git checkout capacity for %i tracked payload bytes and later same-size edits", async bytes => {
  const f = await fixture(true);
  await writeFile(join(f.project, "payload.bin"), Buffer.alloc(bytes));
  await runGitRaw(f.project, ["add", "."]); await runGitRaw(f.project, ["commit", "-qm", "tracked payload"]);
  const candidate = await createCandidateIntegration(f.project, { maxCopyBytes: bytes <= 700 * KiB ? MiB : 2 * MiB, tmpRoot: f.copies });
  try {
    await writeFile(join(candidate.dir, "output.txt"), "after!");
    await writeFile(join(candidate.dir, "payload.bin"), Buffer.alloc(bytes, 1));
    let checks = 0;
    const result = await candidate.finish({ rows, contract, signal, runChecks: async () => { checks++; return { ok: true, results: [{ ok: true }] }; } });
    expect(result.status).toBe("promoted"); expect(checks).toBe(1);
    expect(await readFile(join(f.project, "output.txt"), "utf8")).toBe("after!");
  } finally { await candidate.cleanup(); }
});

it("keeps later worker growth a separate final-budget rejection", async () => {
  const f = await fixture();
  const candidate = await createCandidateIntegration(f.project, { maxCopyBytes: MiB, tmpRoot: f.copies, git: async () => null });
  try {
    await writeFile(join(candidate.dir, "grown.bin"), Buffer.alloc(600 * KiB));
    let checks = 0;
    const result = await candidate.finish({ rows, contract, signal, runChecks: async () => { checks++; return { ok: true, results: [{ ok: true }] }; } });
    expect(result.status).toBe("rejected"); expect(result.reason).toMatch(/remaining candidate copy budget/); expect(checks).toBe(0);
  } finally { await candidate.cleanup(); }
});
