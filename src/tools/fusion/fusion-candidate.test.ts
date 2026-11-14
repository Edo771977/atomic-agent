import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../config/index.js";
import { USER_CONFIG_VERSION } from "../../config/config-schema.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalRulesStore } from "../../approval/approval-rules-store.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { buildOsFsWriteTool } from "../os/fs/fs-write.js";
import { DeclaredInputsRegistry } from "../os/fs/fs-declared-inputs.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(over: Partial<FusionDelegateDeps> = {}, candidate = true) {
  const root = await mkdtemp(join(tmpdir(), "atag-fanout-candidate-")); roots.push(root);
  await writeFile(join(root, "api.json"), '{"name":"before"}');
  await writeFile(join(root, "personal.txt"), "untracked personal bytes\r\n");
  const policies = vi.fn(); const starts = vi.fn();
  const mode = { stored: "fusion", effective: "fusion", orchestratorProviderId: "cloud", orchestratorModel: "strong", workerProviderId: "worker", workerModel: "small", workers: 1, workerMaxSteps: 7, workerTimeoutMs: 60_000, primaryProviderId: "cloud", degraded: null, ...(candidate ? { integration: "candidate" } : {}) } as ResolvedRunMode;
  const store = new FusionRunStore({ dir: join(root, "..", `${root.split(/[\\/]/).at(-1)}-checkpoints`) });
  roots.push(join(root, "..", `${root.split(/[\\/]/).at(-1)}-checkpoints`));
  const start = store.start.bind(store); vi.spyOn(store, "start").mockImplementation(input => { starts(input); return start(input); });
  const deps: FusionDelegateDeps = {
    workingDir: root, approvalRequired: false, runCheckpoints: store,
    approvals: { setSessionPolicy: policies, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    createEphemeralSession: (meta, dir) => createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${meta.taskId}`, workingDir: dir ?? root, metadata: { fusionWorker: meta } }),
    runTurn: async session => ({ session, reason: "reply", stepCount: 1 }),
    emitEvent: () => {}, slotManager: { poolSize: () => 4 }, resolveRunMode: () => mode,
    workerSupportsSlotAffinity: () => false, warmWorkerBackend: async () => {}, outputCharCap: 4000,
    logger: new StructuredLogger({ level: "error", sinks: [] }),
    ...over,
  };
  return { root, policies, starts, deps, ctx: { workingDir: root, sessionId: "candidate-parent", stepIndex: 0, signal: new AbortController().signal } };
}
const tasks = [{ id: "api", instructions: "Change API" }, { id: "consumer", instructions: "Change consumer" }];
const contract = { checks: [{ kind: "command", command: "integration" }] };

it("requested candidate rejects cross-file mismatch without publishing either individually valid file", async () => {
  const f = await fixture(); const cwd: string[] = [];
  f.deps.runTurn = async session => {
    cwd.push(session.workingDir);
    const api = session.id === `${FUSION_WORKER_ID_PREFIX}api`;
    await writeFile(join(session.workingDir, api ? "api.json" : "consumer.json"), api ? '{"name":"after"}' : '{"requires":"before"}');
    return { session, reason: "reply", stepCount: 1 };
  };
  f.deps.runChecks = async (_, ctx) => {
    const api = JSON.parse(await readFile(join(ctx.workingDir, "api.json"), "utf8"));
    const consumer = JSON.parse(await readFile(join(ctx.workingDir, "consumer.json"), "utf8"));
    return { ok: api.name === consumer.requires, results: [{ ok: api.name === consumer.requires }] };
  };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks, contract }, f.ctx);
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}');
  await expect(readFile(join(f.root, "consumer.json"))).rejects.toThrow();
  expect(cwd.every(dir => dir !== f.root)).toBe(true); expect(new Set(cwd).size).toBe(1);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", nonResumable: true, patch: { method: "git" } });
  expect(result.status).toBe("error"); expect(result.details.runId).toBeUndefined(); expect(f.starts).not.toHaveBeenCalled();
});

it("promotes the final checked fanout and preserves original rules and dirty files", async () => {
  const f = await fixture(); const checked: string[] = [];
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), '{"name":"after"}'); return { session, reason: "reply", stepCount: 1 }; };
  f.deps.runChecks = async (_, ctx) => { checked.push(ctx.workingDir); return { ok: (await readFile(join(ctx.workingDir, "api.json"), "utf8")).includes("after"), results: [{ ok: true }] }; };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [tasks[0]], contract }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "promoted", nonResumable: true });
  expect(result.summary.startsWith("artifact-evidence: ")).toBe(true);
  const evidence = JSON.parse(result.summary.split("\n")[0]!.slice("artifact-evidence: ".length));
  expect(evidence.candidate).toMatchObject({ scope: "candidate-snapshot", disposition: "promoted", receipt: { disposition: "promoted", checkStatus: "passed" } });
  expect(result.summary.length).toBeLessThanOrEqual(f.deps.outputCharCap);
  expect(checked.every(dir => dir !== f.root)).toBe(true);
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"after"}');
  expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("untracked personal bytes\r\n");
  expect(f.policies).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ onPrompt: "refuse", ruleWorkdir: f.root }));
  expect(f.starts).not.toHaveBeenCalled(); expect(result.details.runId).toBeUndefined();
});

it("keeps rejected no-check output as a patch and refuses resume without dispatch", async () => {
  const f = await fixture(); const run = vi.fn(async (session: SessionState) => { await writeFile(join(session.workingDir, "api.json"), "unfinished"); return { session, reason: "reply", stepCount: 1 } as RunTurnResult; });
  f.deps.runTurn = run;
  const tool = buildFusionDelegateTool(f.deps); const result = await tool.run({ tasks: [tasks[0]] }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringMatching(/integration check/) });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}');
  run.mockClear(); const resumed = await tool.run({ resume: "run-unused" }, f.ctx);
  expect(resumed.details.reason).toBe("candidate-nonresumable"); expect(run).not.toHaveBeenCalled();
});

it("holds passing output when the user changes the original during execution", async () => {
  const f = await fixture();
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); await writeFile(join(f.root, "personal.txt"), "new user edit"); return { session, reason: "reply", stepCount: 1 }; };
  f.deps.runChecks = async () => ({ ok: true, results: [{ ok: true }] });
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [tasks[0]], contract }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringMatching(/original project changed/) });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}'); expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("new user edit");
});

it("preserves direct integration as the default", async () => {
  const f = await fixture({}, false);
  f.deps.runTurn = async session => { expect(session.workingDir).toBe(f.root); await writeFile(join(session.workingDir, "api.json"), "direct"); return { session, reason: "reply", stepCount: 1 }; };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [tasks[0]] }, f.ctx);
  expect(result.details.candidateIntegration).toBeUndefined(); expect(await readFile(join(f.root, "api.json"), "utf8")).toBe("direct");
});

it.each([
  ["relative", "delete"], ["absolute", "delete"],
  ["relative", "shrink"], ["absolute", "shrink"],
] as const)("protects a %s declared input from a worker's filesystem %s at final promotion", async (spelling, mutation) => {
  const f = await fixture(); const original = "one\ntwo\nthree\nfour\nfive\nsix\n";
  await writeFile(join(f.root, "personal.txt"), original);
  f.deps.runTurn = async session => {
    if (mutation === "delete") await rm(join(session.workingDir, "personal.txt"));
    else await writeFile(join(session.workingDir, "personal.txt"), "replacement\n");
    return { session, reason: "reply", stepCount: 1 };
  };
  f.deps.runChecks = async () => ({ ok: true, results: [{ ok: true }] });
  const result = await buildFusionDelegateTool(f.deps).run({
    tasks: [tasks[0]],
    contract: { ...contract, inputs: [spelling === "absolute" ? join(f.root, "personal.txt") : "personal.txt"] },
  }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringMatching(/declared input personal.txt/) });
  expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe(original);
});

it.each(["relative", "absolute"] as const)("enforces original saved path denies and %s declared inputs on actual candidate file tools", async spelling => {
  const f = await fixture(); const stateDir = await mkdtemp(join(tmpdir(), "atag-candidate-rules-")); roots.push(stateDir);
  const candidateTemp = join(stateDir, "candidate{literal}"); await mkdir(candidateTemp);
  const gate = new ApprovalGate({ emit: () => { throw new Error("worker must never prompt"); }, level: 5 });
  const rules = new ApprovalRulesStore({ stateDir }); gate.setRules(rules);
  rules.add({ decision: "deny", path: join(f.root, "protected"), project: f.root, source: "user" });
  const inputs = new DeclaredInputsRegistry();
  f.deps.approvals = gate; f.deps.declaredInputs = inputs;
  const write = buildOsFsWriteTool({ approvals: gate, approvalRequired: true, declaredInputs: inputs });
  let deniedByRule = false, refusedInput = false, candidateInput = "";
  f.deps.runTurn = async session => {
    const ctx = { ...f.ctx, sessionId: session.id, workingDir: session.workingDir };
    try { await write.run({ path: "protected/out.txt", content: "must not land" }, ctx); }
    catch (err) { deniedByRule = err instanceof Error && /blocked by your rule/.test(err.message); }
    refusedInput = (await write.run({ path: "personal.txt", content: "replacement" }, ctx)).status === "error";
    candidateInput = await readFile(join(session.workingDir, "personal.txt"), "utf8");
    return { session, reason: "reply", stepCount: 1 };
  };
  f.deps.runChecks = async () => ({ ok: true, results: [{ ok: true }] });
  // Force literal glob characters into the generated prefix on every host.
  for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, candidateTemp);
  try {
    await buildFusionDelegateTool(f.deps).run({ tasks: [tasks[0]], contract: { ...contract, inputs: [spelling === "absolute" ? join(f.root, "personal.txt") : "personal.txt"] } }, f.ctx);
  } finally { vi.unstubAllEnvs(); }
  expect(deniedByRule).toBe(true); expect(refusedInput).toBe(true); expect(candidateInput).toBe("untracked personal bytes\r\n");
  await expect(readFile(join(f.root, "protected", "out.txt"))).rejects.toThrow();
  expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("untracked personal bytes\r\n");
});

it.each(["relative", "absolute"] as const)("keeps a genuine %s input glob advisory at dispatch and promotion", async spelling => {
  const f = await fixture(); const gate = new ApprovalGate({ level: 5, emit: () => { throw new Error("worker must not prompt"); } });
  const inputs = new DeclaredInputsRegistry(); f.deps.approvals = gate; f.deps.declaredInputs = inputs;
  const write = buildOsFsWriteTool({ approvals: gate, approvalRequired: true, declaredInputs: inputs }); let status: string | undefined;
  f.deps.runTurn = async session => {
    status = (await write.run({ path: "personal.txt", content: "updated\n" }, { ...f.ctx, sessionId: session.id, workingDir: session.workingDir })).status;
    return { session, reason: "reply", stepCount: 1 };
  };
  f.deps.runChecks = async () => ({ ok: true, results: [{ ok: true }] });
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [tasks[0]], contract: { ...contract, inputs: [spelling === "absolute" ? join(f.root, "*.txt") : "*.txt"] } }, f.ctx);
  expect(status).toBe("ok"); expect(result.details.candidateIntegration).toMatchObject({ status: "promoted" });
  expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("updated\n");
});

it.each([
  ["basename", "delete"], ["basename", "shrink"], ["basename", "fswrite"],
  ["whole path", "delete"], ["whole path", "shrink"], ["whole path", "fswrite"],
] as const)("uses native case identity for the %s of absolute declared inputs during %s", async (spelling, mutation) => {
  const f = await fixture(); const original = "one\ntwo\nthree\nfour\nfive\nsix\n";
  await writeFile(join(f.root, "personal.txt"), original);
  const gate = new ApprovalGate({ level: 5, emit: () => { throw new Error("worker must not prompt"); } });
  const inputs = new DeclaredInputsRegistry(); f.deps.approvals = gate; f.deps.declaredInputs = inputs;
  const write = buildOsFsWriteTool({ approvals: gate, approvalRequired: true, declaredInputs: inputs }); let writeStatus: string | undefined;
  f.deps.runTurn = async session => {
    if (mutation === "delete") await rm(join(session.workingDir, "personal.txt"));
    else if (mutation === "shrink") await writeFile(join(session.workingDir, "personal.txt"), "updated\n");
    else writeStatus = (await write.run({ path: "personal.txt", content: "updated\n" }, { ...f.ctx, sessionId: session.id, workingDir: session.workingDir })).status;
    return { session, reason: "reply", stepCount: 1 };
  };
  f.deps.runChecks = async () => ({ ok: true, results: [{ ok: true }] });
  const declared = spelling === "whole path" ? join(f.root, "personal.txt").toUpperCase() : join(f.root, "PERSONAL.TXT");
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [tasks[0]], contract: { ...contract, inputs: [declared] } }, f.ctx);
  if (process.platform === "win32") {
    if (mutation === "fswrite") expect(writeStatus).toBe("error");
    else expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringMatching(/declared input personal.txt/) });
    expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe(original);
  } else {
    // On a case-sensitive platform PERSONAL.TXT denotes a different input.
    if (mutation === "fswrite") expect(writeStatus).toBe("ok");
    expect(result.details.candidateIntegration).toMatchObject({ status: "promoted" });
    if (mutation === "delete") await expect(readFile(join(f.root, "personal.txt"))).rejects.toThrow();
    else expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("updated\n");
  }
});

it("never releases dependents of a no_changes provider in candidate mode", async () => {
  const ran: string[] = [];
  const f = await fixture({
    runTurn: async session => {
      ran.push(session.id);
      // The candidate copy's fresh mtime would read as a change: restore an untouched stamp.
      const old = new Date(Date.now() - 3_600_000); await utimes(join(session.workingDir, "core.js"), old, old);
      return { session, reason: "reply", stepCount: 1 };
    },
    syntaxCheck: async files => ({ results: files.map(file => ({ file, ok: true, checker: "javascript" as const })) }),
    runChecks: async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) }),
  });
  await writeFile(join(f.root, "core.js"), "export const core = 1;");
  const result = await buildFusionDelegateTool(f.deps).run({
    tasks: [{ id: "core", instructions: "provide core", files: ["core.js"] }, { id: "ui", instructions: "use core" }],
    contract: { ...contract, provides: [{ task: "core", kind: "file", name: "core.js" }], requires: [{ task: "ui", name: "core.js" }], checks: [...contract.checks, { kind: "command", command: "core-check", task: "core" }] },
  }, f.ctx);
  expect((result.details.tasks as { id: string; status: string }[])[0]!.status).toBe("no_changes");
  expect(ran).toEqual([`${FUSION_WORKER_ID_PREFIX}core`]);
  expect((result.details.candidateIntegration as { status: string }).status).toBe("rejected");
});

it.each(["relative", "absolute"] as const)("freezes %s checkInputs from the original before dispatch", async spelling => {
  const f = await fixture(); await writeFile(join(f.root, "check.mjs"), "expected=good\nline2\nline3\nline4\nline5\n");
  f.deps.runChecks = (await import("../verify/run-verify.js")).runChecks;
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "bad"); await writeFile(join(session.workingDir, "check.mjs"), "expected=evil\nline2\nline3\nline4\nline5\n"); return { session, reason: "reply", stepCount: 1 }; };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract: { ...contract, checkInputs: [spelling === "relative" ? "check.mjs" : join(f.root, "check.mjs")] } }, f.ctx);
  expect(result.details.candidateIntegration, result.summary).toMatchObject({ status: "rejected", acceptanceReceipt: { disposition: "rejected", checkScope: "declared", inputs: { declared: 1, verified: 0 }, reason: "check-inputs-changed" } });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}');
  expect(await readFile(join(f.root, "check.mjs"), "utf8")).toContain("expected=good");
});

it("refuses protected checkInputs in direct mode before starting a worker", async () => {
  const runTurn = vi.fn(); const f = await fixture({ runTurn }, false);
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work" }], contract: { ...contract, checkInputs: ["check.mjs"] } }, f.ctx);
  expect(result.details.reason).toBe("check-inputs-require-candidate"); expect(runTurn).not.toHaveBeenCalled();
});

it.each([true, false])("records executed candidate task telemetry after final promotion decision (pass=%s)", async passing => {
  const append = vi.fn(); const f = await fixture({ outcomeLog: { append } });
  f.deps.runChecks = async specs => ({ ok: passing, results: specs.map(() => ({ ok: passing })) });
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
  expect(append).toHaveBeenCalledTimes(1);
  expect(append.mock.calls[0]![0]).toEqual([expect.objectContaining({ type: "task", candidate: expect.objectContaining({ receipt: expect.objectContaining({ disposition: passing ? "promoted" : "rejected" }) }) })]);
});

it("retains recovery and executed task telemetry when post-worker completion handling throws", async () => {
  const append = vi.fn(); const f = await fixture({ outcomeLog: { append }, emitEvent: (_, event) => { if (event.type === "fusion_worker" && event.taskId === "fusion.delegate" && event.phase === "finished") throw new Error("injected observer failure"); } });
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  f.deps.runChecks = async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) });
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", patch: { path: expect.any(String) } });
  expect(append).toHaveBeenCalledTimes(1);
  expect(append.mock.calls[0]![0]).toEqual([expect.objectContaining({ candidate: { receipt: expect.objectContaining({ disposition: "rejected", reason: "interrupted" }), taskChecks: { total: 0, passed: 0, failed: 0 }, workerRuns: 1 } })]);
});

it.each(["persistent", "restored"] as const)("rejects protected check input writes inside the actual verify execution copy (%s)", async mutation => {
  const { runChecks } = await import("../verify/run-verify.js");
  const f = await fixture({ runChecks });
  const original = `import {readFileSync} from 'node:fs'; if (readFileSync('api.json','utf8') !== '{"name":"before"}') throw new Error('bad artifact');`;
  await writeFile(join(f.root, "check.mjs"), original);
  f.deps.runTurn = async session => {
    await writeFile(join(session.workingDir, "api.json"), "bad");
    await writeFile(join(session.workingDir, "runner.mjs"), `import {readFileSync,writeFileSync} from 'node:fs'; const original=readFileSync('check.mjs','utf8'); writeFileSync('check.mjs','export {};'); await import('./check.mjs'); ${mutation === "restored" ? "writeFileSync('check.mjs',original);" : ""}`);
    return { session, reason: "reply", stepCount: 1 };
  };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json", "runner.mjs"] }], contract: { checkInputs: ["check.mjs"], checks: [{ kind: "command", cmd: process.execPath, args: ["runner.mjs"], network: true }] } }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", acceptanceReceipt: { disposition: "rejected", checkScope: "declared", inputs: { declared: 1, verified: 0 } } });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}'); expect(await readFile(join(f.root, "check.mjs"), "utf8")).toBe(original);
});

it.each([true, false])("masks configured known secrets before bounding public artifact output (candidate=%s)", async candidate => {
  const secret = "configuredOpaqueValueWithoutVendorShape0123456789";
  const f = await fixture({ knownSecrets: () => [{ label: "configured-test", value: secret }] }, candidate);
  f.deps.runChecks = async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) });
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", title: `title ${secret}`, instructions: "work", files: ["api.json"] }], contract }, f.ctx);
  expect(result.summary).not.toContain(secret.slice(0, 12)); expect(result.fullOutput).not.toContain(secret.slice(0, 12));
  expect(result.summary.length).toBeLessThanOrEqual(f.deps.outputCharCap); expect((result.fullOutput ?? "").length).toBeLessThanOrEqual(f.deps.outputCharCap);
  expect(result.summary.startsWith("artifact-evidence: ")).toBe(true);
});

it("reports one candidate task run with two completed worker invocations after a judge retry", async () => {
  const append = vi.fn(); const f = await fixture({ outcomeLog: { append } });
  const base = f.deps.resolveRunMode(); f.deps.resolveRunMode = () => ({ ...base, judge: { providerId: "cloud", model: "strong" } });
  let turns = 0, judged = 0;
  f.deps.runTurn = async session => { turns += 1; await writeFile(join(session.workingDir, "api.json"), `attempt ${turns}`); return { session, reason: "reply", stepCount: 1 }; };
  f.deps.runChecks = async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) });
  f.deps.escalationComplete = async () => ({ content: JSON.stringify({ items: [{ id: "a2", pass: ++judged > 1, why: "verdict" }] }) });
  await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
  expect(turns).toBe(2); expect(append).toHaveBeenCalledTimes(1);
  const records = append.mock.calls[0]![0];
  expect(records).toEqual([expect.objectContaining({ judgeRetried: true, candidate: expect.objectContaining({ workerRuns: 2 }) })]);
  const { aggregateOutcomes } = await import("./outcome-report.js");
  const report = aggregateOutcomes(records);
  expect(report.workers[0]).toMatchObject({ checksPassed: 0, candidate: { taskRuns: 1, knownWorkerRuns: 2, workerRunsUnverified: 0 } });
});

it("keeps absolute check-generated snapshots inside the execution copy without checkInputs", async () => {
  const { runChecks } = await import("../verify/run-verify.js");
  const f = await fixture({ runChecks });
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }],
    contract: { checks: [{ kind: "command", cmd: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'generated snapshot')", join(f.root, "snapshot.txt")], network: true }] } }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "promoted", acceptanceReceipt: { checkScope: "declared", checkStatus: "passed" } });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe("candidate");
  await expect(readFile(join(f.root, "snapshot.txt"))).rejects.toThrow();
});
it("refuses a normalized project alias in a check before dispatching workers", async () => {
  const runTurn = vi.fn(async (session: SessionState): Promise<RunTurnResult> => ({ session, reason: "reply", stepCount: 1 }));
  const f = await fixture({ runTurn, runChecks: async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) }) });
  const alias = f.root.replace(/\\/g, "/").replace(/\/([^/]+)$/, "/./$1") + "/check.mjs";
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work" }],
    contract: { checks: [{ kind: "command", cmd: process.execPath, args: [alias] }] } }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringContaining("unsupported absolute project reference") });
  expect(runTurn).not.toHaveBeenCalled();
});
it.each(["dist", "node_modules"])("privately verifies a protected input under excluded %s with the built-in runner", async folder => {
  const { runChecks } = await import("../verify/run-verify.js");
  const f = await fixture({ runChecks });
  await mkdir(join(f.root, folder));
  await writeFile(join(f.root, folder, "check.mjs"), "import{readFileSync}from'node:fs';if(readFileSync('api.json','utf8')!=='candidate')process.exit(1)");
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }],
    contract: { checkInputs: [`${folder}/check.mjs`], checks: [{ kind: "command", cmd: process.execPath, args: [`${folder}/check.mjs`], network: true }] } }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "promoted", acceptanceReceipt: { checkScope: "protected-declared", checkStatus: "passed", inputs: { declared: 1, verified: 1 } } });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe("candidate");
});

it("binds an absolute protected check reference to the actual execution copy", async () => {
  const { runChecks } = await import("../verify/run-verify.js"); const f = await fixture({ runChecks });
  const original = `import {readFileSync} from 'node:fs'; if (readFileSync('api.json','utf8') !== '{"name":"before"}') throw new Error('bad artifact');`;
  await writeFile(join(f.root, "check.mjs"), original);
  f.deps.runTurn = async session => {
    await writeFile(join(session.workingDir, "api.json"), "bad");
    await writeFile(join(session.workingDir, "runner.mjs"), `import {readFileSync,writeFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; const file=process.argv[2]; const original=readFileSync(file,'utf8'); writeFileSync(file,'export {};'); await import(pathToFileURL(file).href); writeFileSync(file,original);`);
    return { session, reason: "reply", stepCount: 1 };
  };
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json", "runner.mjs"] }], contract: { checkInputs: ["check.mjs"], checks: [{ kind: "command", cmd: process.execPath, args: ["runner.mjs", join(f.root, "check.mjs")], network: true }] } }, f.ctx);
  expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", acceptanceReceipt: { checkScope: "declared", inputs: { declared: 1, verified: 0 } } });
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}');
});

it.each([true, false])("preserves terminal candidate disposition when post-decision secret metadata fails (pass=%s)", async passing => {
  let decisionLogged = false, failedCollections = 0;
  const append = vi.fn((_rows: readonly unknown[]) => { decisionLogged = true; });
  const f = await fixture({ outcomeLog: { append }, knownSecrets: () => { if (decisionLogged) { failedCollections += 1; throw new Error("PRIVATE-METADATA-FAILURE"); } return []; } });
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  f.deps.runChecks = async specs => ({ ok: passing, results: specs.map(() => ({ ok: passing })) });
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
  expect(result.status).toBe(passing ? "ok" : "error");
  expect(result.details).toMatchObject({ metadataUnavailable: true, candidateIntegration: { status: passing ? "promoted" : "rejected", nonResumable: true } });
  expect(append).toHaveBeenCalledTimes(1); expect(failedCollections).toBe(1);
  expect(append.mock.calls[0]![0]).toEqual([expect.objectContaining({ candidate: expect.objectContaining({ receipt: expect.objectContaining({ disposition: passing ? "promoted" : "rejected" }) }) })]);
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe(passing ? "candidate" : '{"name":"before"}');
  expect(JSON.stringify(result)).not.toContain("PRIVATE-METADATA-FAILURE"); expect(JSON.stringify(result)).not.toContain(f.root);
});

it("refuses unsafe metadata once when the secret collector fails before the candidate decision", async () => {
  let calls = 0;
  const f = await fixture({ knownSecrets: () => { calls += 1; throw new Error("PRIVATE-COLLECTOR-ERROR"); } });
  f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), "candidate"); return { session, reason: "reply", stepCount: 1 }; };
  f.deps.runChecks = async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) });
  const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
  expect(result.status).toBe("error"); expect(result.details).toMatchObject({ metadataUnavailable: true, candidateIntegration: { status: "rejected" } });
  expect(calls).toBe(1); expect(JSON.stringify(result)).not.toContain("PRIVATE-COLLECTOR-ERROR");
  expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}');
});

describe("the configured copy limit (`tools.verify.maxCopyBytes`)", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "atag-fanout-copy-limit-state-"));
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ version: USER_CONFIG_VERSION, tools: { verify: { maxCopyBytes: 8 } } }));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });
  afterEach(async () => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("refuses candidate staging when the project exceeds a smaller configured limit", async () => {
    const f = await fixture();
    const run = vi.fn(async (session: SessionState): Promise<RunTurnResult> => ({ session, reason: "reply", stepCount: 1 }));
    f.deps.runTurn = run;
    const result = await buildFusionDelegateTool(f.deps).run({ tasks, contract }, f.ctx);
    expect(result.details.reason).toBe("candidate-staging-failed");
    expect(result.summary).toContain("candidate workspace unavailable: the folder is too large to copy");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses worktree isolation when the project exceeds a smaller configured limit", async () => {
    const f = await fixture({}, false);
    const mode = { ...f.deps.resolveRunMode(), isolation: "worktree" } as ResolvedRunMode;
    f.deps.resolveRunMode = () => mode;
    const run = vi.fn(async (session: SessionState): Promise<RunTurnResult> => ({ session, reason: "reply", stepCount: 1 }));
    f.deps.runTurn = run;
    const result = await buildFusionDelegateTool(f.deps).run({ tasks }, f.ctx);
    expect(run).not.toHaveBeenCalled();
    expect((result.details.tasks as Array<{ error?: string }>)[0]!.error).toBe("not started: could not create a private workspace: the folder is too large to copy");
  });

  it("charges final frozen-check staging to the configured candidate budget that remains", async () => {
    const f = await fixture();
    const bytes = Buffer.byteLength(await readFile(join(f.root, "api.json"), "utf8")) + Buffer.byteLength(await readFile(join(f.root, "personal.txt"), "utf8"));
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ version: USER_CONFIG_VERSION, tools: { verify: { maxCopyBytes: bytes * 3 } } }));
    resetConfigCache();
    f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), '{"name":"after!"}'); return { session, reason: "reply", stepCount: 1 }; };
    f.deps.runChecks = async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) });
    const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
    expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringMatching(/remaining candidate copy budget/) });
    expect(await readFile(join(f.root, "api.json"), "utf8")).toBe('{"name":"before"}');
  });

  it("retains the dependency-copy refusal cause when final checked staging exhausts its remaining budget", async () => {
    const f = await fixture();
    const bytes = Buffer.byteLength(await readFile(join(f.root, "api.json"), "utf8")) + Buffer.byteLength(await readFile(join(f.root, "personal.txt"), "utf8"));
    await mkdir(join(f.root, "node_modules")); await writeFile(join(f.root, "node_modules", "dependency.js"), "x".repeat(100));
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ version: USER_CONFIG_VERSION, tools: { verify: { maxCopyBytes: bytes * 4 + 150 } } }));
    resetConfigCache();
    f.deps.runTurn = async session => { await writeFile(join(session.workingDir, "api.json"), '{"name":"after!"}'); return { session, reason: "reply", stepCount: 1 }; };
    f.deps.runChecks = async specs => ({ ok: true, results: specs.map(() => ({ ok: true })) });
    const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work", files: ["api.json"] }], contract }, f.ctx);
    expect(result.details.candidateIntegration).toMatchObject({ status: "rejected", reason: expect.stringMatching(/remaining candidate copy budget.*private copy of the dependency folders/) });
  });
  it("refuses a known minimum final dependency-copy cost before workers with honest budget context", async () => {
    const runTurn = vi.fn(async (session: SessionState): Promise<RunTurnResult> => ({ session, reason: "reply", stepCount: 1 }));
    const f = await fixture({ runTurn });
    await mkdir(join(f.root, "node_modules"));
    await writeFile(join(f.root, "node_modules", "dependency.js"), "x".repeat(6_000));
    await writeFile(join(stateDir, "config.json"), JSON.stringify({ version: USER_CONFIG_VERSION, tools: { verify: { maxCopyBytes: 10_000 } } }));
    resetConfigCache();
    const result = await buildFusionDelegateTool(f.deps).run({ tasks: [{ id: "api", instructions: "work" }], contract }, f.ctx);
    expect(result.details.reason).toBe("candidate-staging-failed");
    expect(result.summary).toMatch(/configured 10000 bytes; spent \d+ bytes; remaining \d+ bytes; minimum additional 6000 bytes/);
    expect(runTurn).not.toHaveBeenCalled();
  });
});
