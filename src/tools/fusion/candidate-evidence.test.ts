import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const { runChecks } = await import("../verify/run-verify.js");
    const report = await candidate.finish({ rows, contract: declared, signal, runChecks });
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

it("charges the frozen final source to the candidate's remaining cumulative byte budget", async () => {
  const root = await project(); const candidate = await createCandidateIntegration(root, { maxCopyBytes: 32 });
  try {
    await writeFile(join(candidate.dir, "a.txt"), "candidate");
    const report = await candidate.finish({ rows, contract, signal, runChecks: pass });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/remaining candidate copy budget/);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original");
  } finally { await candidate.cleanup(); }
});

it("binds promoted and zero-change receipts only after final delivery verification", async () => {
  const root = await project(); await writeFile(join(root, "check.mjs"), "test");
  for (const changed of [true, false]) {
    const candidate = await createCandidateIntegration(root, { checkInputs: ["check.mjs"] });
    try {
      if (changed) await writeFile(join(candidate.dir, "a.txt"), "candidate");
      const declared = { checks: [{ kind: "command", cmd: process.execPath, args: ["-e", "process.exit(0)"] }], checkInputs: ["check.mjs"] };
      const { runChecks } = await import("../verify/run-verify.js");
      const report = await candidate.finish({ rows, contract: declared, signal, runChecks });
      expect(report.status).toBe("promoted");
      expect(report.acceptanceReceipt).toMatchObject({ version: 1, disposition: changed ? "promoted" : "unchanged", checkScope: "protected-declared", checkStatus: "passed", inputs: { declared: 1, verified: 1 }, checks: { total: 1, passed: 1, failed: 0 } });
      expect(report.acceptanceReceipt?.checkedPayloadDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(report.artifactManifest?.binding).toMatchObject({ scope: "candidate-snapshot", disposition: changed ? "promoted" : "unchanged", receiptId: report.acceptanceReceipt?.id });
    } finally { await candidate.cleanup(); }
  }
});

it("refuses a custom runner that cannot attest each actual protected-input execution", async () => {
  const root = await project(); await writeFile(join(root, "check.mjs"), "test");
  const candidate = await createCandidateIntegration(root, { checkInputs: ["check.mjs"] });
  try {
    await writeFile(join(candidate.dir, "a.txt"), "candidate");
    const report = await candidate.finish({ rows, contract: { ...contract, checkInputs: ["check.mjs"] }, signal, runChecks: pass });
    expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/custom check runner/);
    expect(report.acceptanceReceipt).toMatchObject({ checkScope: "declared", checkStatus: "unverified", inputs: { declared: 1, verified: 0 } });
  } finally { await candidate.cleanup(); }
});

it("leaves actual protected-input integrity unknown when cancellation prevents its completion", async () => {
  const root = await project(); await writeFile(join(root, "check.mjs"), "test");
  const candidate = await createCandidateIntegration(root, { checkInputs: ["check.mjs"] });
  const controller = new AbortController();
  try {
    await writeFile(join(candidate.dir, "a.txt"), "candidate");
    const runner = Object.assign(async () => { controller.abort(); return { ok: false, results: [{ ok: false }] }; }, { supportsInputIntegrity: true as const });
    const report = await candidate.finish({ rows, contract: { ...contract, checkInputs: ["check.mjs"] }, signal: controller.signal, runChecks: runner });
    expect(report.status).toBe("rejected");
    expect(report.acceptanceReceipt).toMatchObject({ checkScope: "declared", inputs: { declared: 1, verified: 0 }, reason: "interrupted" });
  } finally { await candidate.cleanup(); }
});

it("rejects mutation of otherwise unchanged project code during final checks", async () => {
  const root = await project(); await writeFile(join(root, "unchanged.js"), "before");
  const candidate = await createCandidateIntegration(root);
  try {
    await writeFile(join(candidate.dir, "a.txt"), "candidate");
    const report = await candidate.finish({ rows, contract, signal, runChecks: async () => { await writeFile(join(candidate.dir, "unchanged.js"), "after"); return pass(); } });
    expect(report.status).toBe("rejected"); expect(await readFile(join(root, "unchanged.js"), "utf8")).toBe("before");
  } finally { await candidate.cleanup(); }
});
