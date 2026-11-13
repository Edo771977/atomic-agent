import type { BreakerTrip } from "./failure-breaker.js";

/**
 * The per-turn caps of a fusion run (ATO-947): money and wall-clock time.
 *
 * A fusion turn used to have no ceiling but the 2-hour task limit: an
 * orchestrator that kept re-delegating to a cloud worker leg kept
 * spending. With `llm.runMode.fusion.turnBudgetUsd` / `turnTimeBudgetMs`
 * set, the turn stops starting new work once either is reached, stops
 * the workers still running, and the orchestrator is told to say so in
 * plain words. Both unset (the default): nothing here is consulted.
 *
 * The runtime's USD ledger reserves each physical text request before
 * sending, then settles usage (or a conservative bound if it is lost).
 * Carried/external spend is additive; usage display callbacks identify
 * already-accounted requests. Explicit local/subscription legs stay
 * unpriced; unknown paid pricing is refused by the runtime request seam.
 * Legacy embedders without that seam retain meter/worker observation.
 *
 * One instance per runtime, reset per fusion turn by the turn's own
 * start (`clearFanoutTurnGrant`), so a cap is never carried from one
 * message into the next.
 */
export interface TurnBudgetLimits {
  usd?: number;
  timeMs?: number;
}

export interface TurnBudgetStop {
  kind: "usd" | "time";
  /** Plain words for the orchestrator to pass on. */
  message: string;
  spentUsd: number;
  elapsedMs: number;
  /** Conservative charges for dispatched requests that never supplied final usage. */
  conservativeUsd?: number;
}

interface TurnState {
  active: boolean;
  startedAt: number;
  workerUsd: number;
  requestLimits?: TurnBudgetLimits;
  requestUsd: number;
  externalUsd: number;
  heldUsd: number;
  conservativeUsd: number;
  /** The orchestrator's meter reading when the turn began; spend is the delta. */
  orchestratorBaseUsd: number;
  /**
   * Task id → how many rounds ran it this turn (ATO-941's replans),
   * keyed by the family's root: a continuation (`t3.a`) counts on `t3`.
   */
  attempts: Map<string, number>;
  /** Continuation id → the root it continues (`continuationRoot`). */
  family: Map<string, string>;
  /**
   * Roots whose last round closed every member green
   * (`noteRoundOutcomes`). A dotted id is never a continuation of one:
   * `parse.dates` after a closed `parse` is new work.
   */
  closed: Set<string>;
  /** Roots that ran on the orchestrator leg (`model: "orchestrator"`) this turn. */
  onOrchestrator: Set<string>;
  /** Delegations started this turn, and the tasks they carried (ATO-1406). */
  rounds: number;
  tasks: number;
  /** Of those, the tasks sent to `model: "orchestrator"`. */
  orchestratorTasks: number;
  /** Every failure breaker that tripped this turn (ATO-1406). */
  trips: BreakerTrip[];
}

/**
 * The turn's count caps (ATO-1406): delegations ("rounds") and tasks.
 * Counted, not priced, because a subscription leg has no bill to read —
 * its limit is requests. `undefined`: that cap is off.
 */
export interface TurnCountLimits {
  rounds?: number;
  tasks?: number;
  /**
   * `model: "orchestrator"` tasks (`maxOrchestratorTasksPerTurn`). The
   * orchestrator leg is often a flat-rate subscription, unpriced, so
   * `turnBudgetUsd` cannot hold it; this count does.
   */
  orchestratorTasks?: number;
}

export interface TurnCountStop {
  kind: "rounds" | "tasks" | "orchestrator-tasks";
  message: string;
}

/**
 * The task a continuation id continues: `t3.a` (or `t3.a.x`) is `t3`'s
 * once `t3` ran earlier this turn and is still open (pending a replan
 * or out of them), else the id is its own root. The longest prefix that
 * ran wins, then its own root, so a split of a split still counts on
 * the first task. A prefix whose family closed green continues nothing.
 */
function continuationRoot(
  state: Pick<TurnState, "attempts" | "family" | "closed">,
  taskId: string,
): string {
  const known = state.family.get(taskId);
  if (known !== undefined) return known;
  if (state.attempts.has(taskId)) return taskId;
  for (
    let dot = taskId.lastIndexOf(".");
    dot > 0;
    dot = taskId.lastIndexOf(".", dot - 1)
  ) {
    if (dot === taskId.length - 1) continue;
    const prefix = taskId.slice(0, dot);
    const root =
      state.family.get(prefix) ??
      (state.attempts.has(prefix) ? prefix : undefined);
    if (root !== undefined && !state.closed.has(root)) return root;
  }
  return taskId;
}

