import type { ApprovalGate } from "../../approval/approval-gate.js";
import {
  ApprovalDeniedError,
  requireApproval,
} from "../../approval/dangerous-tool.js";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { isInside } from "../../approval/fanout-scope.js";
import { resolveFanoutScope } from "./fanout-paths.js";
import { resolveUserPath } from "../os/expand-home.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { StructuredLogger } from "../../tracing/index.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import {
  DEFAULT_FUSION_CLOUD_WORKERS,
  DEFAULT_FUSION_MAX_ORCHESTRATOR_TASKS_PER_TURN,
} from "../../config/llm-run-mode-config.js";
import { getConfig } from "../../config/index.js";
import { workerReplyAllowance } from "../../local-llm/server/worker-slots.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  describeOversizedLocalTasks,
  localTaskSizeWarnings,
  oversizedLocalTasks,
  parseDelegateArgs,
} from "./delegate-args.js";
import {
  applyCheckOutcomes,
  applyContractFindings,
  inspectContractProvides,
  renderContractLine,
  runContractChecks,
  type ContractCheckOutcome,
  type ContractReport,
} from "./contract-checks.js";
import {
  completedWaveNotes,
  contractForWave,
  dependencyWarnings,
  planWaves,
} from "./contract-waves.js";
import {
  notStartedResult,
  runWorkerTasks,
  type WorkerRunnerDeps,
} from "./worker-runner.js";
import { describeReplan, isOpenResult, renderReplanBlock } from "./replan.js";
import { LocalLegHealth } from "./local-leg-health.js";
import {
  LocalGrammarSmoke,
  describeFormatCheckRefusal,
  formatCheckTrip,
  type LocalGrammarProbeFor,
} from "./local-grammar-smoke.js";
import {
  renderMergeBlock,
  rebaseScope,
  rebaseText,
  runIsolatedWave,
  type KeptBranch,
  type MergeTaskSuggestion,
} from "./branch-merge.js";
import {
  applyPostMergeChecks,
  buildMergeGate,
  MergeGateState,
  type GateJudge,
} from "./merge-gate.js";
import {
  TaskTreeState,
  expandSplits,
  hasSplitProposal,
  renderSplitInstructions,
} from "./task-tree.js";
import type { FusionRunRecorder, FusionRunStore } from "./run-checkpoint.js";
import {
  outcomeLogPath,
  rowCostUsd,
  taskOutcomeRecord,
  type FusionOutcomeSink,
  type MergeOutcome,
  type OutcomeLeg,
} from "./outcome-log.js";
import type { FusionTurnLedger } from "./turn-receipt.js";
import {
  planResume,
  readResumeRequest,
  type ResumePlan,
} from "./run-resume.js";
import {
  applyJudgeVerdict,
  buildAcceptanceChecklist,
  judgeTask,
  redItems,
  renderAcceptanceBlock,
  renderRetryFindings,
  type JudgeVerdict,
} from "./judge.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  ORCHESTRATOR_TASK_MODEL,
  resolveTaskLegs,
  unknownModels,
  type TaskLeg,
} from "./role-models.js";
import { provideSearchPaths, type DelegateContract } from "./contract.js";
import { completionCostUsd, estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import {
  FusionTurnBudget,
  ORCHESTRATOR_TASK_CAP_INSTRUCTION,
  TURN_BUDGET_INSTRUCTION,
  TURN_COUNT_INSTRUCTION,
  formatUsd,
  orchestratorCapMessage,
  type TurnBudgetLimits,
  type TurnBudgetStop,
  type TurnCountLimits,
} from "./turn-budget.js";
import {
  FAILURE_BREAKER_INSTRUCTION,
  FanoutFailureBreaker,
  describeTrip,
  refusalFromTrips,
  type BreakerTrip,
} from "./failure-breaker.js";
import {
  delegateOutcome,
  fanoutSpend,
  formatDelegateOutput,
  taskSpendUsd,
  type WorkerPricing,
  type WorkerTaskResult,
} from "./worker-result.js";
import { runSyntaxPass, syntaxPassFiles, type SyntaxCheckRunner } from "./syntax-pass.js";
import { measuredTaskLegs, readRoutingHistory } from "./measured-routing.js";
import { collectTaskArtifactManifests } from "./artifact-manifest-tasks.js";
import { createCandidateIntegration, type CandidateIntegration, type CandidateIntegrationReport } from "./candidate-integration.js";
import { readFusionWorkerMeta } from "../../session/fusion-worker-session.js";

export const FUSION_DELEGATE_TOOL = "fusion.delegate";

/**
 * How many `model: "orchestrator"` tasks run at once, at most (still
 * under `cloudWorkers`): each is a full turn on the strong leg.
 */
export const ORCHESTRATOR_TASK_MAX_WIDTH = 2;

export interface FusionDelegateDeps extends WorkerRunnerDeps {
  /**
   * Whether the fan-out asks the operator before it runs. Same seam as
   * every other dangerous tool: production passes `true`, tests pass
   * `false` to exercise the fan-out without a gate.
   */
  approvalRequired: boolean;
  slotManager: Pick<SlotManager, "poolSize">;
  /** Live read — the operator can leave fusion mid-turn. */
  resolveRunMode: () => ResolvedRunMode;
  /** Does the worker leg keep KV-cache affinity per slot? */
  workerSupportsSlotAffinity: (providerId: string) => boolean;
  /** The fallback seam's `prepareLink`: warm the local backend once. */
  warmWorkerBackend: (providerId: string) => Promise<void>;
  /** Budget for the rendered result block. */
  outputCharCap: number;
  /**
   * `verify.syntax`'s checker (`verifySyntax`), which the delegate runs
   * itself on every green row's changed files after the waves
   * (`syntax-pass.ts`). Absent, no pass runs and no row claims one.
   */
  syntaxCheck?: SyntaxCheckRunner;
  logger: StructuredLogger;
  /**
   * The operator's request behind the turn now running on `sessionId`
   * (the orchestrator's session), quoted into every worker brief. The
   * runtime records it when the turn starts; absent, the briefs carry
   * only the orchestrator's instructions, as they did before.
   */
  resolveOriginalRequest?: (sessionId: string) => string | undefined;
  /** Opaque SHA256 of known configured request identity; undefined means insufficient provenance. */
  resolveRoutingIdentity?: (providerId: string) => string | undefined;
  /**
   * Pricing for the worker model on the worker leg, when any is known
   * (`resolveModelPricingFor`). Present, the status table header states
   * the fan-out's spend; a local leg resolves to nothing.
   */
  resolveWorkerPricing?: (
    providerId: string,
    modelId: string,
  ) => WorkerPricing | undefined;
  /**
   * The local leg's measured generation speed
   * (`LlamaServerClient.measuredTokensPerSecond`), read per fan-out so a
   * worker's time limit follows the machine's current load. Only
   * consulted for a slot-affine (local) leg; `null` before any
   * completion has been measured.
   */
  localTokensPerSecond?: () => number | null;
  /**
   * The per-turn caps' state (ATO-947), reset by the runtime at each
   * fusion turn's start. Absent, the tool keeps its own (whose clock
   * starts at the first fan-out). Only consulted when a cap is set.
   */
  turnBudget?: FusionTurnBudget;
  /** Runtime physical-request ledger already charges newly completed calls. */
  requestBudgetAccounting?: boolean;
  /** The orchestrator's priced spend so far this turn (`TurnUsageMeter.peekCostUsd`). */
  orchestratorTurnSpendUsd?: (sessionId: string) => number | undefined;
  /**
   * Where each run is checkpointed after every task and wave, and where
   * `resume` reads an unfinished one from (ATO-617). Absent: nothing is
   * written and `resume` is refused.
   */
  runCheckpoints?: FusionRunStore;
  /**
   * The agent's own state directory (`config.paths.stateDir`, usually
   * `~/.atomic-agent`). A fan-out whose write scope lies inside it is
   * refused before the operator is asked (ATO-1267): workers have no
   * business there, and one yes would cover every file the agent keeps
   * for itself. Absent (tests, embedders), no such check.
   */
  agentStateDir?: string;
  /**
   * Whether `providerId` is a subscription CLI whose own tools are only
   * confined, not off: the Codex CLI runs `-s read-only`, and its shell
   * can still read outside a worker's read scope. Such an orchestrator
   * leg is refused as a `model: "orchestrator"` target. Absent: none is.
   */
  cliToolsStayOn?: (providerId: string) => boolean;
  /**
   * The outcome log (`outcome-log.ts`): one line per task when the
   * fan-out finishes. Absent, nothing is written; the sink itself reads
   * `llm.runMode.fusion.outcomeLog`. A write failure never reaches the
   * fan-out.
   */
  outcomeLog?: FusionOutcomeSink;
  /** The turn receipt's per-turn tally (`turn-receipt.ts`). */
  turnLedger?: Pick<FusionTurnLedger, "noteFanout">;
  /**
   * The format check for one local leg (`local-grammar-smoke.ts`): one
   * short completion under the workers' grammar on that leg's server, or
   * `undefined` when nothing can ask it (a cloud leg, a second local
   * server). Absent: no leg is checked.
   */
  localGrammarProbeFor?: LocalGrammarProbeFor;
  /** Its verdicts across fan-outs; one per tool unless injected. */
  localGrammarSmoke?: LocalGrammarSmoke;
}

/**
 * The scope directories that sit inside the agent's state directory,
 * or the state directory itself. A scope that merely contains it (the
 * home directory, say) is not refused here: the per-file trust-surface
 * guard already keeps config.json, .env, rules, hooks and plugins out
 * of any fan-out grant.
 */
export function scopeInsideStateDir(
  writeScope: readonly string[],
  stateDir: string | undefined,
): string[] {
  if (stateDir === undefined || stateDir.length === 0) return [];
  const root = resolvePath(stateDir);
  return writeScope.filter((dir) => isInside(root, resolvePath(dir)));
}

function error(
  output: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult({
    tool: FUSION_DELEGATE_TOOL,
    status: "error",
    output,
    details,
  });
}

/**
 * `fusion.delegate` — the orchestrator's fan-out.
 *
 * In fusion mode the active (cloud) model plans and this tool spends
 * the local ones: each task becomes an ephemeral worker session running
 * a turn pinned to the llama-server leg, several at a time, and the
 * orchestrator gets every reply back in one result. Cloud tokens pay
 * for the thinking, local tokens for the bulk.
 *
 * Three refusals, in order, all before any work starts:
 *
 *  1. **Not from inside a worker.** One level of fan-out keeps the cost
 *     model legible and the process bounded. `worker-tool-policy.ts`
 *     already hides the descriptor from a worker's catalog; this is the
 *     hard stop for a model that emits the name anyway.
 *  2. **Only while fusion is effective.** The mode is re-read live, not
 *     captured at boot: an operator who switches the active provider in
 *     Manage → LLM leaves fusion on the next read (§"Run modes"), and a
 *     tool that kept fanning out would be spending on a leg the operator
 *     just walked away from.
 *  3. **Only on valid args.** See `parseDelegateArgs`: the refusal
 *     names every problem of the call at once, so a slow local
 *     orchestrator regenerates once, not once per field.
 *
 * Once the call runs, its status summarises its tasks
 * (`details.outcome`): `ok` while any task delivered anything — partial
 * results are the whole value of a fan-out, and an orchestrator handed
 * a bare error learns nothing about which parts survived — and `error`
 * when none did: every task failed, was cancelled, never got a first
 * token, or ran out of time before its first step (`deliveredNothing`).
 * Per-task status lives in the output and in `details.tasks` either way.
 *
 * **Width is the model's call.** `args.maxWorkers` is honoured as asked;
 * `llm.runMode.fusion.workers` only fills in for a call that named
 * nothing. The orchestrator is the one that knows how divisible this
 * particular job is, and the `### fusion` guidance block tells it what
 * the machine can serve, so an operator-set number in a config file is
 * the wrong place to decide. The bounds that remain are physical: the
 * task count, and the server's request slots on a slot-affine leg.
 */
/**
 * What the operator reads before authorising a fan-out.
 *
 * The task titles, not a count: one prompt stands in for every write
 * these workers make, so the thing being approved has to be legible as
 * work, not as a number. The scope is stated last because it is the part
 * the answer actually grants.
 */
export function describeFanoutPreview(
  tasks: readonly { title: string }[],
  writeScope: readonly string[],
): string {
  const lines = tasks.map((task) => `  • ${task.title}`);
  const scope =
    writeScope.length > 0
      ? [
          `may write files and run commands in:`,
          ...writeScope.map((dir) => `  ${dir}`),
        ]
      : [
          `no writable directory could be derived from the briefs, so the`,
          `workers will still have to hand every write back up.`,
        ];
  return [...lines, "", ...scope].join("\n");
}

export function buildFusionDelegateTool(
  input: FusionDelegateDeps,
): ToolDefinition {
  // One per tool, so per runtime: a local server wedged by one fan-out's
  // cut-off worker is still wedged for the next fan-out (ATO-917).
  const deps: FusionDelegateDeps = {
    ...input,
    localLegHealth: input.localLegHealth ?? new LocalLegHealth(),
  };
  // Also per runtime: a leg's format verdict holds for every fan-out.
  const formatCheck = input.localGrammarSmoke ?? new LocalGrammarSmoke();
  const turnBudget = deps.turnBudget ?? new FusionTurnBudget();
  return {
    name: FUSION_DELEGATE_TOOL,
    description:
      "Delegate independent parts of the work to worker agents that run concurrently. You choose how many run at once with `maxWorkers`. A task that needs more room than the default can say so with `maxSteps` / `timeoutMs`; both are clamped to a multiple of the configured default and the result tells you when that happened. An optional `contract` (owners, provides, requires, checks) is prepended to every brief and checked after the fan-out. Give each `provides` entry a one-line `shape` (a signature, a return shape, what a field means): it is pasted into the brief of every worker that relies on it, and matching names is not matching meaning. Args: { tasks: [{ id, instructions, title?, deliverable?, files?, etaSeconds?, maxSteps?, timeoutMs?, role?, model? }] (1..16), maxWorkers?, contract? }. To continue a run cut off by a restart: { resume: runId, confirm?: [taskId] } and nothing else.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      if (isFusionWorkerSessionId(ctx.sessionId)) {
        return error(
          "fusion.delegate is not available to a worker: do the task you were given and report back in your reply.",
          { reason: "recursive-delegation" },
        );
      }
      const mode = deps.resolveRunMode();
      const workerProviderId = mode.workerProviderId;
      if (mode.effective !== "fusion" || workerProviderId === null) {
        return error(
          `fusion.delegate needs run mode "fusion" with a local worker provider; the run mode is "${mode.effective}". Do the work yourself.`,
          { reason: "not-fusion", effective: mode.effective },
        );
      }
      // A resume (ATO-617) replays the cut-off run's own arguments: the
      // finished tasks are reported from its checkpoint, the rest run.
      const resumeRequest = readResumeRequest(rawArgs);
      if (typeof resumeRequest === "string") {
        return error(`fusion.delegate: ${resumeRequest}`, { field: "resume" });
      }
      if (mode.integration === "candidate" && resumeRequest !== null) {
        return error("candidate integration is explicitly non-resumable; inspect the retained patch and plan a fresh fan-out", { reason: "candidate-nonresumable" });
      }
      let resume: ResumePlan | undefined;
      let resumedFrom: ReturnType<FusionRunStore["load"]> = null;
      if (resumeRequest !== null) {
        resumedFrom = deps.runCheckpoints?.load(resumeRequest.runId) ?? null;
        if (resumedFrom === null || resumedFrom.sessionId !== ctx.sessionId) {
          return error(
            `fusion.delegate: there is no unfinished fusion run "${resumeRequest.runId}" in this session to resume. Plan the remaining work again instead.`,
            { reason: "resume-unknown", runId: resumeRequest.runId },
          );
        }
        if (deps.runCheckpoints!.isLive(resumedFrom)) {
          return error(
            `fusion.delegate: run "${resumeRequest.runId}" is still running; it cannot be resumed while it runs.`,
            { reason: "resume-live", runId: resumeRequest.runId },
          );
        }
        resume = planResume(resumedFrom, resumeRequest.confirm);
      }
      const delegateArgs = resumedFrom?.args ?? rawArgs;
      const parsed = parseDelegateArgs(delegateArgs);
      if (!parsed.ok) return error(parsed.error, { field: "tasks" });
      // What the run spent before the restart counts toward this turn's
      // cap: a resume is the same run, not a fresh allowance.
      if (resume !== undefined && resume.carriedSpendUsd > 0) {
        turnBudget.addWorkerSpend(ctx.sessionId, resume.carriedSpendUsd);
      }

      // Labels, never guesses: the resolver's pin when it has one, the
      // provider id when it does not. Both legs are read from the same
      // live `mode` the fan-out is about to run on.
      const workerModel = mode.workerModel ?? workerProviderId;
      // Models by role and node (ATO-943): where each task runs, decided
      // before anything starts. A model name outside the allowed list
      // refuses the call; without `roles` every task is on the worker
      // leg, as before.
      const workerLegRef = { providerId: workerProviderId, model: workerModel };
      // `model: "orchestrator"`: a worker turn on the orchestrator's own
      // leg, under every worker rule. Counted against its own per-turn
      // cap (`maxOrchestratorTasksPerTurn`), since that leg is often an
      // unpriced subscription; `0` turns the target off.
      const orchestratorCap =
        mode.maxOrchestratorTasksPerTurn ??
        DEFAULT_FUSION_MAX_ORCHESTRATOR_TASKS_PER_TURN;
      if (
        orchestratorCap === 0 &&
        parsed.tasks.some((t) => t.model === ORCHESTRATOR_TASK_MODEL)
      ) {
        return error(
          `validation: \`model: "orchestrator"\` is turned off here (llm.runMode.fusion.maxOrchestratorTasksPerTurn is 0). Send those tasks to a worker model: leave \`model\` out or name one from the \`### fusion\` list.`,
          { field: "tasks", reason: "orchestrator-target-off" },
        );
      }
      // A CLI leg whose own shell stays on (Codex: `-s read-only`) can
      // read past the worker's read scope; as a worker or role leg that
      // is the operator's pick, but this target is the planner's.
      const orchestratorCliToolsOn =
        mode.orchestratorProviderId !== null &&
        deps.cliToolsStayOn?.(mode.orchestratorProviderId) === true;
      if (
        orchestratorCliToolsOn &&
        parsed.tasks.some((t) => t.model === ORCHESTRATOR_TASK_MODEL)
      ) {
        return error(
          `validation: \`model: "orchestrator"\` is not available here: the orchestrator runs on a command-line agent whose own shell stays on (read-only, but not limited to the worker's read scope), so it cannot run a worker turn under the worker's rules. Send those tasks to a worker model: leave \`model\` out or name one from the \`### fusion\` list.`,
          { field: "tasks", reason: "orchestrator-target-cli-tools" },
        );
      }
      const orchestratorLegRef =
        mode.orchestratorProviderId === null || orchestratorCliToolsOn
          ? undefined
          : {
              providerId: mode.orchestratorProviderId,
              model: mode.orchestratorModel ?? mode.orchestratorProviderId,
            };
      const modelProblem = unknownModels(
        parsed.tasks,
        workerLegRef,
        mode.roles,
        orchestratorLegRef,
      );
      if (modelProblem !== undefined) {
        return error(modelProblem, { field: "tasks", reason: "unknown-model" });
      }
      let taskLegs = resolveTaskLegs(
        parsed.tasks,
        workerLegRef,
        mode.roles,
        orchestratorLegRef,
      );
      const routing = mode.measuredRouting?.enabled === true
        ? measuredTaskLegs(parsed.tasks.filter((task) => resume === undefined || resume.rerun.includes(task.id)), taskLegs, workerLegRef, mode.roles, orchestratorLegRef, {
          records: deps.agentStateDir === undefined ? [] : readRoutingHistory(outcomeLogPath(deps.agentStateDir)),
          minSamples: mode.measuredRouting.minSamples,
          days: mode.measuredRouting.days,
          remainingOrchestrator: orchestratorCap - turnBudget.orchestratorTasks(ctx.sessionId) -
            [...taskLegs.values()].filter((leg) => leg.orchestrator === true).length,
          attempted: (id) => turnBudget.attempts(ctx.sessionId, id) > 0,
          cliToolsStayOn: (provider) => deps.cliToolsStayOn?.(provider) === true,
          identityFor: (provider) => deps.resolveRoutingIdentity?.(provider),
        }) : undefined;
      if (routing !== undefined) taskLegs = routing.legs;
      // Tasks sized past what a small local worker does well: run as
      // asked, never refused. Said on the approval line (before any
      // worker starts, when a person is asked) and on the result (the
      // orchestrator reads nothing in between).
      const orchestratorTaskIds = parsed.tasks
        .filter((t) => taskLegs.get(t.id)?.orchestrator === true)
        .map((t) => t.id);
      const taskIsLocal = (t: DelegateTask): boolean =>
        deps.workerSupportsSlotAffinity(
          taskLegs.get(t.id)?.providerId ?? workerProviderId,
        );
      const declaredInputs = parsed.contract?.inputs ?? [];
      const oversized = oversizedLocalTasks(parsed.tasks, taskIsLocal, declaredInputs);
      const sizeWarnings = localTaskSizeWarnings(parsed.tasks, taskIsLocal, declaredInputs);
      // The legs other than the worker leg, one per provider.
      const roleLegs = new Map<string, TaskLeg>();
      for (const leg of taskLegs.values()) {
        if (!leg.isWorkerLeg && !roleLegs.has(leg.providerId)) {
          roleLegs.set(leg.providerId, leg);
        }
      }

      // The turn's caps (ATO-947). Unset — the default — and nothing
      // below changes: no check, no extra signal, no timer.
      const limits: TurnBudgetLimits = {
        ...(mode.turnBudgetUsd === undefined ? {} : { usd: mode.turnBudgetUsd }),
        ...(mode.turnTimeBudgetMs === undefined
          ? {}
          : { timeMs: mode.turnTimeBudgetMs }),
      };
      const capped = limits.usd !== undefined || limits.timeMs !== undefined;
      const autoReplan = mode.autoReplan ?? 0;
      const budgetStop = (): TurnBudgetStop | undefined =>
        capped
          ? turnBudget.check(
              ctx.sessionId,
              limits,
              deps.orchestratorTurnSpendUsd?.(ctx.sessionId) ?? 0,
            )
          : undefined;
      const reached = budgetStop();
      if (reached !== undefined) {
        return error(
          `fusion.delegate did not run: ${reached.message}. ${TURN_BUDGET_INSTRUCTION}`,
          {
            reason: "turn-budget",
            kind: reached.kind,
            spentUsd: reached.spentUsd,
            elapsedMs: reached.elapsedMs,
          },
        );
      }
      // The turn's memory of earlier rounds (ATO-1406). Only with the
      // runtime's per-turn state: the tool's own fallback has no turn
      // boundary, and counts carried across turns would refuse forever.
      const tracksTurn = deps.turnBudget !== undefined;
      if (tracksTurn) {
        const priorTrip = refusalFromTrips(
          turnBudget.trips(ctx.sessionId),
          workerProviderId,
          [...roleLegs.keys()],
        );
        if (priorTrip !== undefined) {
          return error(
            `fusion.delegate did not run: earlier this turn ${describeTrip(priorTrip)}. Running the workers again would fail the same way. ${FAILURE_BREAKER_INSTRUCTION}`,
            {
              reason: "failure-breaker",
              blocker: priorTrip.blocker,
              signature: priorTrip.signature,
            },
          );
        }
        const countLimits: TurnCountLimits = {
          ...(mode.maxRoundsPerTurn === undefined
            ? {}
            : { rounds: mode.maxRoundsPerTurn }),
          ...(mode.maxTasksPerTurn === undefined
            ? {}
            : { tasks: mode.maxTasksPerTurn }),
        };
        const countStop = turnBudget.checkCounts(
          ctx.sessionId,
          { ...countLimits, orchestratorTasks: orchestratorCap },
          parsed.tasks.length,
          orchestratorTaskIds.length,
        );
        if (countStop?.kind === "orchestrator-tasks") {
          return error(
            `fusion.delegate did not run: ${countStop.message}. ${ORCHESTRATOR_TASK_CAP_INSTRUCTION}`,
            { reason: "turn-count", kind: countStop.kind, cap: orchestratorCap },
          );
        }
        if (countStop !== undefined) {
          return error(
            `fusion.delegate did not run: ${countStop.message}. ${TURN_COUNT_INSTRUCTION}`,
            { reason: "turn-count", kind: countStop.kind },
          );
        }
      } else if (orchestratorTaskIds.length > orchestratorCap) {
        // No turn state to count across calls: the cap still holds per call.
        return error(
          `fusion.delegate did not run: ${orchestratorCapMessage(orchestratorTaskIds.length, 0, orchestratorCap)}. ${ORCHESTRATOR_TASK_CAP_INSTRUCTION}`,
          { reason: "turn-count", kind: "orchestrator-tasks", cap: orchestratorCap },
        );
      }

      // Before the pool is measured: warming replays the probes a cloud
      // boot deferred, and it is the `/props` round trip inside it that
      // resizes the slot pool from 1 to the daemon's real `--parallel`.
      // Reading `poolSize()` first would cap every fan-out at one worker
      // on a freshly booted cloud-active runtime.
      try {
        await deps.warmWorkerBackend(workerProviderId);
      } catch (err) {
        // Non-fatal: the completion itself will fail loudly a moment
        // later if the backend is really down, and that failure lands on
        // the task row instead of taking the whole call with it.
        deps.logger.warn("fusion: warming the worker backend failed", {
          providerId: workerProviderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      for (const providerId of roleLegs.keys()) {
        try {
          await deps.warmWorkerBackend(providerId);
        } catch (err) {
          deps.logger.warn("fusion: warming a role model's backend failed", {
            providerId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const slotAffine = deps.workerSupportsSlotAffinity(workerProviderId);
      const poolSize = slotAffine
        ? Math.max(1, deps.slotManager.poolSize())
        : Number.POSITIVE_INFINITY;
      // The ORCHESTRATOR decides the width. It is the party that knows
      // what this fan-out is made of, and the `### fusion` block tells
      // it what the machine can serve, so `runMode.workers` is only the
      // default for a call that named nothing — never a ceiling on a
      // larger number the model asked for. What is left bounding it is
      // physical: you cannot run more workers than there are tasks, and
      // on a slot-affine leg you cannot run more than the server has
      // request slots (the rest would queue and evict each other's KV
      // cache rather than run).
      // A call that named no width on a LOCAL leg runs one worker at a
      // time unless the operator pinned `runMode.fusion.workers`: the
      // slots share one GPU, and the benchmark measured two local
      // workers at 2.6-2.9 tok/s each against 6.4 for one — parallel is
      // not faster there until a measurement says so, while a fan-out
      // that overflows the shared context loses every worker at once.
      // A cloud leg has no such pool and takes the configured default.
      const requested =
        parsed.maxWorkers ??
        (slotAffine ? (mode.workersPinned ? mode.workers : 1) : mode.workers);
      // Tasks a role model takes (ATO-943) are not this leg's to queue.
      const legTaskCount =
        roleLegs.size === 0
          ? parsed.tasks.length
          : parsed.tasks.filter((t) => taskLegs.get(t.id)?.isWorkerLeg !== false)
              .length;
      const wanted = Math.max(1, Math.min(requested, legTaskCount));
      // A cloud leg has no slot pool, so nothing physical bounds the
      // width — only the bill. `cloudWorkers` is that bound: a
      // `maxWorkers` above it is clamped, and the result says so, since
      // the orchestrator is the party that can re-plan around it.
      const cloudCap = Number.isFinite(poolSize)
        ? Number.POSITIVE_INFINITY
        : (mode.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS);
      const maxWorkers = Math.max(1, Math.min(wanted, poolSize, cloudCap));
      const cloudCapIsBinding = maxWorkers < wanted && maxWorkers === cloudCap;
      // The pool held this fan-out down when it ran fewer at a time than
      // there was work for — whether the orchestrator asked for a wider
      // number or simply had more tasks than the machine has slots.
      const poolIsBinding =
        !cloudCapIsBinding &&
        (maxWorkers < wanted || maxWorkers < legTaskCount);

      const orchestratorModel =
        mode.orchestratorModel ??
        mode.orchestratorProviderId ??
        mode.primaryProviderId;

      // The orchestrator claims its own call before the workers start
      // talking. Everything between this line and the closing one below
      // is worker work on the local leg; this is the runtime's only
      // honest, zero-cost place to say so — the parent turn's other
      // steps are served through the fallback chain and may not have run
      // on `orchestratorModel` at all, so they are deliberately left
      // unlabelled rather than attributed on a guess.
      deps.emitEvent(ctx.sessionId, {
        type: "fusion_worker",
        taskId: FUSION_DELEGATE_TOOL,
        title: `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"}`,
        phase: "tool",
        role: "orchestrator",
        model: orchestratorModel,
        tool: FUSION_DELEGATE_TOOL,
      });

      // One question for the whole fan-out, asked before a single worker
      // starts. A worker has no operator to ask — that is what made the
      // mode unusable below full trust, with every write refused and the
      // orchestrator left as the only party able to act — so the
      // operator is asked here instead, once, with the task list and the
      // directory in front of them.
      let writeScope = resolveFanoutScope(parsed.tasks, ctx.workingDir);
      // Never into the agent's own state directory (ATO-1267).
      const intoState = scopeInsideStateDir(writeScope, deps.agentStateDir);
      if (intoState.length > 0) {
        return error(
          `fusion.delegate did not run: the tasks would write in the agent's own state directory (${intoState.join(", ")}). ` +
            "Workers cannot write there. Name a project directory for the work instead; " +
            "if the user really wants a change to the agent's own files, tell them, since only they can make it.",
          { reason: "agent-state-dir", scope: intoState },
        );
      }
      // A local leg that cannot produce the tool-call format is found out
      // here, with one short completion, before the person is asked and
      // before a worker spends its time on it (local-grammar-smoke.ts).
      // Never a cloud leg: only a slot-affine leg with a probe is asked.
      // The servers this fan-out will load: while it runs, a check
      // there (another session's fan-out) is skipped, not queued.
      const checkedServers = new Set<string>();
      if (mode.localFormatCheck !== false && deps.localGrammarProbeFor !== undefined) {
        const localLegs = new Map<string, string>();
        if (slotAffine && legTaskCount > 0) localLegs.set(workerProviderId, workerModel);
        for (const [providerId, leg] of roleLegs) {
          if (deps.workerSupportsSlotAffinity(providerId)) localLegs.set(providerId, leg.model);
        }
        for (const [providerId, model] of localLegs) {
          const probe = deps.localGrammarProbeFor(providerId, {
            orchestratorProviderId: mode.orchestratorProviderId ?? mode.primaryProviderId,
          });
          if (probe === undefined) continue;
          checkedServers.add(probe.server);
          const checked = await formatCheck.check(probe, {
            sessionId: ctx.sessionId,
            leg: providerId,
            signal: ctx.signal,
          });
          deps.logger.info("fusion: local format check", {
            providerId,
            verdict: checked.kind,
            ...("cached" in checked ? { cached: checked.cached } : {}),
            ...(checked.kind === "inconclusive" ? { reason: checked.reason } : {}),
            ...(checked.kind === "skipped" ? { why: checked.why } : {}),
          });
          if (checked.kind === "fail") {
            const trip = formatCheckTrip(providerId);
            if (tracksTurn) turnBudget.noteTrip(ctx.sessionId, trip);
            return error(describeFormatCheckRefusal(trip, checked.error, model), {
              reason: "failure-breaker",
              blocker: true,
              signature: trip.signature,
              formatCheck: true,
            });
          }
        }
      }

      // A turn is one job. An orchestrator that reviews and re-delegates
      // runs five fan-outs to build one library, and asking the same
      // question five times is attrition, not consent. The operator's
      // answer stands for the rest of the turn as long as later fan-outs
      // stay inside the directories it named; one reaching somewhere new
      // asks again.
      //
      // Except after the user declined a file in those directories this
      // turn: the workers would write it unasked under the standing yes,
      // so re-delegating a declined write is asked about again.
      const declinedInScope =
        deps.approvals.hasDeclinedUnder?.(ctx.sessionId, writeScope) ?? false;
      const alreadyApproved =
        !declinedInScope &&
        (deps.approvals.fanoutScopes?.turnGrantCovers(
          ctx.sessionId,
          writeScope,
        ) ??
          false);
      try {
        if (!alreadyApproved) {
          // A yes from a person who was shown this fan-out is their newer
          // answer for the files they declined in its directories; one
          // the level gave is not, and those files stay declined.
          const asksPerson =
            declinedInScope &&
            deps.approvalRequired &&
            (deps.approvals.wouldPrompt?.(ctx.sessionId, "fusion_fanout", {
              tool: FUSION_DELEGATE_TOOL,
              affectedResources: [...writeScope],
            }) ??
              false);
          await requireApproval(
            {
              approvals: deps.approvals as ApprovalGate,
              approvalRequired: deps.approvalRequired,
            },
            {
              sessionId: ctx.sessionId,
              tool: FUSION_DELEGATE_TOOL,
              category: "fusion_fanout",
              reason: `${parsed.tasks.length} task${parsed.tasks.length === 1 ? "" : "s"} to ${maxWorkers} worker${maxWorkers === 1 ? "" : "s"} on ${workerModel}${
                roleLegs.size === 0
                  ? ""
                  : ` and ${[...roleLegs.values()].map((l) => l.model).join(", ")}`
              }${tracksTurn ? describeTurnCounts(turnBudget.counts(ctx.sessionId), parsed.tasks.length, mode) : ""}${describeOversizedLocalTasks(oversized)}`,
              preview: describeFanoutPreview(parsed.tasks, writeScope),
              affectedResources: [...writeScope],
            },
            ctx.signal,
          );
          if (asksPerson) {
            deps.approvals.forgetDeclinedUnder?.(ctx.sessionId, writeScope);
          }
        }
        deps.approvals.fanoutScopes?.grantForTurn(ctx.sessionId, writeScope);

      } catch (err) {
        // The user's own no already says what happened and what to do,
        // and so does a repeat of one they declined earlier in the turn.
        if (
          err instanceof ApprovalDeniedError &&
          (err.byUser || err.declinedEarlier)
        ) {
          return error(err.message, {
            reason: "fan-out-denied",
            deniedByUser: true,
          });
        }
        return error(
          `the fan-out was not approved: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "fan-out-denied" },
        );
      }

      const candidateOriginalDir = ctx.workingDir;
      let candidate: CandidateIntegration | undefined;
      if (mode.integration === "candidate") {
        if (writeScope.some(path => !isInside(resolvePath(candidateOriginalDir), resolvePath(path)))) {
          return error("candidate integration requires all declared write scopes inside the current project", { reason: "candidate-outside-project" });
        }
        try {
          const remaining = capped ? turnBudget.timeLeftMs(ctx.sessionId, limits) : undefined;
          const signal = remaining === undefined ? ctx.signal : AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(0, remaining))]);
          candidate = await createCandidateIntegration(candidateOriginalDir, { signal });
        } catch (err) {
          return error(`candidate integration could not stage a private workspace: ${err instanceof Error ? err.message : String(err)}`, { reason: "candidate-staging-failed", nonResumable: true });
        }
        const roots = [candidateOriginalDir, candidateOriginalDir.replace(/\\/g, "/")];
        parsed.tasks = rebaseCandidateValue(parsed.tasks, roots, candidate.dir);
        if (parsed.contract !== undefined) {
          const originalInputs = parsed.contract.inputs;
          parsed.contract = rebaseCandidateValue(parsed.contract, roots, candidate.dir);
          // Resolve input identity independently of the prose rewriter: on
          // Windows the original root may use any case. Keep only the
          // declared suffix so generated temp prefixes cannot become globs.
          if (originalInputs !== undefined) parsed.contract.inputs = originalInputs.map(path => {
            try {
              const absolute = resolveUserPath(path, candidateOriginalDir);
              return isInside(candidateOriginalDir, absolute) ? relative(candidateOriginalDir, absolute) : path;
            } catch { return path; }
          });
        }
        writeScope = rebaseScope(writeScope, roots, candidate.dir);
        ctx = { ...ctx, workingDir: candidate.dir, ...(ctx.readRoots === undefined ? {} : { readRoots: ctx.readRoots.map(path => rebaseText(path, roots, candidate!.dir)) }) };
      }
      try {
      // The orchestrator's brief is a summary, and summaries were thin
      // enough that workers built the wrong thing or scavenged the disk
      // for the missing spec. Every worker also gets what was asked.
      // A resumed run keeps the request it was started for: this turn's
      // own message is the person's "continue", not the job.
      const request =
        resumedFrom?.originalRequest ??
        deps.resolveOriginalRequest?.(ctx.sessionId);
      const originalRequest = request === undefined || candidate === undefined ? request : rebaseText(request, [candidateOriginalDir, candidateOriginalDir.replace(/\\/g, "/")], candidate.dir);
      // A local worker's time limit is sized from the machine's measured
      // speed (F19); a cloud leg has no such measurement and keeps the
      // configured ceiling.
      const localTokensPerSecond = Number.isFinite(poolSize)
        ? (deps.localTokensPerSecond?.() ?? null)
        : null;
      // The reply cap the local pool was divided by (`workerSlotFootprint`
      // sizes each worker's reply at `workerReplyAllowance`, not at the raw
      // `completionMaxTokens`). A cap above that allowance is sent as the
      // workers' own, so no worker can write past its share of the shared
      // context; an operator's `workerMaxOutputTokens` still wins, a cap
      // at or below the allowance changes nothing, and a cloud leg (no
      // pool, `poolSize` infinite) is never capped here.
      const localReplyCap = getConfig().localModels.completionMaxTokens;
      const workerMaxOutputTokens =
        mode.workerMaxOutputTokens ??
        (Number.isFinite(poolSize) &&
        localReplyCap > workerReplyAllowance(localReplyCap)
          ? workerReplyAllowance(localReplyCap)
          : undefined);

      // The order the contract imposes (F45): a task that requires what
      // a sibling provides runs in a later wave than that sibling, so it
      // is not sent to wait for a file that does not exist yet. Without
      // a contract, or without a satisfiable `requires`, the plan is one
      // wave holding every task — the fan-out as it always ran.
      const plan = planWaves(
        parsed.tasks.map((t) => t.id),
        parsed.contract,
      );
      const ordered = plan.dependencies.size > 0;
      // What the waves add to the contract's own warnings: a cycle, and
      // every provider that had not delivered when its dependent ran.
      // Each wave's block carries everything known so far; the result's
      // `contract:` line carries all of it.
      const waveWarnings: string[] =
        plan.cycle === undefined ? [] : [plan.cycle];
      const dependencyCheckOutcomes = new Map<number, ContractCheckOutcome>();

      // A cap reached mid-fan-out stops what is running and starts
      // nothing more; the rows say why.
      const workerPricing = deps.resolveWorkerPricing?.(
        workerProviderId,
        workerModel,
      );
      const budgetAbort = new AbortController();
      let stoppedBy: TurnBudgetStop | undefined;
      const stopForBudget = (stop: TurnBudgetStop): void => {
        if (stoppedBy !== undefined) return;
        stoppedBy = stop;
        budgetAbort.abort(new Error(stop.message));
      };
      const timeLeft = capped
        ? turnBudget.timeLeftMs(ctx.sessionId, limits)
        : undefined;
      const budgetTimer =
        timeLeft === undefined
          ? undefined
          : setTimeout(
              () => {
                const stop = budgetStop();
                if (stop !== undefined) stopForBudget(stop);
              },
              Math.max(0, timeLeft),
            );
      budgetTimer?.unref?.();
      const budgetOptionsFor = (pricing: WorkerPricing | undefined) =>
        capped
          ? {
              shouldStart: (): string | undefined => {
                const stop = stoppedBy ?? budgetStop();
                if (stop === undefined) return undefined;
                stopForBudget(stop);
                return stop.message;
              },
              onWorkerUsage: (
                _taskId: string,
                usage: Parameters<typeof estimateUsageCostUsd>[0],
              ): void => {
                // The service's own bill counts even for an unpriced worker.
                const usd = completionCostUsd(usage, pricing);
                if (usd !== undefined) {
                  turnBudget.addWorkerSpend(ctx.sessionId, usd, deps.requestBudgetAccounting === true);
                }
                const stop = budgetStop();
                if (stop !== undefined) stopForBudget(stop);
              },
            }
          : {};
      // Escalation (ATO-942): only to the configured target, priced with
      // the same resolver as the workers, and counted in the turn's cap.
      const escalationTarget = mode.escalation ?? null;
      const escalationPricing =
        escalationTarget === null
          ? undefined
          : deps.resolveWorkerPricing?.(
              escalationTarget.providerId,
              escalationTarget.model ?? escalationTarget.providerId,
            );
      let escalationSpendUsd = 0;
      const escalationOptions =
        escalationTarget === null || deps.escalationComplete === undefined
          ? {}
          : {
              escalation: {
                target: escalationTarget,
                ...(escalationPricing === undefined
                  ? {}
                  : { pricing: escalationPricing }),
              },
              onEscalationSpend: (_taskId: string, usd: number): void => {
                escalationSpendUsd += usd;
                run?.addSpend(usd);
                turnBudget.addWorkerSpend(ctx.sessionId, usd, deps.requestBudgetAccounting === true);
                const stop = budgetStop();
                if (stop !== undefined) stopForBudget(stop);
              },
            };
      const runSignal = capped
        ? AbortSignal.any([ctx.signal, budgetAbort.signal])
        : ctx.signal;
      // Escalation and judge calls name the delegating session, so they
      // count in its spend readout like the workers' own calls (ATO-1388).
      const sideComplete: FusionDelegateDeps["escalationComplete"] =
        deps.escalationComplete === undefined
          ? undefined
          : (call) => deps.escalationComplete!({ ...call, sessionId: ctx.sessionId });
      // Every worker session carries the request unclipped: its brief
      // may quote only the head (a local leg), and the input guard reads
      // the whole request for the files it names (`workerRequestRecord`).
      const executionIdentities = new Map<string, string | undefined>();
      const workerDeps: FusionDelegateDeps = {
        ...deps,
        ...(candidate === undefined ? {} : { ruleWorkdir: candidateOriginalDir }),
        ...(deps.resolveRoutingIdentity === undefined ? {} : { runTurn: (session, message, options) => {
          const taskId = readFusionWorkerMeta(session.metadata)?.taskId;
          const provider = options.providerId;
          if (taskId !== undefined) {
            const identity = provider === taskLegs.get(taskId)?.providerId && provider !== undefined
              ? deps.resolveRoutingIdentity?.(provider) : undefined;
            // Once a task's identity changes between turns it stays unattributed.
            if (!executionIdentities.has(taskId)) executionIdentities.set(taskId, identity);
            else if (executionIdentities.get(taskId) !== identity) executionIdentities.set(taskId, undefined);
          }
          return deps.runTurn(session, message, options);
        } }),
        ...(sideComplete === undefined ? {} : { escalationComplete: sideComplete }),
        ...(originalRequest === undefined
          ? {}
          : {
              createEphemeralSession: (meta, workingDir, inheritWorkspace) =>
                deps.createEphemeralSession(
                  { ...meta, operatorRequest: originalRequest },
                  workingDir,
                  inheritWorkspace,
                ),
            }),
      };

      // The judge's acceptance lists (ATO-944), built before any work so
      // every brief carries its own, read-only. Off: no list, no suffix.
      const judgeTarget = mode.judge ?? null;
      const judging =
        judgeTarget !== null && deps.escalationComplete !== undefined;
      const acceptance = new Map(
        judging
          ? parsed.tasks.map((t) => [
              t.id,
              buildAcceptanceChecklist(t, parsed.contract),
            ])
          : [],
      );
      const acceptanceSuffix = judging
        ? (taskId: string): string | undefined => {
            const items = acceptance.get(taskId);
            return items === undefined || items.length === 0
              ? undefined
              : renderAcceptanceBlock(items);
          }
        : undefined;
      // The checkpoint (ATO-617): written after every task and wave, so a
      // run cut off by a crash or a quit can be resumed from where it was.
      const run: FusionRunRecorder | undefined = candidate === undefined ? deps.runCheckpoints?.start({
        ...(resume === undefined ? {} : { runId: resume.runId }),
        sessionId: ctx.sessionId,
        workingDir: ctx.workingDir,
        ...(originalRequest === undefined ? {} : { originalRequest }),
        args: checkpointArgs(delegateArgs),
        tasks: parsed.tasks,
        waveCount: plan.waves.length,
        ...(resumedFrom === null ? {} : { resumedFrom }),
      }) : undefined;
      // Priced per leg: a role model's task is recorded at its own price.
      const checkpointOptionsFor = (
        pricing: typeof workerPricing,
      ): Pick<
        Parameters<typeof runWorkerTasks>[1],
        "onWorkerTool" | "onTaskFinished"
      > =>
        run === undefined
          ? {}
          : {
              onWorkerTool: (taskId: string, tool: string): void =>
                run.noteTool(taskId, tool),
              onTaskFinished: (result: WorkerTaskResult): void => {
                // Per call, as the turn budget was charged.
                const costUsd = taskSpendUsd(result, pricing);
                // A proposal is not an answer: its row is written once the
                // split closed (`expandWave`), its spend now. Under isolation
                // nothing has reached the folder yet: `runTasks` writes the
                // row after the merge.
                if (mode.isolation === "worktree" || awaitsExpansion(result)) {
                  run.addSpend(costUsd);
                } else {
                  run.recordTask(result, costUsd);
                }
              },
            };
      // One failure breaker per leg (ATO-1406): a run of identical
      // failures, or one blocker, stops new starts on that leg; workers
      // already running finish. Fed by every finished row, consulted
      // with the turn's caps before each task starts.
      const breakers = new Map<string, FanoutFailureBreaker>();
      const breakerFor = (providerId: string): FanoutFailureBreaker => {
        let breaker = breakers.get(providerId);
        if (breaker === undefined) {
          breaker = new FanoutFailureBreaker(providerId);
          breakers.set(providerId, breaker);
        }
        return breaker;
      };
      const guardOptionsFor = (
        providerId: string,
        pricing: WorkerPricing | undefined,
      ): Pick<
        Parameters<typeof runWorkerTasks>[1],
        | "shouldStart"
        | "shouldStartTask"
        | "onWorkerUsage"
        | "onWorkerTool"
        | "onTaskFinished"
      > => {
        const budget: Pick<
          Parameters<typeof runWorkerTasks>[1],
          "shouldStart" | "onWorkerUsage"
        > = budgetOptionsFor(pricing);
        const checkpoint = checkpointOptionsFor(pricing);
        const breaker = breakerFor(providerId);
        return {
          ...budget,
          ...checkpoint,
          // The breaker only gates new tasks; the budget's own check
          // still governs escalations and cuts (ATO-1406).
          shouldStartTask: () => breaker.stopReason(),
          onTaskFinished: (result: WorkerTaskResult): void => {
            breaker.observe(result);
            // A finished worker that ran tools answers the format check.
            if (
              (result.status === "ok" || result.status === "no_changes") &&
              result.tools.calls > 0
            ) {
              formatCheck.noteWorkerSucceeded(ctx.sessionId, providerId);
            }
            checkpoint.onTaskFinished?.(result);
          },
        };
      };
      // The task tree (ATO-940): off unless configured, and then the wave
      // runs and a judge's retry read proposals.
      const tree =
        mode.taskTree === undefined
          ? undefined
          : new TaskTreeState(mode.taskTree, workerModel);
      tree?.addRoots(parsed.tasks, parsed.contract);
      // A split's subtasks count on their root in the checkpoint (ATO-1320).
      if (tree !== undefined) run?.useParents((id) => tree.parentOf(id));
      // One of the orchestrator's own tasks whose worker proposed a split.
      const awaitsExpansion = (row: WorkerTaskResult): boolean =>
        tree !== undefined &&
        tree.depthOf(row.id) === 1 &&
        hasSplitProposal(row.reply);
      const canProposeSplit =
        tree === undefined
          ? undefined
          : (taskId: string): boolean => tree.canSplitAt(tree.depthOf(taskId));
      const waveSuffix =
        tree === undefined
          ? acceptanceSuffix
          : (taskId: string): string | undefined => {
              const parts = [
                acceptanceSuffix?.(taskId),
                canProposeSplit?.(taskId) === true
                  ? renderSplitInstructions(tree.nodesLeft)
                  : undefined,
              ].filter((part): part is string => part !== undefined);
              return parts.length === 0 ? undefined : parts.join("\n\n");
            };
      // The judge's spend counts toward the turn's cap, whether it ruled
      // in a task's workspace before the merge or after the waves.
      let judgeSpendUsd = 0;
      const judgePricing =
        judging && judgeTarget !== null
          ? deps.resolveWorkerPricing?.(
              judgeTarget.providerId,
              judgeTarget.model ?? judgeTarget.providerId,
            )
          : undefined;
      const judgeable = (r: WorkerTaskResult): boolean =>
        (acceptance.get(r.id)?.length ?? 0) > 0 &&
        (r.status === "ok" ||
          (r.status === "failed" && (r.error ?? "").startsWith("checks:")));
      const judgeOne: GateJudge = async (input) => {
        const stop = budgetStop();
        if (stop !== undefined || runSignal.aborted) {
          return {
            green: false,
            items: [],
            unverified:
              stop === undefined ? "the turn was cancelled" : `not judged: ${stop.message}`,
            costUsd: null,
          };
        }
        const verdict = await judgeTask({
          ...input,
          ...(deps.knownSecrets === undefined
            ? {}
            : { knownSecrets: deps.knownSecrets() }),
          target: judgeTarget!,
          pricing: judgePricing,
          complete: sideComplete!,
          signal: runSignal,
        });
        if (verdict.costUsd !== null && verdict.costUsd > 0) {
          judgeSpendUsd += verdict.costUsd;
          run?.addSpend(verdict.costUsd);
          turnBudget.addWorkerSpend(ctx.sessionId, verdict.costUsd, deps.requestBudgetAccounting === true);
        }
        return verdict;
      };
      // Merge only green tasks: under isolation a task's own checks and
      // the judge rule inside its workspace before its merge, and a red
      // one is kept as a patch (`merge-gate.ts`). A judged-red task's
      // workspace is kept for its retry, and removed after the judge.
      const gateState = new MergeGateState();
      // The session's read scope, for the syntax pass (gate and after).
      const syntaxRoots = [
        ctx.workingDir,
        ...(ctx.readRoots ?? []),
        ...writeScope,
      ];
      const keptBranches = new Map<string, KeptBranch>();
      let retryRound = false;
      const releaseKept = async (): Promise<void> => {
        const sets = new Set([...keptBranches.values()].map((b) => b.set));
        keptBranches.clear();
        for (const set of sets) await set.cleanup();
      };
      // Branch isolation (ATO-946): with `isolation: "worktree"` each run
      // of tasks (a wave, a judge's retry) gets a workspace per task and
      // is merged back before anything reads the folder. Off: unchanged.
      // Inside a wave the tasks are split across the role legs (ATO-943).
      // A resumed run still owes the merges it was cut off with.
      const merges: MergeTaskSuggestion[] = [...(resumedFrom?.merges ?? [])];
      // Under isolation, what became of each task's workspace, for the
      // outcome log: merged (or conflicted), else held back. A task's
      // last run (a judge's retry) wins.
      const mergeOutcomes = new Map<string, MergeOutcome>();
      const runTasks = async (
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        allowSplit = false,
      ): Promise<WorkerTaskResult[]> => {
        if (mode.isolation !== "worktree") {
          return runAcrossLegs(tasks, contract, briefSuffix, undefined, allowSplit);
        }
        const kept = new Map(
          tasks.flatMap((t) => {
            const branch = keptBranches.get(t.id);
            return branch === undefined ? [] : [[t.id, branch] as const];
          }),
        );
        const wave = await runIsolatedWave({
          realDir: ctx.workingDir,
          tasks,
          writeScope,
          inputs: contract?.inputs ?? [],
          run: (rebased, taskWorkspace) =>
            runAcrossLegs(rebased, contract, briefSuffix, taskWorkspace, allowSplit),
          gate: buildMergeGate({
            contract: parsed.contract,
            tasks: parsed.tasks,
            concurrent: tasks.map((t) => t.id),
            runChecks: deps.runChecks,
            ...(deps.knownSecrets === undefined
              ? {}
              : { knownSecrets: deps.knownSecrets() }),
            signal: runSignal,
            state: gateState,
            syntax: { runner: deps.syntaxCheck, roots: syntaxRoots },
            ...(judging
              ? {
                  judge: {
                    items: (id: string) => acceptance.get(id),
                    judgeable,
                    run: judgeOne,
                    keepForRetry: !retryRound,
                  },
                }
              : {}),
          }),
          ...(kept.size === 0 ? {} : { kept }),
        });
        for (const [id, branch] of wave.kept ?? []) keptBranches.set(id, branch);
        // What reached the folder after a gate ruled: a later merge into a
        // gated task's files makes its verdict stale (re-run after the waves).
        for (const outcome of wave.outcomes) {
          const task = tasks.find((t) => t.id === outcome.taskId);
          gateState.noteMerge(
            outcome,
            (task?.files ?? []).flatMap((f) => {
              const rel = relative(ctx.workingDir, resolvePath(ctx.workingDir, f));
              return rel.length === 0 || rel.startsWith("..") || isAbsolute(rel) ? [] : [rel];
            }),
          );
        }
        if (wave.inPlace !== undefined) gateState.noteInPlace();
        else {
          const conflicted = new Map(
            wave.outcomes.map((o) => [o.taskId, o.conflicts.length > 0] as const),
          );
          for (const t of tasks) {
            const c = conflicted.get(t.id);
            mergeOutcomes.set(t.id, c === undefined ? "held" : c ? "conflict" : "merged");
          }
        }
        merges.push(...wave.merges);
        run?.recordMerges(wave.merges);
        for (const row of wave.results) {
          if (!awaitsExpansion(row)) run?.recordTask(row);
        }
        return wave.results;
      };
      const runOnLeg = (
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        taskWorkspace:
          | ((
              taskId: string,
            ) => { workingDir: string; writeScope: readonly string[] } | undefined)
          | undefined,
        allowSplit: boolean,
        concurrentTaskIds: readonly string[],
      ): Promise<WorkerTaskResult[]> =>
        runWorkerTasks(
          // Workers run in the parent's folder in every model mode, so a
          // live folder switch reaches them too (#1121). Only cloud
          // workers inherit the parent's workspace.
          { ...workerDeps, workingDir: ctx.workingDir, ...(ctx.modelMode === "cloud" ? { inheritWorkspace: true } : {}) },
          {
            ...(originalRequest === undefined ? {} : { originalRequest }),
            ...(contract === undefined ? {} : { contract }),
            parentSessionId: ctx.sessionId,
            tasks,
            concurrentTaskIds,
            maxWorkers,
            providerId: workerProviderId,
            workerModel,
            workerMaxSteps: mode.workerMaxSteps,
            workerTimeoutMs: mode.workerTimeoutMs,
            localTokensPerSecond,
            localLeg: Number.isFinite(poolSize),
            ...(mode.workerReasoning === undefined
              ? {}
              : { workerReasoning: mode.workerReasoning }),
            ...(workerMaxOutputTokens === undefined
              ? {}
              : { workerMaxOutputTokens }),
            writeScope,
            signal: runSignal,
            ...guardOptionsFor(workerProviderId, workerPricing),
            ...escalationOptions,
            ...(briefSuffix === undefined ? {} : { briefSuffix }),
            ...(workerPricing === undefined ? {} : { workerPricing }),
            ...(taskWorkspace === undefined ? {} : { taskWorkspace }),
            ...(allowSplit && canProposeSplit !== undefined
              ? { canProposeSplit }
              : {}),
          },
        );
      // A role model's leg (ATO-943): its own provider, label, price and
      // width. A cloud leg takes the cloud cap; a second local server is
      // one at a time, since its slots are nobody's measurement. The
      // escalation target is dropped where it is this very provider.
      const rolePricing = new Map(
        [...roleLegs.values()].map((leg) => [
          leg.providerId,
          deps.resolveWorkerPricing?.(leg.providerId, leg.model),
        ]),
      );
      const runOnRoleLeg = (
        leg: TaskLeg,
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        taskWorkspace:
          | ((
              taskId: string,
            ) => { workingDir: string; writeScope: readonly string[] } | undefined)
          | undefined,
        allowSplit: boolean,
        concurrentTaskIds: readonly string[],
      ): Promise<WorkerTaskResult[]> => {
        const local = deps.workerSupportsSlotAffinity(leg.providerId);
        const pricing = rolePricing.get(leg.providerId);
        const roles = new Set(
          tasks.map((t) => taskLegs.get(t.id)?.role ?? "-"),
        );
        const onlyRole = roles.size === 1 ? [...roles][0] : "-";
        return runWorkerTasks(
          { ...workerDeps, workingDir: ctx.workingDir, ...(ctx.modelMode === "cloud" ? { inheritWorkspace: true } : {}) },
          {
            ...(originalRequest === undefined ? {} : { originalRequest }),
            ...(contract === undefined ? {} : { contract }),
            parentSessionId: ctx.sessionId,
            tasks,
            concurrentTaskIds,
            maxWorkers: local
              ? 1
              : Math.max(
                  1,
                  Math.min(
                    tasks.length,
                    mode.cloudWorkers ?? DEFAULT_FUSION_CLOUD_WORKERS,
                    // The strong leg's turns are the costly ones (or a
                    // subscription's request quota): a modest width.
                    leg.orchestrator === true
                      ? ORCHESTRATOR_TASK_MAX_WIDTH
                      : Number.POSITIVE_INFINITY,
                  ),
                ),
            providerId: leg.providerId,
            workerModel:
              onlyRole === "-" ? leg.model : `${leg.model} (${onlyRole})`,
            workerMaxSteps: mode.workerMaxSteps,
            workerTimeoutMs: mode.workerTimeoutMs,
            localTokensPerSecond: null,
            localLeg: local,
            ...(mode.workerReasoning === undefined
              ? {}
              : { workerReasoning: mode.workerReasoning }),
            ...(mode.workerMaxOutputTokens === undefined
              ? {}
              : { workerMaxOutputTokens: mode.workerMaxOutputTokens }),
            writeScope,
            signal: runSignal,
            ...guardOptionsFor(leg.providerId, pricing),
            // An orchestrator task already runs on the strongest model
            // the session holds: whichever escalation provider is
            // configured, it can only be the same or a weaker one.
            ...(escalationTarget?.providerId === leg.providerId ||
            leg.orchestrator === true
              ? {}
              : escalationOptions),
            ...(briefSuffix === undefined ? {} : { briefSuffix }),
            ...(pricing === undefined ? {} : { workerPricing: pricing }),
            ...(taskWorkspace === undefined ? {} : { taskWorkspace }),
            ...(allowSplit && canProposeSplit !== undefined
              ? { canProposeSplit }
              : {}),
          },
        );
      };
      // Every leg's share of a wave runs at once; rows come back in the
      // caller's task order. No role legs: exactly the old single call.
      const runAcrossLegs = async (
        tasks: readonly DelegateTask[],
        contract: DelegateContract | undefined,
        briefSuffix: ((taskId: string) => string | undefined) | undefined,
        taskWorkspace:
          | ((
              taskId: string,
            ) => { workingDir: string; writeScope: readonly string[] } | undefined)
          | undefined,
        allowSplit: boolean,
      ): Promise<WorkerTaskResult[]> => {
        // The whole run of tasks, whichever leg each lands on: what a
        // worker's self-check must not ask of it (`concurrentPaths`).
        const concurrent = tasks.map((t) => t.id);
        if (roleLegs.size === 0) {
          return runOnLeg(tasks, contract, briefSuffix, taskWorkspace, allowSplit, concurrent);
        }
        const onWorkerLeg = tasks.filter(
          (t) => taskLegs.get(t.id)?.isWorkerLeg !== false,
        );
        const groups = await Promise.all([
          onWorkerLeg.length === 0
            ? Promise.resolve<WorkerTaskResult[]>([])
            : runOnLeg(onWorkerLeg, contract, briefSuffix, taskWorkspace, allowSplit, concurrent),
          ...[...roleLegs.values()].map((leg) => {
            const mine = tasks.filter((t) => {
              const own = taskLegs.get(t.id);
              return own?.isWorkerLeg === false && own.providerId === leg.providerId;
            });
            return mine.length === 0
              ? Promise.resolve<WorkerTaskResult[]>([])
              : runOnRoleLeg(leg, mine, contract, briefSuffix, taskWorkspace, allowSplit, concurrent);
          }),
        ]);
        const byId = new Map(groups.flat().map((r) => [r.id, r]));
        return tasks.flatMap((t) => {
          const row = byId.get(t.id);
          return row === undefined ? [] : [row];
        });
      };
      // A proposal's children: run through the same runner (width, caps,
      // approval scope), then their own contract is checked before their
      // parent closes on them.
      const expandWave = async (
        tasks: readonly DelegateTask[],
        rows: WorkerTaskResult[],
      ): Promise<WorkerTaskResult[]> => {
        if (tree === undefined) return rows;
        const proposed = new Set(rows.filter(awaitsExpansion).map((r) => r.id));
        const expanded = await expandSplits(tasks, rows, {
              tree,
              workingDir: ctx.workingDir,
              ...(parsed.contract === undefined
                ? {}
                : { parentContract: parsed.contract }),
              workerMaxSteps: mode.workerMaxSteps,
              workerTimeoutMs: mode.workerTimeoutMs,
              runChildren: (children, childContract, suffix) => {
                // A split stays on the leg its parent ran on and is billed at.
                for (const child of children) {
                  const parentId = tree.parentOf(child.id);
                  const leg =
                    parentId === undefined ? undefined : taskLegs.get(parentId);
                  if (leg !== undefined) taskLegs.set(child.id, leg);
                }
                return runTasks(children, childContract, suffix, true);
              },
              evaluateChildren: async (rows, children, childContract) => {
                const provides = await inspectContractProvides(
                  childContract,
                  children,
                  ctx.workingDir,
                  { results: rows, signal: runSignal },
                );
                const checks = await runContractChecks(
                  childContract.checks ?? [],
                  deps.runChecks,
                  {
                    workingDir: ctx.workingDir,
                    signal: runSignal,
                    ...(deps.knownSecrets === undefined
                      ? {}
                      : { knownSecrets: deps.knownSecrets() }),
                  },
                );
                const failedChecks = checks.outcomes
                  .filter((o) => o.task === undefined && !o.ok)
                  .map((o) => o.detail);
                return {
                  rows: applyCheckOutcomes(
                    applyContractFindings(rows, provides.findings),
                    checks.outcomes,
                  ),
                  ...(failedChecks.length === 0 ? {} : { failedChecks }),
                };
              },
              mayStart: () =>
                !ctx.signal.aborted &&
                stoppedBy === undefined &&
                budgetStop() === undefined,
            });
        // The closed parents. One a stop cut short stays unsettled, so a
        // resume runs it again instead of reporting half a split.
        for (const row of expanded) {
          if (proposed.has(row.id) && (row.status === "ok" || !ctx.signal.aborted)) {
            run?.recordTask(row);
          }
        }
        return expanded;
      };

      const fanoutStartedAt = Date.now();
      const endLiveFanout = formatCheck.beginFanout(checkedServers);
      try {
        let results: WorkerTaskResult[];
        try {
          // A resume starts with what finished before the restart, and with
          // the tasks that wait for the person's yes; neither runs here.
          const finished = new Map<string, WorkerTaskResult>(
            resume === undefined
              ? []
              : [...resume.carried, ...resume.needsConfirmation].map((r) => [
                  r.id,
                  r,
                ]),
          );
          // Workers are about to start: this round counts toward the
          // turn's caps (ATO-1406), with only the tasks it will run — a
          // resume's finished ones are not counted twice.
          if (tracksTurn) {
            turnBudget.noteRound(
              ctx.sessionId,
              parsed.tasks.filter((t) => !finished.has(t.id)).length,
            orchestratorTaskIds.filter((id) => !finished.has(id)).length,
            );
          }
          // Worker completion alone does not establish that a required
          // artifact is usable. Verify providers before releasing consumers,
          // including rows carried from a checkpoint. Retry policy is separate.
          const verifiedProviders = new Set<string>();
          // A `no_changes` provider whose required artifacts already exist
          // and pass the same verification as an `ok` one releases its
          // dependents; its own row stays `no_changes`.
          const releasedNoChanges = new Set<string>();
          const previouslyReleased = new Set<string>();
          const verifyProvider = async (id: string): Promise<void> => {
            if (verifiedProviders.has(id)) return;
            verifiedProviders.add(id);
            const rechecking = previouslyReleased.has(id);
            previouslyReleased.add(id);
            const original = finished.get(id);
            const noChanges = original?.status === "no_changes";
            if (original === undefined || (original.status !== "ok" && !noChanges)) return;
            // A candidate promotes only all-ok rows, so a released consumer's
            // work could never be delivered: hold it instead.
            if (noChanges && candidate !== undefined) return;
            let row: WorkerTaskResult | undefined = noChanges ? { ...original, status: "ok" } : original;
            let ranEvidence = false;
            const names = new Set((parsed.contract?.requires ?? []).map((r) => r.name));
            const required = (parsed.contract?.provides ?? []).filter(
              (p) => p.task === id && names.has(p.name),
            );
            if (required.length === 0) return;
            const task = parsed.tasks.find((t) => t.id === id)!;
            // F44 permits pathless `other` completion tokens as advisory
            // ordering. They are never evidence that an artifact exists.
            const verifiable = required.filter((p) => p.kind !== "other" ||
              provideSearchPaths(p, parsed.contract!, task).length > 0);
            // Advisory tokens are no evidence for a worker that wrote nothing.
            if (noChanges && verifiable.length < required.length) return;
            const report = await inspectContractProvides(
              { ...parsed.contract, provides: verifiable }, [task], ctx.workingDir,
              { results: [row], signal: runSignal },
            );
            row = applyContractFindings([row], report.findings)[0]!;
            if (report.findings.length !== verifiable.length || report.findings.some((f) => !f.present)) {
              row = { ...row, status: "failed", error: "dependency: required provides are missing or cannot be verified" };
            }
            if (row.status === "ok") {
              const stale = gateState.staleCheckIndices();
              const own = (parsed.contract?.checks ?? []).flatMap((check, index) =>
                check.task === id && (rechecking || !gateState.checkOutcomes.has(index) || stale.has(index))
                  ? [{ check, index }] : [],
              );
              const checks = await runContractChecks(own.map((c) => c.check), deps.runChecks, {
                workingDir: ctx.workingDir, signal: runSignal,
                ...(deps.knownSecrets === undefined ? {} : { knownSecrets: deps.knownSecrets() }),
              });
              const previous = own.flatMap((c) => {
                const outcome = dependencyCheckOutcomes.get(c.index) ?? gateState.checkOutcomes.get(c.index);
                return outcome === undefined ? [] : [outcome];
              });
              own.forEach((c, i) => {
                const outcome = checks.outcomes[i];
                if (outcome !== undefined) dependencyCheckOutcomes.set(c.index, outcome);
              });
              row = applyPostMergeChecks([row], checks.outcomes, previous)[0]!;
              ranEvidence ||= checks.checksSkipped === undefined && checks.outcomes.length > 0 && checks.outcomes.length === own.length && checks.outcomes.every((o) => o.ok);
              if (checks.checksSkipped !== undefined) {
                row = { ...row, status: "needs_orchestrator", error: `dependency: ${checks.checksSkipped}` };
              }
            }
            // A fresh task-level gate covers its changed/declared paths,
            // not an unchanged required artifact inferred from its contract.
            const files = [...new Set([...(task.files ?? []), ...report.findings.flatMap((f) => f.where)])];
            const gatedPaths = new Set(syntaxPassFiles(row, task).map((file) => resolvePath(ctx.workingDir, file)));
            const uncovered = files.some((file) => !gatedPaths.has(resolvePath(ctx.workingDir, file)));
            if (row.status === "ok" && (rechecking || !gateState.syntaxGated.has(id) || gateState.isStale(id) || uncovered)) {
              [row] = await runSyntaxPass([row], [{ ...task, files }], {
                runner: deps.syntaxCheck, workingDir: ctx.workingDir, roots: syntaxRoots, signal: runSignal,
                ...(deps.knownSecrets === undefined ? {} : { knownSecrets: deps.knownSecrets() }),
              });
              const syntax = row!.syntax;
              ranEvidence ||= syntax !== undefined && syntax.error === undefined && syntax.checked > 0 && syntax.failedFiles.length === 0;
            }
            if (noChanges) {
              // Artifact presence alone is no evidence: at least one own check
              // or syntax check must actually have run here and passed.
              if (row!.status === "ok" && ranEvidence) releasedNoChanges.add(id);
              return;
            }
            if (row!.status !== "ok") gateState.verdicts.delete(id);
            finished.set(id, row!);
            run?.recordTask(row!);
          };
          for (const [waveIndex, wave] of plan.waves.entries()) {
            // An intervening worker can change check inputs through a shell,
            // even with no file-tool telemetry. Deduplicate only this release.
            verifiedProviders.clear();
            releasedNoChanges.clear();
            for (const id of wave) {
              for (const provider of plan.dependencies.get(id) ?? []) await verifyProvider(provider);
            }
            waveWarnings.push(
              ...dependencyWarnings(wave, plan.dependencies, finished),
            );
            // Fresh each wave, not accumulated: the notes are recomputed
            // from everything finished so far, so appending them to the
            // running warning list would repeat every earlier wave.
            const contract = contractForWave(parsed.contract, [
              ...waveWarnings,
              ...completedWaveNotes(finished),
            ]);
            // Dependency readiness is mandatory; autoReplan only decides
            // whether the planner is asked to retry the held work.
            const held = wave.filter((id) =>
                    !finished.has(id) &&
                    (plan.dependencies.get(id) ?? []).some((provider) => {
                      const done = finished.get(provider);
                      return done?.status !== "ok" && !releasedNoChanges.has(provider);
                    }),
                  );
            for (const id of held) {
              const task = parsed.tasks.find((t) => t.id === id)!;
              const waitingOn = (plan.dependencies.get(id) ?? []).filter(
                (provider) => {
                  const done = finished.get(provider);
                  return done?.status !== "ok" && !releasedNoChanges.has(provider);
                },
              );
              finished.set(
                id,
                notStartedResult(
                  task,
                  `${autoReplan > 0 ? "held for the replan" : "dependency blocked"}: it depends on ${waitingOn.join(", ")}, which did not close${plan.cycle === undefined ? "" : `; ${plan.cycle}`}`,
                ),
              );
            }
            const waveTasks = parsed.tasks.filter(
              (t) =>
                wave.includes(t.id) &&
                !held.includes(t.id) &&
                !finished.has(t.id),
            );
            const waveResults = await expandWave(
              waveTasks,
              await runTasks(waveTasks, contract, waveSuffix, true),
            );
            for (const result of waveResults) finished.set(result.id, result);
            run?.recordWave(waveIndex + 1);
          }
          // In the caller's task order, whatever wave each ran in.
          results = parsed.tasks.flatMap((t) => {
            const result = finished.get(t.id);
            return result === undefined ? [] : [result];
          });
        } catch (err) {
          // `runWorkerTasks` is written not to throw; if it ever does, the
          // orchestrator still gets a readable result rather than a dead turn.
          // The checkpoint stays: what finished can still be resumed.
          run?.finish("interrupted");
          await releaseKept();
          return error(
            `the fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
            { reason: "fan-out-failed" },
          );
        }
        // Each task this call actually started is one attempt at it this
        // turn; the replan bound (ATO-941) is counted against these. A task
        // held or kept from starting has not been tried. Counted with
        // autoReplan off too: the outcome log's `attempt` must see the
        // orchestrator's own re-delegation of a failed task.
        const ranNow = new Set<string>();
        // Rows carried from before a restart (ATO-617) were not run now.
        const carried = new Set(resume?.carried.map((r) => r.id) ?? []);
        for (const r of results) {
          if (!(r.error ?? "").startsWith("not started:") && !carried.has(r.id)) {
            ranNow.add(r.id);
          }
        }
        // One round per family: a split's continuations (`t3.a`, `t3.b`)
        // count once, on the task they continue.
        turnBudget.noteRoundAttempts(ctx.sessionId, [...ranNow]);
        if (autoReplan > 0) {
          // Across rounds: a task that ran there once is not steered back.
          turnBudget.noteOrchestratorRuns(
            ctx.sessionId,
            [...ranNow].filter((id) => taskLegs.get(id)?.orchestrator === true),
          );
        }
        // What the failure breakers saw (ATO-1406): remembered for the
        // rest of the turn, so the next round on a broken leg is refused.
        const trips: BreakerTrip[] = [...breakers.values()]
          .map((b) => b.tripped())
          .filter((t): t is BreakerTrip => t !== undefined);
        // One trip per error per round: two legs stopping on the same
        // repeat are one round's evidence, not two.
        const seen = new Set<string>();
        for (const trip of trips) {
          if (seen.has(trip.signature)) continue;
          seen.add(trip.signature);
          turnBudget.noteTrip(ctx.sessionId, trip);
        }
        // Rows a cap cut short say so, so a cancelled worker is not read
        // as the operator's doing.
        let budgetStopped = stoppedBy as TurnBudgetStop | undefined;
        if (budgetStopped !== undefined && !ctx.signal.aborted) {
          const stopMessage = budgetStopped.message;
          results = results.map((r) =>
            r.status === "cancelled" && !r.error?.startsWith("not started:")
              ? {
                  ...r,
                  notes: [
                    ...(r.notes ?? []),
                    `stopped by the turn's cap: ${stopMessage}`,
                  ],
                }
              : r,
          );
        }

        // The contract's verdict, from the disk and the check runner, folded
        // into the rows BEFORE the head line counts them: a task whose
        // declared check failed is `failed` in the table the orchestrator
        // reads, not `ok` with a footnote.
        let contract: ContractReport | undefined;
        // Check outcomes in `contract.checks` order, for the judge.
        let checkOutcomes: readonly (ContractCheckOutcome | undefined)[] = [];
        // Folds the disk and the check runner into `rows`. Run once after
        // the waves and, for the tasks a judge sent back, once after their
        // retry — on the retried rows only, so nothing is applied twice.
        const evaluateContract = async (
          rows: WorkerTaskResult[],
          allRows: WorkerTaskResult[],
        ): Promise<WorkerTaskResult[]> => {
          if (parsed.contract === undefined) return rows;
          // `allRows` goes in so a task that never ran is not accused of
          // failing to provide: a cancelled fan-out leaves the disk empty
          // for reasons that are not the worker's.
          const provides = await inspectContractProvides(
            parsed.contract,
            parsed.tasks,
            ctx.workingDir,
            { results: allRows, signal: runSignal },
          );
          let out = applyContractFindings(rows, provides.findings);
          // A check a gate already ran in its task's workspace (isolation)
          // is not run again unless what reached the folder since differs
          // (`MergeGateState`: a three-way merge, a later merge into the
          // task's files, a wave in place); the rest run here, on the
          // merged folder.
          const allChecks = parsed.contract.checks ?? [];
          const stale = gateState.staleCheckIndices();
          const pending = allChecks.flatMap((check, index) =>
            gateState.checkOutcomes.has(index) && !stale.has(index) ? [] : [{ check, index }],
          );
          const checks = await runContractChecks(
            pending.map((p) => p.check),
            deps.runChecks,
            {
              workingDir: ctx.workingDir,
              signal: runSignal,
              ...(deps.knownSecrets === undefined
                ? {}
                : { knownSecrets: deps.knownSecrets() }),
            },
          );
          const ran = checks.outcomes.length === pending.length;
          out = applyPostMergeChecks(
            out,
            checks.outcomes,
            ran
              ? pending.flatMap((p) => {
                  const previous = dependencyCheckOutcomes.get(p.index) ??
                    (stale.has(p.index) ? gateState.checkOutcomes.get(p.index) : undefined);
                  return previous === undefined ? [] : [previous];
                })
              : [],
          );
          const byIndex = new Map(gateState.checkOutcomes);
          if (ran) {
            pending.forEach((p, i) => {
              const outcome = checks.outcomes[i]!;
              byIndex.set(p.index, outcome);
              if (!stale.has(p.index)) return;
              gateState.checkOutcomes.set(p.index, outcome);
              // Its gate verdict was green on files the folder no longer has.
              if (!outcome.ok && outcome.task !== undefined) {
                gateState.verdicts.delete(outcome.task);
              }
            });
          } else {
            // A stale verdict is no verdict.
            for (const index of stale) byIndex.delete(index);
          }
          const allOutcomes = allChecks.flatMap((_, i) => {
            const outcome = byIndex.get(i);
            return outcome === undefined ? [] : [outcome];
          });
          checkOutcomes =
            allOutcomes.length === allChecks.length ? allOutcomes : [];
          // What the call was run with despite the contract — a require
          // nobody provides, a provide nothing can check, a cycle in the
          // requires, a provider that had not delivered when its dependent
          // ran. The workers read it in their block; the orchestrator
          // reads it here, on the line and in the details.
          const warnings = [...(parsed.contract.warnings ?? []), ...waveWarnings];
          contract = {
            findings: provides.findings,
            ...(provides.providesSkipped === undefined
              ? {}
              : { providesSkipped: provides.providesSkipped }),
            checks: allOutcomes,
            ...(checks.checksSkipped === undefined
              ? {}
              : { checksSkipped: checks.checksSkipped }),
            ...(warnings.length === 0 ? {} : { warnings }),
          };
          return out;
        };
        // The delegate's own syntax pass (`syntax-pass.ts`): the green
        // rows' changed files through `verify.syntax`'s checker, inside the
        // session's read scope, before the judge and the head line see
        // them. A failure demotes the row as a failed check does.
        // Under isolation the gate already ran it in each merged task's
        // workspace (`merge-gate.ts`); here it covers the rest (a wave
        // that ran in place, isolation off).
        const syntaxPass = async (
          rows: readonly WorkerTaskResult[],
        ): Promise<WorkerTaskResult[]> => {
          const pending = rows.filter(
            (r) => !gateState.syntaxGated.has(r.id) || gateState.isStale(r.id),
          );
          // Re-checked on the folder from here on.
          gateState.settle(rows.map((r) => r.id));
          if (pending.length === 0) return [...rows];
          const checked = await runSyntaxPass(pending, parsed.tasks, {
            runner: deps.syntaxCheck,
            workingDir: ctx.workingDir,
            roots: syntaxRoots,
            signal: runSignal,
            ...(deps.knownSecrets === undefined
              ? {}
              : { knownSecrets: deps.knownSecrets() }),
          });
          for (const row of checked) {
            if (row.status === "failed" && gateState.syntaxGated.has(row.id)) {
              gateState.verdicts.delete(row.id);
            }
          }
          return rows.map((r) => checked.find((c) => c.id === r.id) ?? r);
        };
        results = await syntaxPass(await evaluateContract(results, results));

        // The judge (ATO-944): a task closes on a green acceptance list, a
        // red list is re-run once with the findings, and a list still red
        // after that is a failed task, item by item. Its spend counts
        // toward the turn's cap.
        if (judging && judgeTarget !== null) {
          const judgeRows = async (
            rows: readonly WorkerTaskResult[],
          ): Promise<Map<string, JudgeVerdict>> => {
            const verdicts = new Map<string, JudgeVerdict>();
            for (const row of rows) {
              // Already ruled on in its workspace, before its merge.
              const gated = gateState.verdicts.get(row.id);
              if (gated !== undefined) {
                verdicts.set(row.id, gated);
                continue;
              }
              if (!judgeable(row)) continue;
              const task = parsed.tasks.find((t) => t.id === row.id)!;
              verdicts.set(
                row.id,
                await judgeOne({
                  task,
                  items: acceptance.get(row.id) ?? [],
                  facts: {
                    checkOutcomes,
                    findings: contract?.findings ?? [],
                  },
                  reply: row.reply,
                  contract: parsed.contract,
                  workingDir: ctx.workingDir,
                  // No snapshot of the folder before the wave: file heads.
                  changes: [],
                }),
              );
            }
            return verdicts;
          };
          const first = await judgeRows(results);
          const red = [...first].filter(
            ([, v]) => !v.green && v.unverified === undefined,
          );
          const retryIds = new Set(
            budgetStop() === undefined && !ctx.signal.aborted
              ? red.map(([id]) => id)
              : [],
          );
          let second = new Map<string, JudgeVerdict>();
          if (retryIds.size > 0) {
            const findings = new Map(
              red.map(([id, verdict]) => [
                id,
                renderRetryFindings(acceptance.get(id) ?? [], verdict),
              ]),
            );
            // The retry keeps the right to split: a task judged red for being
            // too big would only fail again in one piece.
            const retryTasks = parsed.tasks.filter((t) => retryIds.has(t.id));
            // Under isolation the retry works on in the workspace it was
            // judged red in, so its first attempt is there to fix; the
            // retry's own gate rules on it before it merges.
            for (const id of retryIds) gateState.verdicts.delete(id);
            retryRound = true;
            const retried = await expandWave(
              retryTasks,
              await runTasks(
                retryTasks,
                contractForWave(parsed.contract, [...waveWarnings]),
                (taskId) =>
                  [waveSuffix?.(taskId), findings.get(taskId)]
                    .filter((part): part is string => part !== undefined)
                    .join("\n\n"),
                true,
              ),
            );
            const merged = results.map(
              (r) => retried.find((x) => x.id === r.id) ?? r,
            );
            // The retried rows, and any task the retry's merges made stale.
            const evaluated = await syntaxPass(
              await evaluateContract(
                merged.filter((r) => retryIds.has(r.id) || gateState.isStale(r.id)),
                merged,
              ),
            );
            results = merged.map(
              (r) => evaluated.find((x) => x.id === r.id) ?? r,
            );
            second = await judgeRows(results.filter((r) => retryIds.has(r.id)));
          }
          results = results.map((r) => {
            if (retryIds.has(r.id)) {
              const verdict = second.get(r.id);
              // A retry that did not come back judgeable (it failed or was
              // cancelled) keeps its own status; the first verdict stands
              // beside it.
              if (verdict !== undefined) return applyJudgeVerdict(r, verdict, true);
              const before = first.get(r.id)!;
              return {
                ...r,
                notes: [
                  ...(r.notes ?? []),
                  `judge: ${redItems(before).length} of ${before.items.length} acceptance items were not met before the retry; the retry ended ${r.status} and was not judged`,
                ],
              };
            }
            const verdict = first.get(r.id);
            return verdict === undefined ? r : applyJudgeVerdict(r, verdict, false);
          });
        }
        // Workspaces kept for a retry are done with, retried or not.
        await releaseKept();
        results = await collectTaskArtifactManifests(results, parsed.tasks, {
          workingDir: ctx.workingDir, roots: syntaxRoots, signal: runSignal,
          ...(parsed.contract === undefined ? {} : { contract: parsed.contract }),
          checkOutcomes, findings: contract?.findings ?? [],
        });
        for (const row of results) {
          if (row.artifactManifest !== undefined) run?.recordArtifactManifest(row.id, row.artifactManifest);
        }
        // Automatic replanning (ATO-941): what did not close, from the
        // facts above, with the attempts it has left. The planner's next
        // step is held to `fusion.delegate` by the loop while any task is
        // pending (`fusion-replan.ts`); exhausted tasks are to be reported.
        // A task waiting for the person's yes after a restart is theirs to
        // decide: held to `fusion.delegate`, the planner could only repeat
        // the commands the question exists to guard.
        const awaitingYes = new Set(
          resume?.needsConfirmation.map((r) => r.id) ?? [],
        );
        const replan =
          autoReplan > 0 &&
          stoppedBy === undefined &&
          trips.length === 0 &&
          !ctx.signal.aborted
            ? describeReplan(
                results.filter((r) => !awaitingYes.has(r.id)),
                (id) => turnBudget.attempts(ctx.sessionId, id),
                autoReplan,
              (id) => turnBudget.ranOnOrchestrator(ctx.sessionId, id),
              // Only steer there while the target is on and under its cap.
              orchestratorLegRef !== undefined &&
                orchestratorCap > 0 &&
                (!tracksTurn ||
                  turnBudget.orchestratorTasks(ctx.sessionId) < orchestratorCap),
              )
            : undefined;
      // How this round's families ended, judged rows included: a family
      // that closed green is no longer one a dotted id can continue.
      if (ranNow.size > 0) {
        turnBudget.noteRoundOutcomes(
          ctx.sessionId,
          results
            .filter((r) => ranNow.has(r.id))
            .map((r) => ({ id: r.id, open: isOpenResult(r) })),
        );
      }
        const contractLine =
          contract === undefined ? undefined : renderContractLine(contract);
        // The run ended here. Stopped by the person or by a quit, its file
        // stays for a resume, and so it does while a task waits for the
        // person's yes: the confirm call resumes from it. Otherwise there
        // is nothing left to resume.
        run?.finish(
          ctx.signal.aborted || (resume?.needsConfirmation.length ?? 0) > 0
            ? "interrupted"
            : "complete",
        );
        const resumeNote =
          resume === undefined
            ? ""
            : `\n\nResumed run ${resume.runId}: ${resume.carried.length} task${resume.carried.length === 1 ? "" : "s"} reported from before the restart, ${resume.rerun.length} run again${
                resume.needsConfirmation.length === 0
                  ? ""
                  : `, ${resume.needsConfirmation.length} not run again until the person agrees (${resume.needsConfirmation.map((r) => r.id).join(", ")})`
              }.`;
        const checkpointNote = run?.checkpointWarning === undefined ? "" :
          `\n\nThis Fusion run cannot be resumed: ${run.checkpointWarning}. Plan any remaining work again after an interruption.`;

        // Where each task ran (ATO-943): the model and role on the row, and
        // a note when it is not the worker leg or not where it asked to be.
        // Without roles and without a task naming a model, rows are as before.
        if (mode.roles !== undefined || roleLegs.size > 0) {
          results = results.map((r) => {
            const leg = taskLegs.get(r.id);
            if (leg === undefined) return r;
            const notes = [
              ...(leg.note === undefined ? [] : [leg.note]),
              ...(leg.isWorkerLeg
                ? []
                : [
                    `ran on ${leg.model}${leg.orchestrator === true ? " (the orchestrator's model)" : leg.role === undefined ? "" : ` (role ${leg.role})`}`,
                  ]),
            // A subscription leg has no price: turnBudgetUsd cannot see
            // these turns, only the count cap does.
            ...(leg.orchestrator === true &&
            rolePricing.get(leg.providerId) === undefined
              ? [
                  "unpriced: counted against llm.runMode.fusion.maxOrchestratorTasksPerTurn, not turnBudgetUsd",
                ]
              : []),
            ];
            return {
              ...r,
              model: leg.model,
              ...(leg.role === undefined ? {} : { modelRole: leg.role }),
              ...(notes.length === 0 ? {} : { notes: [...(r.notes ?? []), ...notes] }),
            };
          });
        }
        let roleSpendUsd = 0;
        for (const [providerId, pricing] of rolePricing) {
          if (pricing === undefined) continue;
          roleSpendUsd += fanoutSpend(
            results.filter(
              (r) =>
                taskLegs.get(r.id)?.providerId === providerId &&
                taskLegs.get(r.id)?.isWorkerLeg === false,
            ),
            pricing,
            providerId,
          ).usd;
        }

        // …and takes the turn back. One line, so the operator can see the
        // spend return to the cloud leg instead of guessing which of the
        // lines above was the last worker.
        const okCount = results.filter((r) => r.status === "ok").length;
        deps.emitEvent(ctx.sessionId, {
          type: "fusion_worker",
          taskId: FUSION_DELEGATE_TOOL,
          title: `${results.length} task${results.length === 1 ? "" : "s"}`,
          phase: "finished",
          role: "orchestrator",
          model: orchestratorModel,
          summary: `${okCount}/${results.length} ok — merging`,
        });

        // When the pool is what held the fan-out down, the orchestrator is
        // the party that can adapt — by splitting differently next time,
        // or by telling the operator which knob to turn. So the note names
        // all three things it needs: what was wanted, what actually ran
        // concurrently, and the config key that changes the second number.
        const hint = poolIsBinding
          ? `\n\nNote: ${Math.max(wanted, legTaskCount)} workers' worth of work was sent but the local server has ${poolSize} request slot${poolSize === 1 ? "" : "s"}, so only ${maxWorkers} ran at a time and the rest queued. That number comes from the machine — every slot draws on one shared llama-server context pool (\`localModels.managed.parallel\`, \`"auto"\` by default). Split into fewer, larger tasks if the queueing is costing more than the parallelism buys.`
          : cloudCapIsBinding
            ? `\n\nNote: maxWorkers ${wanted} was clamped to ${maxWorkers}, the cloud worker cap (\`llm.runMode.fusion.cloudWorkers\`); the rest queued behind them.`
            : "";
        // The call's own status is the tasks' summary: a fan-out where
        // every worker failed used to come back `ok`, and an orchestrator
        // reading only the status merged nothing as if it were something.
        // Workers that were never served or timed out before a single step
        // count as nothing delivered too (ATO-234).
        const candidateReport = candidate === undefined ? undefined : await candidate.finish({ rows: results, tasks: parsed.tasks, ...(parsed.contract === undefined ? {} : { contract: parsed.contract }), ...(deps.runChecks === undefined ? {} : { runChecks: deps.runChecks }), signal: runSignal });
        const outcome = delegateOutcome(results);
        // The outcome log and the turn receipt (counts only, never the
        // brief, the reply or an error's words). A task kept from
        // starting never ran on its model and is left out.
        try {
          const ran = results.filter((r) => ranNow.has(r.id) && !(r.error ?? "").startsWith("not started:"));
          const now = new Date();
          const outcomeRows = ran.map((r) => {
            const leg = taskLegs.get(r.id);
            const providerId = leg?.providerId ?? workerProviderId;
            const legKind: OutcomeLeg =
              leg?.orchestrator === true
                ? "orchestrator"
                : deps.workerSupportsSlotAffinity(providerId)
                  ? "local"
                  : "cloud";
            const pricing =
              leg === undefined || leg.isWorkerLeg
                ? workerPricing
                : rolePricing.get(leg.providerId);
            return {
              row: r,
              record: taskOutcomeRecord(
                r,
                {
                  provider: providerId,
                  model: leg?.model ?? workerModel,
                  leg: legKind,
                  role: leg?.orchestrator === true ? "orchestrator" : (leg?.role ?? null),
                  taskRole: parsed.tasks.find((task) => task.id === r.id)?.role ?? null,
                  ...(executionIdentities.get(r.id) !== undefined && executionIdentities.get(r.id) === deps.resolveRoutingIdentity?.(providerId)
                    ? { routingIdentity: executionIdentities.get(r.id) } : {}),
                  attempt: turnBudget.attempts(ctx.sessionId, r.id),
                  pricing,
                  merge:
                    mode.isolation === "worktree" ? (mergeOutcomes.get(r.id) ?? null) : null,
                },
                ctx.sessionId,
                now,
              ),
              pricing,
            };
          });
          // Inner task evidence is not acceptance of the final candidate.
          // Candidate routing training stays off until promotion-aware records exist.
          if (candidate === undefined) deps.outcomeLog?.append(outcomeRows.map((o) => o.record));
          deps.turnLedger?.noteFanout(ctx.sessionId, {
            tasks: outcomeRows.map(({ row, record, pricing }) => ({
              ok: row.status === "ok",
              tokens: (row.usage?.promptTokens ?? 0) + (row.usage?.completionTokens ?? 0),
              durationMs: row.durationMs,
              costUsd: rowCostUsd(row, pricing),
              orchestrator: record.leg === "orchestrator",
            })),
            wallMs: now.getTime() - fanoutStartedAt,
            judgeCostUsd: judgeSpendUsd,
            escalationCostUsd: escalationSpendUsd,
          });
        } catch (err) {
          deps.logger.warn("fusion: the fan-out's outcomes were not recorded", {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        // What the fan-out cost on the worker leg, when its model is priced
        // (a cloud leg with a catalogue entry); a local leg resolves to no
        // pricing and the header says nothing.
        const spend =
          workerPricing === undefined
            ? null
            : fanoutSpend(
                roleLegs.size === 0
                  ? results
                  : results.filter(
                      (r) => taskLegs.get(r.id)?.isWorkerLeg !== false,
                    ),
                workerPricing,
                workerModel,
              );
        // The task tree, when any worker proposed a split (ATO-940); the
        // children themselves are summarised in their parent's block.
        const treeReport = tree?.report();
        const treeNote =
          treeReport === undefined ||
          treeReport.splits + treeReport.rejected === 0
            ? ""
            : `\n\nTask tree: ${treeReport.splits} task${treeReport.splits === 1 ? "" : "s"} split by their workers, ${treeReport.rejected} proposal${treeReport.rejected === 1 ? "" : "s"} refused, ${treeReport.nodes} of ${treeReport.maxNodes} nodes used (depth limit ${treeReport.maxDepth}).`;
        // In-flight completions and post-wave checks/judging may have
        // settled since the first stop. Report the final totals.
        budgetStopped = budgetStop() ?? stoppedBy;
        const budgetNote =
          budgetStopped === undefined
            ? ""
            : `\n\nStopped: ${budgetStopped.message}. ${TURN_BUDGET_INSTRUCTION}`;
        const breakerNote =
          trips.length === 0
            ? ""
            : `\n\nStopped: ${trips.map(describeTrip).join("; ")}. ${FAILURE_BREAKER_INSTRUCTION}`;
        const result = compressToolResult(
          {
            tool: FUSION_DELEGATE_TOOL,
            status: outcome === "all_failed" ? "error" : "ok",
            output: `${formatDelegateOutput(results, deps.outputCharCap, {
              ...(contractLine === undefined ? {} : { contractLine }),
              spend,
              ...(ordered ? { waves: plan.waves } : {}),
              // A green row of these shows its reply's first line only.
              declaredFiles: new Set(
                parsed.tasks
                  .filter((t) => (t.files?.length ?? 0) > 0)
                  .map((t) => t.id),
              ),
            })}${hint}${
              escalationSpendUsd > 0
                ? `\n\nEscalations to ${escalationTarget?.model ?? escalationTarget?.providerId ?? "the escalation model"} cost ${formatUsd(escalationSpendUsd)} this fan-out (each worker's row says what for).`
                : ""
            }${
              judgeSpendUsd > 0
                ? `\n\nThe judge (${judgeTarget?.model ?? judgeTarget?.providerId}) cost ${formatUsd(judgeSpendUsd)} this fan-out.`
                : ""
            }${
              roleSpendUsd > 0
                ? `\n\nRole models cost ${formatUsd(roleSpendUsd)} this fan-out.`
                : ""
            }${treeNote}${replan === undefined ? "" : renderReplanBlock(replan)}${renderMergeBlock(merges)}${resumeNote}${checkpointNote}${budgetNote}${breakerNote}${
              sizeWarnings.length === 0
                ? ""
                : `\n\nWarning: ${sizeWarnings.join("; ")}.`
            }`,
            details: {
              tasks: results,
              ...(routing === undefined ? {} : { routing: routing.decisions }),
              outcome,
              maxWorkers,
              requestedWorkers: requested,
              ...(Number.isFinite(poolSize) ? { slotPoolSize: poolSize } : {}),
              // The wave plan, for the orchestrator and the trace's tool
              // row alike — only when the contract ordered anything.
              ...(ordered ? { waves: plan.waves } : {}),
              ...(contract === undefined ? {} : { contract }),
              ...(spend === null ? {} : { workerSpendUsd: spend.usd }),
              ...(escalationSpendUsd > 0 ? { escalationSpendUsd } : {}),
              ...(judgeSpendUsd > 0 ? { judgeSpendUsd } : {}),
              ...(roleSpendUsd > 0 ? { roleSpendUsd } : {}),
              ...(merges.length === 0 ? {} : { merges }),
              ...(replan === undefined ||
            (replan.pending.length === 0 &&
              replan.exhausted.length === 0 &&
              replan.failedOnOrchestrator.length === 0)
                ? {}
                : { replan }),
              ...(treeReport === undefined ? {} : { taskTree: treeReport }),
              ...(sizeWarnings.length === 0 ? {} : { sizeWarnings }),
              ...(run === undefined ? {} : run.checkpointWarning === undefined
                ? { runId: run.runId } : { checkpointWarning: run.checkpointWarning }),
              ...(results.some(r => r.artifactManifest !== undefined) ? {
                artifactManifests: Object.fromEntries(results.flatMap(r => r.artifactManifest === undefined ? [] : [[r.id, r.artifactManifest]])),
              } : {}),
              ...(resume === undefined
                ? {}
                : {
                    resume: {
                      runId: resume.runId,
                      carried: resume.carried.map((r) => r.id),
                      rerun: resume.rerun,
                      needsConfirmation: resume.needsConfirmation.map(
                        (r) => r.id,
                      ),
                      carriedSpendUsd: resume.carriedSpendUsd,
                    },
                  }),
              ...(budgetStopped === undefined
                ? {}
                : {
                    turnBudget: {
                      kind: budgetStopped.kind,
                      spentUsd: budgetStopped.spentUsd,
                      elapsedMs: budgetStopped.elapsedMs,
                      ...(budgetStopped.conservativeUsd === undefined ? {} : { conservativeUsd: budgetStopped.conservativeUsd }),
                    },
                  }),
            },
          },
          { maxSummaryLength: deps.outputCharCap + 400, maxTailLines: 2000 },
        );
        return candidateReport === undefined ? result : candidateToolResult(result, candidateReport, candidate!.dir, candidateOriginalDir, deps.outputCharCap);
      } finally {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);
        // Kept workspaces (a judged-red task's, for its retry) are removed
        // whatever happens after the waves: a throw in the retry, the
        // contract pass, the syntax pass or the judge included.
        endLiveFanout();
        await releaseKept();
      }
      } catch (err) {
        if (candidate === undefined) throw err;
        const report = await candidate.reject(`candidate interrupted: ${err instanceof Error ? err.message : String(err)}`);
        return candidateToolResult(error("candidate fan-out interrupted", { reason: "candidate-interrupted" }), report, candidate.dir, candidateOriginalDir, deps.outputCharCap);
      } finally {
        await candidate?.cleanup();
      }
    },
  };
}

/** Rebase parsed JSON strings without changing path escaping or task identities. */
function rebaseCandidateValue<T>(value: T, roots: readonly string[], to: string): T {
  if (typeof value === "string") return rebaseText(value, roots, to) as T;
  if (Array.isArray(value)) return value.map(item => rebaseCandidateValue(item, roots, to)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [rebaseText(key, roots, to), rebaseCandidateValue(item, roots, to)])) as T;
  return value;
}

function candidateToolResult(result: CompressedToolResult, report: CandidateIntegrationReport, candidateDir: string, originalDir: string, cap: number): CompressedToolResult {
  const note = report.status === "promoted" ? "Candidate promoted after final integration checks." : `Candidate rejected; file promotion did not complete. ${report.reason ?? ""}`;
  const recovery = (report.patch === undefined ? "" : ` Changes retained at ${report.patch.path}${report.patch.filesDir === undefined ? "" : ` and ${report.patch.filesDir}`}.`) + (report.retainedWorkspace === undefined ? "" : ` Recovery workspace retained at ${report.retainedWorkspace}; remove it manually after recovery.`) + (report.heldArtifactsDir === undefined ? "" : ` Held task artifacts: ${report.heldArtifactsDir}.`) + (report.rollbackConflicts === undefined ? "" : ` Rollback left these concurrently changed or unwritable paths for review: ${report.rollbackConflicts.join(", ")}.`) + (report.ignoredChanges === undefined ? "" : ` Ignored or disposable paths kept private to the candidate, never promoted: ${report.ignoredChanges.join(", ")}.`);
  const details = rebaseCandidateValue(result.details, [candidateDir, candidateDir.replace(/\\/g, "/")], originalDir);
  delete details.runId;
  return compressToolResult({ tool: result.tool, status: report.status === "rejected" ? "error" : result.status, output: `${note}${recovery} Candidate mode is non-resumable.\n\n${rebaseText(result.fullOutput ?? result.summary, [candidateDir, candidateDir.replace(/\\/g, "/")], originalDir)}`, details: { ...details, candidateIntegration: report } }, { maxSummaryLength: cap + 800, maxTailLines: 2000 });
}

/**
 * What this round adds to the turn, for the fan-out's approval line
 * (ATO-1406): the round number and the tasks so far, each against its
 * cap when one is on. A subscription leg has no price to show, so the
 * count is what the person weighs before saying yes.
 */
export function describeTurnCounts(
  before: { rounds: number; tasks: number },
  taskCount: number,
  mode: Pick<ResolvedRunMode, "maxRoundsPerTurn" | "maxTasksPerTurn">,
): string {
  const round = before.rounds + 1;
  const tasks = before.tasks + taskCount;
  const roundCap =
    mode.maxRoundsPerTurn === undefined ? "" : ` of at most ${mode.maxRoundsPerTurn}`;
  const taskCap =
    mode.maxTasksPerTurn === undefined ? "" : ` of at most ${mode.maxTasksPerTurn}`;
  return ` (round ${round}${roundCap} this turn, ${tasks} task${tasks === 1 ? "" : "s"}${taskCap} in all)`;
}

/**
 * The arguments a checkpoint replays: the call's own, without the
 * resume keys, so a resumed run's file still describes the run.
 */
function checkpointArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "resume" && key !== "confirm"),
  );
}
