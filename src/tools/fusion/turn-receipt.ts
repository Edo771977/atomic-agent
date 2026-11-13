import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import {
  OUTCOME_RECORD_VERSION,
  outcomeLabel,
  roundUsd,
  TURN_STEPS_RECORDED,
  sessionTag,
  type TurnOutcomeRecord,
} from "./outcome-log.js";

/**
 * The fusion turn receipt: what one fusion turn cost on each side, as one
 * line at the turn's end and one `"turn"` record in the outcome log.
 *
 * The strong side is the orchestrator's own requests (fed per completion
 * from the turn usage meter, `noteCompletion`) plus the judge and
 * escalation calls the fan-outs report; the weak side is the workers'
 * tokens and time (`noteFanout`). The orchestrator's per-step prompt
 * cache hits are kept so the operator can see whether a subscription CLI
 * leg reuses its cache across steps ("cache hit X%").
 *
 * State is per session and lives only from `begin` (the fusion turn's
 * start) to `finish`; a session with no fusion turn open is ignored, so
 * worker sessions' completions never land here.
 */

/** The `fusion_worker` event's `taskId` for the receipt line (role `orchestrator`). */
export const FUSION_TURN_RECEIPT_TASK_ID = "fusion.turn";

interface OpenTurn {
  orchestratorProvider: string;
  orchestratorModel: string;
  servedProvider: string | undefined;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  sawCached: boolean;
  costUsd: number;
  sawPriced: boolean;
  steps: Array<{ in: number; cached: number | null }>;
  fanouts: number;
  tasks: number;
  tasksOk: number;
  tasksFailed: number;
  workerTokens: number;
  workerMs: number;
  workerCostUsd: number;
  sawWorkerPriced: boolean;
  /** Tasks sent to `model: "orchestrator"`: strong-side spend, as the report counts it. */
  orchestratorTasks: number;
  orchestratorTaskCostUsd: number;
  sawOrchestratorTaskPriced: boolean;
  /** Judge and escalation calls: strong-side spend outside the orchestrator's requests. */
  judgeCostUsd: number;
  escalationCostUsd: number;
}

/** One finished fan-out, as the turn receipt counts it. */
export interface FanoutReceiptInput {
  tasks: ReadonlyArray<{
    ok: boolean;
    tokens: number;
    durationMs: number;
    costUsd: number | null;
    /** Ran on the orchestrator leg (`model: "orchestrator"`): strong side. */
    orchestrator: boolean;
  }>;
  /** The fan-out's wall time; workers overlap, so this is not their sum. */
  wallMs: number;
  /** Judge and escalation spend the fan-out reported. */
  judgeCostUsd: number;
  escalationCostUsd: number;
}

export interface FusionTurnReceipt {
  line: string;
  record: TurnOutcomeRecord;
}

export class FusionTurnLedger {
  private readonly turns = new Map<string, OpenTurn>();

  /** A fusion turn starts on `sessionId`; any half-finished one is dropped. */
  begin(
    sessionId: string,
    orchestrator: { providerId: string; model: string },
  ): void {
    this.turns.set(sessionId, {
      orchestratorProvider: orchestrator.providerId,
      orchestratorModel: orchestrator.model,
      servedProvider: undefined,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      sawCached: false,
      costUsd: 0,
      sawPriced: false,
      steps: [],
      fanouts: 0,
      tasks: 0,
      tasksOk: 0,
      tasksFailed: 0,
      workerTokens: 0,
      workerMs: 0,
      workerCostUsd: 0,
      sawWorkerPriced: false,
      orchestratorTasks: 0,
      orchestratorTaskCostUsd: 0,
      sawOrchestratorTaskPriced: false,
      judgeCostUsd: 0,
      escalationCostUsd: 0,
    });
  }