export class FusionTurnBudget {
  private readonly turns = new Map<string, TurnState>();
  private readonly owners = new Map<string, { parent: string; state: TurnState }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A fusion turn starts on `sessionId`: its spend and clock start at
   * zero. `orchestratorBaseUsd` is what the orchestrator's meter already
   * reads (non-zero when the bucket outlives a turn, as on the sidecar).
   */
  begin(sessionId: string, orchestratorBaseUsd = 0, requestLimits?: TurnBudgetLimits): void {
    this.turns.set(sessionId, {
      active: true,
      startedAt: this.now(),
      workerUsd: 0,
      ...(requestLimits?.usd === undefined && requestLimits?.timeMs === undefined ? {} : { requestLimits: { ...requestLimits } }),
      requestUsd: 0, externalUsd: 0, heldUsd: 0, conservativeUsd: 0,
      orchestratorBaseUsd,
      attempts: new Map(),
      family: new Map(),
      closed: new Set(),
      onOrchestrator: new Set(),
      rounds: 0,
      tasks: 0,
      orchestratorTasks: 0,
      trips: [],
    });
  }

  private turn(sessionId: string): TurnState {
    let state = this.turns.get(sessionId);
    if (state === undefined) {
      // No turn start was seen (an embedder, a test): the clock starts
      // at the first fan-out instead.
      state = {
        active: true,
        startedAt: this.now(),
        workerUsd: 0,
        requestUsd: 0, externalUsd: 0, heldUsd: 0, conservativeUsd: 0,
        orchestratorBaseUsd: 0,
        attempts: new Map(),
        family: new Map(),
        closed: new Set(),
        onOrchestrator: new Set(),
        rounds: 0,
        tasks: 0,
        orchestratorTasks: 0,
        trips: [],
      };
      this.turns.set(sessionId, state);
    }
    return state;
  }

