import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