  isOpen(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  /** One orchestrator completion on the open turn (no-op otherwise). */
  noteCompletion(
    sessionId: string,
    completion: { providerId?: string; usage: CompletionUsage; costUsd?: number },
  ): void {
    const turn = this.turns.get(sessionId);
    if (turn === undefined) return;
    turn.requests += 1;
    if (completion.providerId !== undefined) turn.servedProvider = completion.providerId;
    turn.tokensIn += completion.usage.promptTokens;
    turn.tokensOut += completion.usage.completionTokens;
    const cached = completion.usage.cachedTokens;
    if (cached !== undefined) {
      turn.sawCached = true;
      turn.cachedTokens += cached;
    }
    if (completion.costUsd !== undefined) {
      turn.sawPriced = true;
      turn.costUsd += completion.costUsd;
    }
    if (turn.steps.length < TURN_STEPS_RECORDED) {
      turn.steps.push({ in: completion.usage.promptTokens, cached: cached ?? null });
    }
  }

  /** One finished fan-out of the open turn (no-op otherwise). */
  noteFanout(sessionId: string, fanout: FanoutReceiptInput): void {
    const turn = this.turns.get(sessionId);
    if (turn === undefined) return;
    turn.fanouts += 1;
    turn.workerMs += Math.max(0, fanout.wallMs);
    turn.judgeCostUsd += Math.max(0, fanout.judgeCostUsd);
    turn.escalationCostUsd += Math.max(0, fanout.escalationCostUsd);
    for (const task of fanout.tasks) {
      turn.tasks += 1;
      if (task.ok) turn.tasksOk += 1;
      else turn.tasksFailed += 1;
      if (task.orchestrator) {
        turn.orchestratorTasks += 1;
        if (task.costUsd !== null) {
          turn.sawOrchestratorTaskPriced = true;
          turn.orchestratorTaskCostUsd += task.costUsd;
        }
        continue;
      }
      turn.workerTokens += task.tokens;
      if (task.costUsd !== null) {
        turn.sawWorkerPriced = true;
        turn.workerCostUsd += task.costUsd;
      }
    }
  }

  /** Close the turn. `undefined` when none was open or nothing ran in it. */
  finish(sessionId: string, now: Date = new Date()): FusionTurnReceipt | undefined {
    const turn = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (turn === undefined) return undefined;
    if (turn.requests === 0 && turn.fanouts === 0) return undefined;
    const side = turn.judgeCostUsd + turn.escalationCostUsd;
    const record: TurnOutcomeRecord = {
      v: OUTCOME_RECORD_VERSION,
      type: "turn",
      ts: now.toISOString(),
      session: sessionTag(sessionId),
      orchestrator: {
        provider: outcomeLabel(turn.servedProvider ?? turn.orchestratorProvider),
        model: outcomeLabel(turn.orchestratorModel),
        requests: turn.requests,
        tokensIn: turn.tokensIn,
        tokensOut: turn.tokensOut,
        cachedTokens: turn.sawCached ? turn.cachedTokens : null,
        costUsd:
          turn.sawPriced || side > 0 ? roundUsd(turn.costUsd + side) : null,
        requestCostUsd: turn.sawPriced ? roundUsd(turn.costUsd) : null,
        judgeCostUsd: roundUsd(turn.judgeCostUsd),
        escalationCostUsd: roundUsd(turn.escalationCostUsd),
        steps: turn.steps,
      },
      fanouts: turn.fanouts,
      tasks: { total: turn.tasks, ok: turn.tasksOk, failed: turn.tasksFailed },
      orchestratorTasks: {
        total: turn.orchestratorTasks,
        costUsd: turn.sawOrchestratorTaskPriced ? roundUsd(turn.orchestratorTaskCostUsd) : null,
      },
      workerTokens: turn.workerTokens,
      workerMs: turn.workerMs,
      workerCostUsd: turn.sawWorkerPriced ? roundUsd(turn.workerCostUsd) : null,
    };
    return { record, line: formatTurnReceipt(record) };
  }
}

/** Prompt-cache hit share of the orchestrator's prompt tokens, or null when not reported. */
export function cacheHitPercent(
  orchestrator: Pick<TurnOutcomeRecord["orchestrator"], "cachedTokens" | "tokensIn">,
): number | null {
  if (orchestrator.cachedTokens === null || orchestrator.tokensIn <= 0) return null;
  return Math.round((Math.min(orchestrator.cachedTokens, orchestrator.tokensIn) / orchestrator.tokensIn) * 100);
}

export function formatUsdShort(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDurationShort(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The strong side's spend: one total when every part of it is priced,
 * else each part by name, so an unpriced subscription orchestrator beside
 * a priced judge reads `unpriced (subscription) + $0.03 judge`, never as
 * a $0.03 strong side.
 */
function strongSpend(record: TurnOutcomeRecord): string {
  const o = record.orchestrator;
  const tasks = record.orchestratorTasks;
  const unpricedRequests = o.requestCostUsd === null && o.requests > 0;
  const unpricedTasks = tasks.total > 0 && tasks.costUsd === null;
  const total = roundUsd(
    (o.requestCostUsd ?? 0) + (tasks.costUsd ?? 0) + o.judgeCostUsd + o.escalationCostUsd,
  );
  if (!unpricedRequests && !unpricedTasks) {
    return o.requestCostUsd === null && tasks.costUsd === null && total === 0
      ? "unpriced (subscription)"
      : formatUsdShort(total);
  }
  const taskNoun = `orchestrator task${tasks.total === 1 ? "" : "s"}`;
  return [
    ...(o.requests === 0
      ? []
      : [o.requestCostUsd === null ? "unpriced (subscription)" : formatUsdShort(o.requestCostUsd)]),
    ...(tasks.total === 0
      ? []
      : [tasks.costUsd === null ? `unpriced ${taskNoun}` : `${formatUsdShort(tasks.costUsd)} ${taskNoun}`]),
    ...(o.judgeCostUsd > 0 ? [`${formatUsdShort(o.judgeCostUsd)} judge`] : []),
    ...(o.escalationCostUsd > 0 ? [`${formatUsdShort(o.escalationCostUsd)} escalation`] : []),
  ].join(" + ");
}

/**
 * `fusion receipt · strong $0.04, 6 requests, cache hit 83% · workers
 * 41.2k tokens, 2m10s · tasks 3 ok, 1 failed`. The strong side is the
 * orchestrator's requests, its `model: "orchestrator"` tasks and the
 * judge and escalation calls; workers are the other tasks.
 */
export function formatTurnReceipt(record: TurnOutcomeRecord): string {
  const o = record.orchestrator;
  const hit = cacheHitPercent(o);
  const strong = [
    strongSpend(record),
    `${o.requests} request${o.requests === 1 ? "" : "s"}`,
    ...(hit === null ? [] : [`cache hit ${hit}%`]),
  ].join(", ");
  const parts = [`fusion receipt · strong ${strong}`];
  if (record.fanouts > 0) {
    const workerCost =
      record.workerCostUsd === null || record.workerCostUsd === 0
        ? ""
        : `, ${formatUsdShort(record.workerCostUsd)}`;
    parts.push(
      `workers ${formatTokenCount(record.workerTokens)} tokens, ${formatDurationShort(record.workerMs)}${workerCost}`,
    );
    parts.push(
      `tasks ${record.tasks.ok} ok${record.tasks.failed > 0 ? `, ${record.tasks.failed} failed` : ""}`,
    );
  }
  return parts.join(" · ");
}
