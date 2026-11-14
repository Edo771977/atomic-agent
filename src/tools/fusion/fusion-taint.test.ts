import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";

/**
 * Review after outside content through delegation (`agent.taintReview`):
 * a fan-out must not be the way round the hold, in either direction.
 */

const logger = new StructuredLogger({ level: "error", sinks: [] });

const MODE: ResolvedRunMode = {
  stored: "fusion",
  effective: "fusion",
  orchestratorProviderId: "openrouter",
  orchestratorModel: "big",
  workerProviderId: "local-llama",
  workerModel: "small",
  workers: 1,
  workersPinned: true,
  workerMaxSteps: 7,
  workerTimeoutMs: 60_000,
  primaryProviderId: "openrouter",
  degraded: null,
};

const TASKS = [{ id: "t1", title: "One", instructions: "Write /repo/src/a.js" }];

function ctx(): ToolContext {
  return { workingDir: "/repo", sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal };
}

function setup(level: 1 | 4, onWorker: (workerId: string, gate: ApprovalGate) => void) {
  const prompts: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level,
    emit: (req) => {
      prompts.push(req);
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
    },
  });
  gate.setTaintReview(() => true);
  let minted = 0;
  const workers: string[] = [];
  const deps: FusionDelegateDeps = {
    runTurn: async (session): Promise<RunTurnResult> => {
      workers.push(session.id);
      onWorker(session.id, gate);
      return { session, reason: "reply", stepCount: 1 };
    },
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: gate,
    approvalRequired: true,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => MODE,
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
  };
  return { gate, prompts, workers, tool: buildFusionDelegateTool(deps) };
}

describe("fusion.delegate and the review after outside content", () => {
  it("asks for a fan-out after outside content at level 4, and holds the worker too", async () => {
    const held: boolean[] = [];
    const { gate, prompts, workers, tool } = setup(4, (id, g) => {
      held.push(g.holdsForOutsideContent(id, "shell"));
    });
    gate.noteUntrustedContent("s-parent", "a web page");
    await tool.run({ tasks: TASKS }, ctx());
    expect(prompts.map((p) => p.category)).toEqual(["fusion_fanout"]);
    expect(prompts[0]!.riskNote).toContain("a web page");
    expect(workers).toHaveLength(1);
    expect(held).toEqual([true]);
    // Disarmed: the link went with the worker.
    expect(gate.holdsForOutsideContent(workers[0]!, "shell")).toBe(false);
  });

  it("marks the orchestrator when its worker read outside content", async () => {
    const { gate, tool } = setup(4, (id, g) => g.noteUntrustedContent(id, "a web page"));
    expect(gate.holdsForOutsideContent("s-parent", "http")).toBe(false);
    await tool.run({ tasks: TASKS }, ctx());
    expect(gate.holdsForOutsideContent("s-parent", "http")).toBe(true);
  });

  it("does not let the turn's standing yes cover a fan-out after outside content", async () => {
    const { gate, prompts, tool } = setup(1, () => {});
    await tool.run({ tasks: TASKS }, ctx());
    await tool.run({ tasks: TASKS }, ctx());
    expect(prompts).toHaveLength(1);
    gate.noteUntrustedContent("s-parent", "a web page");
    await tool.run({ tasks: TASKS }, ctx());
    expect(prompts).toHaveLength(2);
  });
});

/**
 * The orchestrator's declared `contract.checks` run code a tainted worker
 * may have written (a test file): after outside content they are put to
 * the gate as individually described `shell` requests, before each complete batch
 * runs (`contract-check-hold.ts`).
 */
