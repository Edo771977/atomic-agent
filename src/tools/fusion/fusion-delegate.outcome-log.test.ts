import { describe, expect, it, vi } from "vitest";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { sessionTag, type OutcomeRecord, type TaskOutcomeRecord } from "./outcome-log.js";
import { FusionTurnLedger } from "./turn-receipt.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "openrouter",
    orchestratorModel: "big",
    workerProviderId: "local-llama",
    workerModel: "small",
    workers: 2,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter",
    degraded: null,
    ...over,
  };
}

function ctx(): ToolContext {
  return {
    workingDir: "/repo",
    sessionId: "s-parent",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function turn(over: Partial<RunTurnResult> = {}): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 2,
    ...over,
  };
}

function deps(over: Partial<FusionDelegateDeps>): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn: async () => turn(),
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
  };
}

const TASKS = [
  { id: "t1", title: "PRIVATE-TITLE-1", instructions: "PROMPT-TEXT-1 edit /home/u/secret.ts" },
  { id: "t2", title: "PRIVATE-TITLE-2", instructions: "PROMPT-TEXT-2" },
];

describe("fusion.delegate → outcome log", () => {
  it("appends one record per task with its fields and nothing it was told or said", async () => {
    const written: OutcomeRecord[] = [];
    const ledger = new FusionTurnLedger();
    ledger.begin("s-parent", { providerId: "openrouter", model: "big" });
    const tool = buildFusionDelegateTool(
      deps({
        runTurn: async (_session, message) => {
          if (message.includes("PROMPT-TEXT-2")) {
            throw new Error("invalid tool-call JSON near sk-live-SECRET in /home/u/secret.ts");
          }
          return turn();
        },
        outcomeLog: { append: (records) => written.push(...records) },
        turnLedger: ledger,
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("ok");
    const tasks = written.filter((r): r is TaskOutcomeRecord => r.type === "task");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => [t.status, t.failure])).toEqual([
      ["ok", null],
      ["failed", "tool-protocol"],
    ]);
    expect(tasks[0]).toMatchObject({
      session: sessionTag("s-parent"),
      provider: "local-llama",
      model: "small",
      leg: "local",
      role: null,
      attempt: 1,
      judge: "off",
      merge: null,
      selfCheckNotice: false,
      escalations: 0,
      syntaxDemoted: false,
      costUsd: null,
    });
    const text = JSON.stringify(written);
    for (const leak of ["PROMPT-TEXT", "PRIVATE-TITLE", "sk-live", "/home/u", "s-parent", "t1", "t2"]) {
      expect(text).not.toContain(leak);
    }
    // The turn's tally saw the same fan-out.
    const receipt = ledger.finish("s-parent");
    expect(receipt?.record.tasks).toEqual({ total: 2, ok: 1, failed: 1 });
  });

  it("counts a manual re-delegation of a failed task as its second attempt, autoReplan off", async () => {
    const written: OutcomeRecord[] = [];
    let fail = true;
    const tool = buildFusionDelegateTool(
      deps({
        resolveRunMode: () => mode({ autoReplan: 0 }),
        runTurn: async (_session, message) => {
          if (fail && message.includes("PROMPT-TEXT-2")) throw new Error("invalid tool-call JSON");
          return turn();
        },
        outcomeLog: { append: (records) => written.push(...records) },
      }),
    );
    await tool.run({ tasks: TASKS }, ctx());
    fail = false;
    await tool.run({ tasks: [TASKS[1]!] }, ctx());
    const tasks = written.filter((r): r is TaskOutcomeRecord => r.type === "task");
    expect(tasks.map((t) => [t.status, t.attempt])).toEqual([
      ["ok", 1],
      ["failed", 1],
      // Not a first-pass green: the same task, sent again.
      ["ok", 2],
    ]);
  });

  it("keeps the fan-out going when the log throws", async () => {
    const warn = vi.spyOn(logger, "warn");
    const tool = buildFusionDelegateTool(
      deps({
        workerSupportsSlotAffinity: () => false,
        outcomeLog: {
          append: () => {
            throw new Error("disk full");
          },
        },
      }),
    );
    const result = await tool.run({ tasks: [TASKS[1]!] }, ctx());
    expect(result.status).toBe("ok");
    expect(warn).toHaveBeenCalledWith(
      "fusion: the fan-out's outcomes were not recorded",
      { reason: "disk full" },
    );
    warn.mockRestore();
  });
});
