import { describe, expect, it } from "vitest";

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
