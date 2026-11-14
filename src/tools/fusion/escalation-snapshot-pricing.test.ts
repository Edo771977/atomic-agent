import { describe, expect, it } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionTurnBudget } from "./turn-budget.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
const PRICING = { input: 1, output: 4 };

function mode(): ResolvedRunMode {
  return {
    stored: "fusion", effective: "fusion",
    orchestratorProviderId: "openrouter", orchestratorModel: "big",
    workerProviderId: "cloud-worker", workerModel: "small",
    workers: 1, workersPinned: true, workerMaxSteps: 7, workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter", degraded: null,
    // A cap far below the advisor's worst case, and the re-run turned on.
    escalation: { providerId: "third", model: "other", auto: true, replace: true, maxUsd: 0.000001 },
  };
}

/**
 * Snapshot prices (the bundled models.dev list) only estimate: the
 * escalation target priced by nothing else is neither refused by its
 * worst case nor re-run on (both need verified pricing), but what it
 * spends is still estimated and counted.
 */
describe("a snapshot-priced escalation target (models.dev estimate only)", () => {
  it("gets neither the worst-case refusal nor the re-run, and its usage is still estimated", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const providers: Array<string | undefined> = [];
    const asked: string[] = [];
    let minted = 0;
    const d: FusionDelegateDeps = {
      runTurn: (async (_session, _message, options) => {
        providers.push(options.providerId);
        // Six identical failing reads: the advisor, then the re-run trigger.
        for (let i = 0; i < 6; i += 1) {
          options.eventHook?.({
            type: "llm_event",
            event: { type: "tool_call_executed", result: { tool: "os.fs.read", status: "error", summary: "not found: a.txt", details: {} } },
          } as never);
          options.eventHook?.({ type: "step_finished", stepIndex: i, summary: "", durationMs: 1 } as never);
          await new Promise((r) => setTimeout(r, 0));
        }
        return { session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }), reason: "reply", stepCount: 6 } as RunTurnResult;
      }) as FusionDelegateDeps["runTurn"],
      createEphemeralSession: (meta) => {
        minted += 1;
        return createEmptySessionState({ id: `${FUSION_WORKER_ID_PREFIX}${minted}`, workingDir: "/repo", metadata: { fusionWorker: { ...meta } } });
      },
      approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
      approvalRequired: false,
      emitEvent: () => {},
      workingDir: "/repo",
      slotManager: { poolSize: () => 4 },
      resolveRunMode: () => mode(),
      workerSupportsSlotAffinity: () => false,
      warmWorkerBackend: async () => {},
      outputCharCap: 4000,
      logger,
      turnBudget: budget,
      // Every model has an estimate; only the target's is snapshot-only.
      resolveWorkerPricing: () => PRICING,
      resolveWorkerAdmissionPricing: (providerId) => (providerId === "third" ? undefined : PRICING),
      escalationComplete: async ({ providerId }) => {
        asked.push(providerId);
        return { content: "write the file", usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 } };
      },
      steerWorker: () => true,
    };
    const result = await buildFusionDelegateTool(d).run(
      { tasks: [{ id: "w", instructions: "write a.txt" }] },
      { workingDir: "/repo", sessionId: "s-parent", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(asked).toEqual(["third"]);
    // No re-run on the escalation model.
    expect(providers).toEqual(["cloud-worker"]);
    const rows = result.details.tasks as Array<{ notes?: string[] }>;
    const notes = rows[0]!.notes?.join("\n") ?? "";
    expect(notes).not.toMatch(/over the escalation cap/);
    // 1000 in at $1/M + 200 out at $4/M, estimated from the snapshot.
    expect(notes).toMatch(/escalated to other as advisor .*\$0\.0018/);
    expect(budget.workerSpend("s-parent")).toBeCloseTo(0.0018);
  });
});
