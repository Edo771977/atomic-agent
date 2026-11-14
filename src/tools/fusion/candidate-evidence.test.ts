import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCandidateIntegration } from "./candidate-integration.js";
import { parseDelegateArgs } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() { const root = await mkdtemp(join(tmpdir(), "atag-candidate-evidence-")); roots.push(root); await writeFile(join(root, "a.txt"), "original"); return root; }
const rows: WorkerTaskResult[] = [{ id: "a", title: "a", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
const contract = { checks: [{ kind: "command", cmd: "check" }] };
const signal = new AbortController().signal;
const pass = async () => ({ ok: true, results: [{ ok: true }] });

it("rejects candidate mutation while final checks inspect a private stable source", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "a.txt"), "checked-good");
    const report = await candidate.finish({ rows, contract, signal, runChecks: async (_, ctx) => {
      expect(await readFile(join(ctx.workingDir, "a.txt"), "utf8")).toBe("checked-good");
      await writeFile(join(candidate.dir, "a.txt"), "untested-bad");
      return pass();
    } });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/candidate changed|payload/);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original");
  } finally { await candidate.cleanup(); }
});

it("checks a frozen source even if candidate bytes change and are restored during the check", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "a.txt"), "checked-good"); let seen = "";
    const report = await candidate.finish({ rows, contract, signal, runChecks: async (_, ctx) => {
      await writeFile(join(candidate.dir, "a.txt"), "transient-bad");
      seen = await readFile(join(ctx.workingDir, "a.txt"), "utf8");
      await writeFile(join(candidate.dir, "a.txt"), "checked-good");
      return pass();
    } });
    expect(seen).toBe("checked-good"); expect(report.status).toBe("promoted");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("checked-good");
  } finally { await candidate.cleanup(); }
});

it("rejects same-length edits to declared check inputs frozen before workers", async () => {
  const root = await project(); await writeFile(join(root, "check.mjs"), "expected=good\nline2\nline3\nline4\nline5\n");
  const options = { checkInputs: ["check.mjs"] } as Parameters<typeof createCandidateIntegration>[1] & { checkInputs: string[] };
  const candidate = await createCandidateIntegration(root, options);
  try {
    await writeFile(join(candidate.dir, "a.txt"), "bad"); await writeFile(join(candidate.dir, "check.mjs"), "expected=evil\nline2\nline3\nline4\nline5\n");
    const declared = { ...contract, checkInputs: ["check.mjs"], inputs: ["check.mjs"] };
    const report = await candidate.finish({ rows, contract: declared, signal, runChecks: pass });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/check input/);
    expect(await readFile(join(root, "check.mjs"), "utf8")).toContain("expected=good");
  } finally { await candidate.cleanup(); }
});

it("preserves collected final manifest when original drift rejects promotion", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "a.txt"), "candidate");
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => { await writeFile(join(root, "other.txt"), "user"); return pass(); } });
    expect(report.status).toBe("rejected"); expect(report.artifactManifest?.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "a.txt" })]));
  } finally { await candidate.cleanup(); }
});

it("parses literal protected check inputs and rejects patterns and unbounded lists", () => {
  const tasks = [{ id: "a", instructions: "work" }];
  expect(parseDelegateArgs({ tasks, contract: { checkInputs: ["test/check.mjs"] } })).toMatchObject({ ok: true, contract: { checkInputs: ["test/check.mjs"] } });
  expect(parseDelegateArgs({ tasks, contract: { checkInputs: ["test/*.mjs"] } })).toMatchObject({ ok: false });
  expect(parseDelegateArgs({ tasks, contract: { checkInputs: Array.from({ length: 33 }, (_, i) => `check-${i}.mjs`) } })).toMatchObject({ ok: false });
});
