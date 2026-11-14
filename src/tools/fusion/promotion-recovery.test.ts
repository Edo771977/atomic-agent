import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runCommand } from "../../sandbox/command-runner.js";
import { recoverPromotion } from "./promotion-recovery.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const moduleUrl = (file: string) => pathToFileURL(fileURLToPath(new URL(file, import.meta.url))).href;

it.each(["intent", "first-applied"])("recovers an actual process stop after %s from the product journal", async phase => {
  const root = await mkdtemp(join(tmpdir(), "atag-journal-stop-")); roots.push(root);
  const project = join(root, "project"); await mkdir(project);
  await writeFile(join(project, "a.txt"), "original a\n"); await writeFile(join(project, "b.txt"), "original b\n");
  const script = join(root, "stop.mts");
  await writeFile(script, `import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCandidateIntegration } from ${JSON.stringify(moduleUrl("./candidate-integration.ts"))};
const project = process.argv[2];
const candidate = await createCandidateIntegration(project, {
  beforeCommit: async path => { if (${JSON.stringify(phase)} === "intent" && path === "a.txt") process.exit(17); },
  beforeApply: async (_path, index) => { if (${JSON.stringify(phase)} === "first-applied" && index === 1) process.exit(17); },
});
await writeFile(join(candidate.dir, "a.txt"), "promoted a\\n"); await writeFile(join(candidate.dir, "b.txt"), "promoted b\\n");
await candidate.finish({ rows: [{id:"one", title:"one", status:"ok", reply:"done", stepCount:1, durationMs:1, tools:{calls:1,errors:0,writes:1,byTool:{}}}],
  contract: {checks:[{kind:"command",command:"integration"}]}, signal: new AbortController().signal, runChecks: async () => ({ok:true,results:[{ok:true}]}) });
process.exit(18);
`);
  const stopped = await runCommand(process.execPath, ["--import", "tsx", script, project], { cwd: process.cwd(), timeoutMs: 20_000, maxOutputBytes: 2048, env: process.env });
  expect(stopped.exitCode, stopped.stderr).toBe(17);
  const merge = join(project, ".atomic-agent", "fusion-merge");
  const journal = join(merge, (await readdir(merge)).find(name => name.endsWith(".promotion.json"))!);
  const before = await readFile(journal); expect(JSON.parse(before.toString()).version).toBe(2);
  await recoverPromotion({ project, journal }); expect(await readFile(journal)).toEqual(before);
  expect((await recoverPromotion({ project, journal, mode: "rollback" })).conflicts).toEqual([]);
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("original a\n");
  expect(await readFile(join(project, "b.txt"), "utf8")).toBe("original b\n");
  expect((await recoverPromotion({ project, journal, mode: "rollback" })).state).toBe("rolled-back");
}, 30_000);

it("resumes safely after a second process stop between restore and its journal status update", async () => {
  const project = await mkdtemp(join(tmpdir(), "atag-recovery-stop-")); roots.push(project);
  const candidate = "candidate-012345abcdef", merge = join(project, ".atomic-agent", "fusion-merge");
  await mkdir(join(merge, `${candidate}.promotion-backup`), { recursive: true });
  await writeFile(join(project, "a.txt"), "promoted\n"); await writeFile(join(merge, `${candidate}.promotion-backup`, "0"), "original\n");
  const mode = (await lstat(join(project, "a.txt"))).mode & 0o777;
  const journal = join(merge, `${candidate}.promotion.json`);
  await writeFile(journal, JSON.stringify({ version: 2, candidate, project, startedAt: new Date().toISOString(), ownerPid: 2147483647, state: "promoting", steps: [
    { path: "a.txt", action: "write", status: "applied", original: { kind: "file", mode, sha256: hash("original\n") }, promoted: { kind: "file", mode, sha256: hash("promoted\n") }, backup: `${candidate}.promotion-backup/0` },
  ] }));
  const script = join(project, "stop.mts");
  await writeFile(script, `import { recoverPromotion } from ${JSON.stringify(moduleUrl("./promotion-recovery.ts"))};
await recoverPromotion({project:process.argv[2], journal:process.argv[3], mode:"rollback", afterRestore:()=>process.exit(17)});
`);
  const stopped = await runCommand(process.execPath, ["--import", "tsx", script, project, journal], { cwd: process.cwd(), timeoutMs: 15_000, maxOutputBytes: 2048, env: process.env });
  expect(stopped.exitCode, stopped.stderr).toBe(17);
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("original\n");
  const result = await recoverPromotion({ project, journal, mode: "rollback" });
  expect(result.state).toBe("rolled-back"); expect(result.conflicts).toEqual([]);
  expect(await readFile(join(project, "a.txt"), "utf8")).toBe("original\n");
});
