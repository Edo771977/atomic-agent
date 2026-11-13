import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { TurnUsageRecord } from "../../analytics/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import {
  FUSION_TURN_RECEIPT_TASK_ID,
  FusionOutcomeLog,
  FusionTurnLedger,
  outcomeLogPath,
} from "../../tools/fusion/index.js";
import type { StructuredLogger } from "../../tracing/index.js";

/**
 * The fusion outcome log and turn receipt, wired for one runtime
 * (`outcome-log.ts`, `turn-receipt.ts`): the log file under the state
 * dir, the per-turn ledger the orchestrator's completions are fed into,
 * and the turn-end hook that emits the receipt line and appends the
 * turn's record.
 */
export interface RuntimeFusionOutcomes {
  outcomeLog: FusionOutcomeLog;
  ledger: FusionTurnLedger;
  /** `TurnUsageMeter`'s observer: every completion of an open turn. */
  onUsageRecord: (sessionId: string, record: TurnUsageRecord) => void;
  /** A fusion orchestrator turn starts on `sessionId`. */
  beginTurn: (sessionId: string) => void;
  /**
   * Wraps the loop's event sink: just before a fusion turn's
   * `turn_finished` goes out, its receipt does.
   */
  wrapEventSink: (
    emit: (event: AgentLoopEvent) => void,
    currentSessionId: () => string | undefined,
  ) => (event: AgentLoopEvent) => void;
}

export function createRuntimeFusionOutcomes(deps: {
  stateDir: string;
  logger: StructuredLogger;
  resolveRunMode: () => ResolvedRunMode;
  /** Read per write: `llm.runMode.fusion.outcomeLog` (default on). */
  outcomeLogEnabled: () => boolean;
}): RuntimeFusionOutcomes {
  const outcomeLog = new FusionOutcomeLog({
    path: outcomeLogPath(deps.stateDir),
    enabled: deps.outcomeLogEnabled,
    warn: (message, fields) => deps.logger.warn(message, fields),
  });
  const ledger = new FusionTurnLedger();
  const finish = (sessionId: string, emit: (event: AgentLoopEvent) => void): void => {
    const receipt = ledger.finish(sessionId);
    if (receipt === undefined) return;
    outcomeLog.append([receipt.record]);
    emit({
      type: "fusion_worker",
      taskId: FUSION_TURN_RECEIPT_TASK_ID,
      title: "turn",
      phase: "finished",
      role: "orchestrator",
      model: receipt.record.orchestrator.model,
      summary: receipt.line,
    });
  };
  return {
    outcomeLog,
    ledger,
    onUsageRecord: (sessionId, record) => ledger.noteCompletion(sessionId, record),
    beginTurn: (sessionId) => {
      const mode = deps.resolveRunMode();
      const providerId = mode.orchestratorProviderId ?? mode.primaryProviderId;
      ledger.begin(sessionId, {
        providerId,
        model: mode.orchestratorModel ?? providerId,
      });
    },
    wrapEventSink: (emit, currentSessionId) => (event) => {
      if (event.type === "turn_finished") {
        const sessionId = currentSessionId();
        if (sessionId !== undefined && ledger.isOpen(sessionId)) {
          try {
            finish(sessionId, emit);
          } catch (err) {
            deps.logger.warn("fusion: the turn receipt was not produced", {
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      emit(event);
    },
  };
}
