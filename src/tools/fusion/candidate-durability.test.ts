import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import type { WorkerTaskResult } from "./worker-result.js";

// FlushFileBuffers requires write access on Windows. Reproduce that contract
// on every host, while still flushing the real descriptor in the passing path.
const flushes = vi.hoisted(() => [] as { path: string; flags: unknown; writable: boolean; modeAtSync: number }[]);
const fault = vi.hoisted(() => ({ rejectSync: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (path: string, flags: Parameters<typeof actual.open>[1], ...rest: unknown[]) => {
    const writable = ((await actual.lstat(path)).mode & 0o200) !== 0;
    const handle = await (actual.open as (...args: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(path, flags, ...rest);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      flushes.push({ path, flags, writable, modeAtSync: (await actual.lstat(path)).mode & 0o777 });
      if (flags === "r" || fault.rejectSync) throw Object.assign(new Error("FlushFileBuffers denied"), { code: "EPERM" });
      return sync();
    };
    return handle;
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

const roots: string[] = [];
afterEach(async () => {
  flushes.length = 0; fault.rejectSync = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "atag-durability-")); roots.push(root);
  await writeFile(join(root, "a.txt"), "original\n");
  return root;
}
const rows: WorkerTaskResult[] = [{ id: "one", title: "one", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
const finish = { rows, contract: { checks: [{ kind: "command", command: "integration" }] }, signal: new AbortController().signal, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) };

it("durably promotes plain files using write-capable flush handles", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    await writeFile(join(candidate.dir, "a.txt"), "checked\n");
    const report = await candidate.finish(finish);
    expect(report.status, report.reason).toBe("promoted");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("checked\n");
    expect(flushes.some(item => item.path.includes(".promotion-backup"))).toBe(true);
    expect(flushes.some(item => item.path.includes(".atag-candidate-"))).toBe(true);
    expect(flushes.every(item => item.flags === "r+" && item.writable)).toBe(true);
  } finally { await candidate.cleanup(); }
});

it("flushes a read-only candidate file through a retained write handle after restoring its final mode", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    await writeFile(join(candidate.dir, "read-only.txt"), "immutable output\n");
    await chmod(join(candidate.dir, "read-only.txt"), 0o444);
    const expectedMode = (await lstat(join(candidate.dir, "read-only.txt"))).mode & 0o777;
    const report = await candidate.finish(finish);
    expect(report.status, report.reason).toBe("promoted");
    expect(await readFile(join(root, "read-only.txt"), "utf8")).toBe("immutable output\n");
    expect((await lstat(join(root, "read-only.txt"))).mode & 0o777).toBe(expectedMode);
    expect(flushes.every(item => item.flags === "r+" && item.writable)).toBe(true);
    expect(flushes.filter(item => item.path.includes(".atag-candidate-")).map(item => item.modeAtSync)).toEqual([expectedMode]);
  } finally { await candidate.cleanup(); }
});

it("flushes a writable pre-image backup of a read-only original and records its original mode", async () => {
  const root = await project(); await chmod(join(root, "a.txt"), 0o444);
  const originalMode = (await lstat(join(root, "a.txt"))).mode & 0o777;
  let backup: string | undefined; let recordedMode: number | undefined;
  const candidate = await createCandidateIntegration(root, { git: async () => null, beforeCommit: async () => {
    const merge = join(root, ".atomic-agent", "fusion-merge");
    const journal = JSON.parse(await readFile(join(merge, (await readdir(merge)).find(name => name.endsWith(".promotion.json"))!), "utf8"));
    backup = await readFile(join(merge, journal.steps[0].backup), "utf8");
    recordedMode = journal.steps[0].original.mode;
    throw new Error("stop after durable backup");
  } });
  try {
    await chmod(join(candidate.dir, "a.txt"), 0o600); await writeFile(join(candidate.dir, "a.txt"), "replacement\n");
    const report = await candidate.finish(finish);
    expect(report.status).toBe("rejected"); expect(report.reason).toContain("stop after durable backup");
    expect(backup).toBe("original\n"); expect(recordedMode).toBe(originalMode);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original\n");
    expect((await lstat(join(root, "a.txt"))).mode & 0o777).toBe(originalMode);
    expect(flushes.some(item => item.path.includes(".promotion-backup") && item.writable)).toBe(true);
  } finally { await candidate.cleanup(); }
});

it("rejects a genuine permission error from a write-capable flush", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root, { git: async () => null });
  try {
    await writeFile(join(candidate.dir, "a.txt"), "replacement\n"); fault.rejectSync = true;
    const report = await candidate.finish(finish);
    expect(report.status).toBe("rejected"); expect(report.reason).toContain("FlushFileBuffers denied");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original\n");
  } finally { await candidate.cleanup(); }
});