  addWorkerSpend(sessionId: string, usd: number, alreadyAccounted = false): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const state = this.turn(sessionId);
    state.workerUsd += usd;
    if (state.requestLimits?.usd !== undefined && !alreadyAccounted) state.externalUsd += usd;
  }

  /** Bind only while the worker is alive; retain the owning turn generation. */
  bindSession(sessionId: string, parent: string): void {
    this.owners.set(sessionId, { parent, state: this.turn(parent) });
  }

  unbindSession(sessionId: string): void { this.owners.delete(sessionId); }

  /** Keep receipts/counts, but do not apply an ended turn's policy to background work. */
  end(sessionId: string): void {
    const state = this.turns.get(sessionId);
    if (state !== undefined) state.active = false;
  }

  private requestState(sessionId: string): TurnState | undefined {
    const owner = this.owners.get(sessionId);
    if (owner !== undefined) {
      if (this.turns.get(owner.parent) !== owner.state || !owner.state.active) throw new Error("the request's owning turn has ended");
      return owner.state;
    }
    return this.turns.get(sessionId);
  }

  requestLimits(sessionId: string): TurnBudgetLimits | undefined {
    const state = this.requestState(sessionId);
    return state?.active ? state.requestLimits : undefined;
  }

  requestTimeLeftMs(sessionId: string): number | undefined {
    const state = this.requestState(sessionId);
    return state?.requestLimits?.timeMs === undefined ? undefined : state.requestLimits.timeMs - (this.now() - state.startedAt);
  }

  /** Synchronous admission prevents concurrent requests from sharing the same dollars. */
  reserveRequest(sessionId: string, upperUsd: number): { settle(actualUsd?: number): void; release(): void } {
    const state = this.requestState(sessionId);
    const cap = state?.requestLimits?.usd;
    if (state === undefined || !state.active || cap === undefined) throw new Error("no active USD request budget for this session");
    if (!Number.isFinite(upperUsd) || upperUsd < 0) throw new Error("request budget estimate is not finite");
    const committed = state.requestUsd + state.externalUsd;
    if (committed + state.heldUsd + upperUsd > cap + 1e-10) {
      throw new Error(`turn budget cannot cover this request: ${formatUsd(upperUsd)} reserved cost would exceed the ${formatUsd(cap)} cap (${formatUsd(committed)} accounted, ${formatUsd(state.heldUsd)} held)`);
    }
    state.heldUsd += upperUsd;
    let settled = false;
    const release = (): boolean => {
      if (settled) return false;
      settled = true;
      state.heldUsd = Math.max(0, state.heldUsd - upperUsd);
      return true;
    };
    return {
      release: () => { release(); },
      settle: actualUsd => {
        if (!release()) return;
        const known = actualUsd !== undefined && Number.isFinite(actualUsd) && actualUsd >= 0;
        state.requestUsd += known ? actualUsd : upperUsd;
        if (!known) state.conservativeUsd += upperUsd;
      },
    };
  }

  /** Count one run of `taskId` this turn; returns the count so far. */
  noteAttempt(sessionId: string, taskId: string): number {
    this.noteRoundAttempts(sessionId, [taskId]);
    return this.attempts(sessionId, taskId);
  }

  /**
   * Count one round's runs: each family the round ran is one attempt,
   * however many of its members ran. A replan may split a failed `t3`
   * into `t3.a` and `t3.b`; the split is one more attempt at `t3`, and
   * the children share its remaining replans, so splitting can neither
   * spend two replans at once nor mint fresh ones. Families are read
   * before anything is counted, so a task and a continuation of it that
   * are both new this round stay two families (nothing ran yet).
   */
  noteRoundAttempts(sessionId: string, taskIds: readonly string[]): void {
    const state = this.turn(sessionId);
    const roots = new Map(
      taskIds.map((id) => [id, continuationRoot(state, id)] as const),
    );
    for (const [id, root] of roots) {
      if (root !== id) state.family.set(id, root);
    }
    for (const root of new Set(roots.values())) {
      state.attempts.set(root, (state.attempts.get(root) ?? 0) + 1);
    }
  }

  /**
   * How this round's runs ended: a family whose members this round all
   * closed is closed, so a later dotted id (`parse.dates` after `parse`)
   * starts its own family instead of inheriting `parse`'s attempts. A
   * family with any member still open stays open; one that reopens (its
   * own id sent again and failing) is open again.
   */
  noteRoundOutcomes(
    sessionId: string,
    outcomes: readonly { id: string; open: boolean }[],
  ): void {
    const state = this.turn(sessionId);
    const open = new Map<string, boolean>();
    for (const { id, open: isOpen } of outcomes) {
      const root = continuationRoot(state, id);
      open.set(root, (open.get(root) ?? false) || isOpen);
    }
    for (const [root, isOpen] of open) {
      if (isOpen) state.closed.delete(root);
      else state.closed.add(root);
    }
  }

  /**
   * Tasks this round ran on the orchestrator leg, by family, so a later
   * round knows it already went there (`ranOnOrchestrator`). Call after
   * `noteRoundAttempts`, which files the continuations.
   */
  noteOrchestratorRuns(sessionId: string, taskIds: readonly string[]): void {
    const state = this.turn(sessionId);
    for (const id of taskIds) state.onOrchestrator.add(continuationRoot(state, id));
  }

  /** Whether `taskId`'s family ran on the orchestrator leg this turn. */
  ranOnOrchestrator(sessionId: string, taskId: string): boolean {
    const state = this.turns.get(sessionId);
    if (state === undefined) return false;
    return state.onOrchestrator.has(continuationRoot(state, taskId));
  }

  /** How many rounds ran `taskId`'s family this turn. */
  attempts(sessionId: string, taskId: string): number {
    const state = this.turns.get(sessionId);
    if (state === undefined) return 0;
    return state.attempts.get(continuationRoot(state, taskId)) ?? 0;
  }

  /** What this turn's delegations so far ran: rounds and tasks. */
  counts(sessionId: string): { rounds: number; tasks: number } {
    const state = this.turns.get(sessionId);
    return { rounds: state?.rounds ?? 0, tasks: state?.tasks ?? 0 };
  }

  /**
   * Whether a new delegation of `taskCount` tasks would pass a count
   * cap; the words that say so when it would. Checked before it starts.
   */
  checkCounts(
    sessionId: string,
    limits: TurnCountLimits,
    taskCount: number,
    orchestratorTaskCount = 0,
  ): TurnCountStop | undefined {
    const { rounds, tasks } = this.counts(sessionId);
    if (limits.rounds !== undefined && rounds + 1 > limits.rounds) {
      return {
        kind: "rounds",
        message:
          `this turn already ran ${rounds} delegation${rounds === 1 ? "" : "s"}, ` +
          `the most llm.runMode.fusion.maxRoundsPerTurn allows (${limits.rounds})`,
      };
    }
    if (limits.tasks !== undefined && tasks + taskCount > limits.tasks) {
      return {
        kind: "tasks",
        message:
          `${taskCount} more task${taskCount === 1 ? "" : "s"} would take this turn to ${tasks + taskCount}, ` +
          `over the ${limits.tasks} llm.runMode.fusion.maxTasksPerTurn allows (${tasks} already ran)`,
      };
    }
    const already = this.orchestratorTasks(sessionId);
    if (
      limits.orchestratorTasks !== undefined &&
      orchestratorTaskCount > 0 &&
      already + orchestratorTaskCount > limits.orchestratorTasks
    ) {
      return {
        kind: "orchestrator-tasks",
        message: orchestratorCapMessage(
          orchestratorTaskCount,
          already,
          limits.orchestratorTasks,
        ),
      };
    }
    return undefined;
  }

  /** `model: "orchestrator"` tasks this turn's delegations so far started. */
  orchestratorTasks(sessionId: string): number {
    return this.turns.get(sessionId)?.orchestratorTasks ?? 0;
  }

  /** Count a delegation that is starting, with its tasks. */
  noteRound(sessionId: string, taskCount: number, orchestratorTaskCount = 0): void {
    const state = this.turn(sessionId);
    state.rounds += 1;
    state.tasks += Math.max(0, taskCount);
    state.orchestratorTasks += Math.max(0, orchestratorTaskCount);
  }

  /** Remember a failure breaker that tripped this turn. */
  noteTrip(sessionId: string, trip: BreakerTrip): void {
    this.turn(sessionId).trips.push(trip);
  }

  trips(sessionId: string): readonly BreakerTrip[] {
    return this.turns.get(sessionId)?.trips ?? [];
  }

  workerSpend(sessionId: string): number {
    return this.turns.get(sessionId)?.workerUsd ?? 0;
  }

  /** Milliseconds left before the time cap, `undefined` without one. */
  timeLeftMs(sessionId: string, limits: TurnBudgetLimits): number | undefined {
    if (limits.timeMs === undefined) return undefined;
    return limits.timeMs - (this.now() - this.turn(sessionId).startedAt);
  }

  /** Whether a cap is reached, and the words that say so. */
  check(
    sessionId: string,
    limits: TurnBudgetLimits,
    orchestratorMeterUsd = 0,
  ): TurnBudgetStop | undefined {
    if (limits.usd === undefined && limits.timeMs === undefined) {
      return undefined;
    }
    const state = this.turn(sessionId);
    const orchestratorUsd = Math.max(
      0,
      orchestratorMeterUsd - state.orchestratorBaseUsd,
    );
    const elapsedMs = this.now() - state.startedAt;
    const spentUsd = state.requestLimits?.usd === undefined
      ? orchestratorUsd + state.workerUsd
      : state.requestUsd + state.externalUsd;
    if (limits.usd !== undefined && spentUsd >= limits.usd) {
      return {
        kind: "usd",
        spentUsd,
        elapsedMs,
        ...(state.conservativeUsd > 0 ? { conservativeUsd: state.conservativeUsd } : {}),
        message:
          `the spend cap for this turn is reached: ${formatUsd(spentUsd)} ${state.requestLimits?.usd === undefined ? "spent" : "accounted"} ` +
          (state.requestLimits?.usd === undefined
            ? `(${formatUsd(orchestratorUsd)} planning, ${formatUsd(state.workerUsd)} workers) `
            : `(${formatUsd(state.requestUsd)} requests, ${formatUsd(state.externalUsd)} carried or other spend) `) +
          `of the ${formatUsd(limits.usd)} allowed by llm.runMode.fusion.turnBudgetUsd`,
      };
    }
    if (limits.timeMs !== undefined && elapsedMs >= limits.timeMs) {
      return {
        kind: "time",
        spentUsd,
        elapsedMs,
        ...(state.conservativeUsd > 0 ? { conservativeUsd: state.conservativeUsd } : {}),
        message:
          `the time cap for this turn is reached: ${formatMinutes(elapsedMs)} ` +
          `of the ${formatMinutes(limits.timeMs)} allowed by llm.runMode.fusion.turnTimeBudgetMs`,
      };
    }
    return undefined;
  }
}