describe("fusion.delegate contract checks after outside content", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function checksSetup(options: {
    taintReview?: boolean;
    answerChecks?: boolean;
    /** Called instead of answering a check request (it stays pending). */
    onCheckPrompt?: (req: ApprovalRequest) => void;
    onWorker?: (workerId: string, taskId: string, gate: ApprovalGate, dir: string) => void;
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "fusion-taint-checks-"));
    dirs.push(dir);
    const prompts: ApprovalRequest[] = [];
    const gate: ApprovalGate = new ApprovalGate({
      level: 4,
      emit: (req) => {
        prompts.push(req);
        if (req.category === "shell" && options.onCheckPrompt !== undefined) {
          options.onCheckPrompt(req);
          return;
        }
        const approved = req.category === "shell" ? options.answerChecks ?? false : true;
        queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved }));
      },
    });
    gate.setTaintReview(() => options.taintReview ?? true);
    let minted = 0;
    const checkRuns: (readonly Record<string, unknown>[])[] = [];
    const runChecks = vi.fn(async (specs: readonly Record<string, unknown>[]) => {
      checkRuns.push(specs);
      return { ok: true, results: specs.map(() => ({ ok: true })) };
    });
    const deps: FusionDelegateDeps = {
      runTurn: async (session, _brief, turn): Promise<RunTurnResult> => {
        const taskId = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
        options.onWorker?.(session.id, taskId, gate, dir);
        if (taskId === "core") {
          writeFileSync(join(dir, "core.js"), "export const core = 1;\n");
          turn.eventHook?.({ type: "llm_event", event: { type: "tool_call_executed", result: { tool: "os.fs.write", status: "ok", summary: "written", details: { path: join(dir, "core.js"), existed: false, addedLines: 1, removedLines: 0 }, truncated: false }, batchIndex: 0, batchSize: 1 } });
        }
        return { session, reason: "reply", stepCount: 1 };
      },
      createEphemeralSession: (meta, workingDir) => {
        minted += 1;
        return createEmptySessionState({
          id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
          workingDir: workingDir ?? dir,
          metadata: { fusionWorker: { ...meta } },
        });
      },
      approvals: gate,
      approvalRequired: true,
      emitEvent: () => {},
      workingDir: dir,
      slotManager: { poolSize: () => 4 },
      resolveRunMode: () => MODE,
      workerSupportsSlotAffinity: () => true,
      warmWorkerBackend: async () => {},
      outputCharCap: 4000,
      logger,
      runChecks,
    };
    const run = (args: Record<string, unknown>, signal = new AbortController().signal) =>
      buildFusionDelegateTool(deps).run(args, { workingDir: dir, sessionId: "s-parent", stepIndex: 0, signal });
    return { gate, prompts, runChecks, checkRuns, run, dir };
  }

  const oneTask = {
    tasks: [{ id: "core", title: "Core", instructions: "Write core.js" }],
    contract: { checks: [{ kind: "command", cmd: "npm", args: ["test"] }] },
  };

  it("asks once as shell before the checks and runs nothing on a no", async () => {
    const f = checksSetup();
    f.gate.noteUntrustedContent("s-parent", "a web page");
    const result = await f.run(oneTask);
    const checkPrompts = f.prompts.filter((p) => p.category === "shell");
    expect(checkPrompts).toHaveLength(1);
    expect(checkPrompts[0]!.tool).toBe("verify.run");
    expect(`${checkPrompts[0]!.reason}\n${checkPrompts[0]!.preview ?? ""}`).toContain("npm test");
    expect(checkPrompts[0]!.riskNote).toContain("a web page");
    expect(f.runChecks).not.toHaveBeenCalled();
    expect(result.summary).toContain("contract checks held after outside content: not run");
    const rows = result.details.tasks as { status: string; notes?: string[] }[];
    expect(rows[0]!.status).toBe("ok");
  });

  it("notes a held task check on its row, keeping its status", async () => {
    const f = checksSetup();
    f.gate.noteUntrustedContent("s-parent", "a web page");
    const result = await f.run({
      tasks: oneTask.tasks,
      contract: { checks: [{ task: "core", kind: "command", cmd: "core-check" }] },
    });
    expect(f.runChecks).not.toHaveBeenCalled();
    const rows = result.details.tasks as { status: string; notes?: string[]; checks?: unknown }[];
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.checks).toBeUndefined();
    expect(rows[0]!.notes).toContain("contract checks held after outside content: not run (acceptance unverified)");
  });

  it("runs no check when the turn is cancelled while the request waits", async () => {
    const controller = new AbortController();
    const f = checksSetup({ onCheckPrompt: () => queueMicrotask(() => controller.abort()) });
    f.gate.noteUntrustedContent("s-parent", "a web page");
    await f.run(oneTask, controller.signal);
    expect(f.prompts.filter((p) => p.category === "shell")).toHaveLength(1);
    expect(f.runChecks).not.toHaveBeenCalled();
    expect(f.gate.pendingCount()).toBe(0);
  });

  it("runs the checks unasked when the risk reviewer rates them low", async () => {
    const f = checksSetup();
    const review = vi.fn(async () => ({ risk: "low" as const, reason: "the user's tests" }));
    f.gate.setRiskReviewer({ review });
    f.gate.noteUntrustedContent("s-parent", "a web page");
    await f.run(oneTask);
    expect(review.mock.calls.some((c) => (c as unknown as [{ request: ApprovalRequest }])[0].request.category === "shell")).toBe(true);
    expect(f.prompts.filter((p) => p.category === "shell")).toHaveLength(0);
    expect(f.runChecks).toHaveBeenCalled();
  });

  it("runs the checks once the person says yes", async () => {
    const f = checksSetup({ answerChecks: true });
    f.gate.noteUntrustedContent("s-parent", "a web page");
    const result = await f.run(oneTask);
    expect(f.prompts.filter((p) => p.category === "shell")).toHaveLength(1);
    expect(f.runChecks).toHaveBeenCalled();
    expect(result.summary).not.toContain("held after outside content");
  });

  it("asks when a worker read outside content mid-run", async () => {
    const f = checksSetup({ onWorker: (id, _task, g) => g.noteUntrustedContent(id, "an MCP answer") });
    await f.run(oneTask);
    const checkPrompts = f.prompts.filter((p) => p.category === "shell");
    expect(checkPrompts).toHaveLength(1);
    expect(checkPrompts[0]!.riskNote).toContain("a Fusion worker");
    expect(f.runChecks).not.toHaveBeenCalled();
  });

  it("does not ask with agent.taintReview off", async () => {
    const f = checksSetup({ taintReview: false });
    f.gate.noteUntrustedContent("s-parent", "a web page");
    await f.run(oneTask);
    expect(f.prompts).toHaveLength(0);
    expect(f.runChecks).toHaveBeenCalled();
  });

  it("does not ask on an untainted session", async () => {
    const f = checksSetup();
    await f.run(oneTask);
    expect(f.prompts).toHaveLength(0);
    expect(f.runChecks).toHaveBeenCalled();
  });

  it("describes and authorizes each dependency and final check batch", async () => {
    const f = checksSetup({ answerChecks: true });
    f.gate.noteUntrustedContent("s-parent", "a web page");
    await f.run({
      tasks: [
        { id: "core", instructions: "provide core" },
        { id: "ui", instructions: "use core" },
      ],
      contract: {
        provides: [{ task: "core", kind: "file", name: "core.js" }],
        requires: [{ task: "ui", name: "core.js" }],
        checks: [
          { task: "core", kind: "command", cmd: "core-check" },
          { kind: "command", cmd: "all-check" },
        ],
      },
    });
    const checks = f.prompts.filter((p) => p.category === "shell");
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.some(p => p.preview?.includes("core-check"))).toBe(true);
    expect(checks.some(p => p.preview?.includes("all-check"))).toBe(true);
    // Each exact batch is reviewed again; no earlier root yes covers a later plan.
    expect(f.checkRuns.length).toBeGreaterThanOrEqual(2);
  });
});
