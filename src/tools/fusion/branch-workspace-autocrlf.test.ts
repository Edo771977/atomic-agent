import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGitRepo, runGitRaw } from "../os/git/test-helpers.js";
import { runIsolatedWave } from "./branch-merge.js";
import { createBranchSet } from "./branch-workspace.js";
import type { WorkerTaskResult } from "./worker-result.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("actual tracked working-tree snapshot", () => {
  it.each(["cached-clean CRLF", "eol attribute"] as const)("preserves actual bytes despite %s normalization", async (kind) => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.autocrlf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    const repo = await makeGitRepo("atag-working-bytes-");
    const root = await mkdtemp(join(tmpdir(), "atag-working-bytes-tmp-"));
    cleanup.push(repo, root);
    await runGitRaw(repo, ["config", "core.autocrlf", "true"]);
    const eol = kind === "cached-clean CRLF" ? "\r\n" : "\n";
    const before = `one${eol}two${eol}three${eol}`;
    if (kind === "eol attribute") await writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    await writeFile(join(repo, "a.txt"), before);
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await utimes(join(repo, "a.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
    expect((await runGitRaw(repo, ["status", "--porcelain"])).stdout).toBe("");
    const indexBefore = await readFile(join(repo, ".git", "index"));
    let snapshot: string | undefined;
    const after = `one${eol}changed${eol}three${eol}`;
    const result = await runIsolatedWave({
      realDir: repo, tasks: [{ id: "one", title: "one", instructions: "edit a.txt" }],
      writeScope: [repo], inputs: [], options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        snapshot = await readFile(join(dir, "a.txt"), "utf8");
        await writeFile(join(dir, "a.txt"), after);
        return [{ id: "one", title: "one", status: "ok", reply: "done", stepCount: 1, durationMs: 1,
          tools: { calls: 1, errors: 0, writes: 1, byTool: {} } } satisfies WorkerTaskResult];
      },
    });
    expect(snapshot).toBe(before);
    expect(result.results[0]!.status).toBe("ok");
    expect(result.outcomes[0]!.conflicts).toEqual([]);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe(after);
    expect(await readFile(join(repo, ".git", "index"))).toEqual(indexBefore);
    expect(await readdir(root)).toEqual([]);
  });

  it("charges tracked byte overlays to the cumulative private-copy limit", async () => {
    const repo = await makeGitRepo("atag-overlay-limit-");
    const root = await mkdtemp(join(tmpdir(), "atag-overlay-limit-tmp-"));
    cleanup.push(repo, root);
    // The checkout writes CRLF, so the original's LF bytes are overlaid
    // (an identical checkout costs nothing); .gitattributes is identical.
    await writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    await writeFile(join(repo, "a.txt"), "12345\n7890");
    const globalIgnore = join(root, "empty-ignore");
    await writeFile(globalIgnore, "");
    await runGitRaw(repo, ["config", "core.excludesFile", globalIgnore]);
    await writeFile(join(repo, ".git", "info", "exclude"), "");
    await runGitRaw(repo, ["add", "a.txt", ".gitattributes"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    const refused = await createBranchSet(repo, ["one", "two"], { tmpRoot: root, maxCopyBytes: 29 });
    if (refused !== null) await refused.cleanup();
    expect(refused).toBeNull();
    expect(await readdir(root)).toEqual(["empty-ignore"]);
    const exact = await createBranchSet(repo, ["one", "two"], { tmpRoot: root, maxCopyBytes: 30 });
    expect(exact).not.toBeNull();
    await exact?.cleanup();
  });
});

describe("snapshot line ending identity", () => {
  it.each(["\n", "\r\n"])("preserves original %j bytes with core.autocrlf enabled and merges a single-task edit", async (eol) => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.autocrlf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    const repo = await makeGitRepo("atag-autocrlf-");
    const root = await mkdtemp(join(tmpdir(), "atag-autocrlf-tmp-"));
    cleanup.push(repo, root);
    await runGitRaw(repo, ["config", "core.autocrlf", "true"]);
    const before = `one${eol}two${eol}three${eol}`;
    await writeFile(join(repo, "a.txt"), before);
    await runGitRaw(repo, ["add", "a.txt"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    const after = `one${eol}changed${eol}three${eol}`;
    let snapshot: string | undefined;
    const result = await runIsolatedWave({
      realDir: repo,
      tasks: [{ id: "one", title: "one", instructions: "edit a.txt" }],
      writeScope: [repo], inputs: [], options: { tmpRoot: root },
      run: async (_tasks, workspace) => {
        const dir = workspace!("one")!.workingDir;
        snapshot = await readFile(join(dir, "a.txt"), "utf8");
        await writeFile(join(dir, "a.txt"), after);
        return [{
          id: "one", title: "one", status: "ok", reply: "done", stepCount: 1, durationMs: 1,
          tools: { calls: 1, errors: 0, writes: 1, byTool: {} },
        } satisfies WorkerTaskResult];
      },
    });
    expect(snapshot).toBe(before);
    expect(result.results[0]!.status).toBe("ok");
    expect(result.outcomes[0]!.conflicts).toEqual([]);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe(after);
    expect(await readdir(root)).toEqual([]);
    expect((await runGitRaw(repo, ["config", "core.autocrlf"])).stdout.trim()).toBe("true");
  });
});