/**
 * Why a call's `model: "orchestrator"` tasks are refused: `asked` more
 * would pass `cap`, `already` having run this turn.
 */
export function orchestratorCapMessage(
  asked: number,
  already: number,
  cap: number,
): string {
  return (
    `${asked} task${asked === 1 ? "" : "s"} on \`model: "orchestrator"\` would take this turn to ${already + asked}, ` +
    `over the ${cap} llm.runMode.fusion.maxOrchestratorTasksPerTurn allows (${already} already ran)`
  );
}

/** What the orchestrator is told when the orchestrator-task cap refuses a call. */
export const ORCHESTRATOR_TASK_CAP_INSTRUCTION =
  'Nothing ran. Send those tasks again without `model: "orchestrator"` (on a worker model), or, if they cannot be done there, reply to the person in plain words: say which parts are left and that they can raise the cap.';

/** What the orchestrator is told when a count cap refuses a delegation. */
export const TURN_COUNT_INSTRUCTION =
  "Do not re-send the work and do not do it yourself. Reply to the person now, in plain words: say how many rounds and tasks already ran, what is done and what is not, and that they can say how to continue (or raise the cap).";

/** What the orchestrator is told to do once a cap stopped the work. */
export const TURN_BUDGET_INSTRUCTION =
  "No new delegations will run this turn. Do not do the remaining work yourself either: reply to the person now, in plain words — say that the cap stopped the work, what is done, what is not, and that they can raise the cap or say how to continue.";

export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return minutes < 1
    ? `${Math.max(0, Math.round(ms / 1000))} s`
    : `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
}
