import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";
import { OUTCOME_LOG_MAX_BYTES, outcomeLabel, type OutcomeRecord, type TaskOutcomeRecord } from "./outcome-log.js";
import { readOutcomeRecords } from "./outcome-report.js";
import type { TaskLeg, WorkerLegRef } from "./role-models.js";

/** Bounded observation window, even if an external writer ignored the rotation limit. */
export function readRoutingHistory(path: string): OutcomeRecord[] {
  try { return readOutcomeRecords(path, (file) => {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - OUTCOME_LOG_MAX_BYTES);
      const bytes = Buffer.alloc(Math.min(size, OUTCOME_LOG_MAX_BYTES));
      const count = readSync(fd, bytes, 0, bytes.length, start);
      const text = bytes.subarray(0, count).toString("utf8");
      // The first line may start in a multibyte sequence or mid-record.
      return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
    } finally { closeSync(fd); }
  }, { maxRecords: 10_000, accept: routingRecord });
  } catch { return []; } // History is advisory; corrupt/unavailable input keeps the default.
}

export interface RoutingEvidence {
  provider: string;
  model: string;
  samples: number;
  verifiedSamples: number;
  passed: number;
  passRate: number | null;
  selfReportedSuccesses: number;
  medianDurationMs: number | null;
  knownCostSamples: number;
  medianCostUsd: number | null;
  blocked: boolean;
  identityKnown: boolean;
}

export interface RoutingDecision {
  taskId: string;
  selectedProvider: string;
  selectedModel: string;
  reason: "pinned" | "retry-family" | "blocking-history" | "insufficient-evidence" | "default-preferred" | "measured-improvement";
  basis: "objective-task-checks";
  candidates: RoutingEvidence[];
  excluded: Array<{ provider: string; reason: string }>;
}

interface Candidate { leg: TaskLeg; local: boolean }

/**
 * How long a leg's latest transient blocking (non-quality) failure keeps
 * it out of automatic routing: a timeout, a cancellation, an overloaded
 * or unreachable server (`error`), and the like.
 */
export const ROUTING_BLOCK_COOLDOWN_MS = 24 * 3_600_000;

/**
 * Failure classes that do not heal on their own (rejected credentials,
 * no credit, a missing CLI, a tool-protocol mismatch). They block for
 * the whole history window: an expiring block would hand the broken leg
 * one real task per cooldown.
 */
const PERSISTENT_BLOCKERS: ReadonlySet<string> = new Set(["not-signed-in", "out-of-credit", "cli-missing", "tool-protocol"]);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function routingRecord(r: OutcomeRecord): boolean {
  return r.type === "task" && r.v === 1 && typeof r.provider === "string" && r.provider.length > 0 &&
    typeof r.model === "string" && r.model.length > 0 && Number.isFinite(Date.parse(r.ts)) &&
    (r.role === null || typeof r.role === "string") && (r.taskRole === undefined || r.taskRole === null || typeof r.taskRole === "string") &&
    ["ok", "no_changes", "failed", "cancelled", "needs_orchestrator", "max_steps", "timeout", "queued"].includes(r.status) &&
    (r.failure === null || typeof r.failure === "string") && Number.isInteger(r.attempt) && r.attempt > 0 &&
    typeof r.judgeRetried === "boolean" && typeof r.selfCheckNotice === "boolean" && finite(r.escalations) &&
    finite(r.durationMs) && (r.costUsd === null || finite(r.costUsd));
}

function evidence(records: readonly OutcomeRecord[], leg: TaskLeg, task: DelegateTask, since: number, now: number, identity: string | undefined): RoutingEvidence {
  // Labels are privacy-sanitized by the existing log. A path-like target cannot
  // be attributed exactly, so its history cannot drive automatic selection.
  const exactLabels = outcomeLabel(leg.providerId) === leg.providerId && outcomeLabel(leg.model) === leg.model;
  const rows = exactLabels ? records.filter((r): r is TaskOutcomeRecord => r.type === "task" && r.v === 1 &&
    r.provider === leg.providerId && r.model === leg.model &&
    (r.taskRole === (task.role ?? null) || (r.taskRole === undefined && (r.role === (task.role ?? null) || r.role === "orchestrator"))) &&
    Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) >= since && Date.parse(r.ts) <= now &&
    finite(r.durationMs) && (r.costUsd === null || finite(r.costUsd)) &&
    typeof r.status === "string").sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)) : [];
  const identityKnown = identity !== undefined && /^[a-f0-9]{64}$/.test(identity);
  const verified = rows.filter((r) => identityKnown && r.routingIdentity === identity && r.taskRole === (task.role ?? null) && r.acceptanceScope === "task-checks" && r.attempt === 1 && r.escalations === 0 &&
    r.judgeRetried === false && r.selfCheckNotice === false && (r.merge === null || r.merge === "merged") &&
    ((r.acceptance === "checks-passed" && r.status === "ok" && r.failure === null) ||
      (r.acceptance === "checks-failed" && r.status === "failed" && r.failure === "checks")));
  const passed = verified.filter((r) => r.acceptance === "checks-passed").length;
  const verifiedRows = new Set(verified);
  const costs = verified.flatMap((r) => r.costUsd === null ? [] : [r.costUsd]);
  const latest = rows.at(-1);
  // Infrastructure, permission, cancellation and budget failures are not model
  // quality evidence, and a default blocker must not trigger a different route.
  // The block expires: an excluded alternative never runs again, so its bad
  // row would otherwise stay the latest for the whole history window.
  // Credential and configuration failures do not expire inside the window.
  const blocked = latest !== undefined && latest.status !== "ok" && latest.failure !== "checks" &&
    ((latest.failure !== null && PERSISTENT_BLOCKERS.has(latest.failure)) || now - Date.parse(latest.ts) < ROUTING_BLOCK_COOLDOWN_MS);
  return { provider: leg.providerId, model: leg.model, samples: rows.length, verifiedSamples: verified.length, passed,
    passRate: verified.length === 0 ? null : passed / verified.length,
    selfReportedSuccesses: rows.filter((r) => r.status === "ok" && !verifiedRows.has(r)).length,
    medianDurationMs: median(verified.map((r) => r.durationMs)), knownCostSamples: costs.length, medianCostUsd: median(costs), blocked, identityKnown };
}

/** Reliability first; cost only when every sample is priced, then latency.
 * A 10-point acceptance-rate gain or 20% efficiency gain avoids trivial flips.
 * These are historical descriptive rates, not calibrated predictions.
 */
function improves(candidate: RoutingEvidence, current: RoutingEvidence): boolean {
  if (candidate.passRate === null || current.passRate === null) return false;
  const delta = candidate.passed * current.verifiedSamples - current.passed * candidate.verifiedSamples;
  // Counts are bounded by the history ring; integer products stay exact and
  // include boundary gains such as 2/10 -> 3/10 despite binary float rounding.
  if (10 * delta >= candidate.verifiedSamples * current.verifiedSamples) return true;
  if (delta !== 0) return false;
  if (candidate.knownCostSamples === candidate.verifiedSamples && current.knownCostSamples === current.verifiedSamples &&
    candidate.medianCostUsd !== null && current.medianCostUsd !== null && candidate.medianCostUsd !== current.medianCostUsd) {
    return candidate.medianCostUsd <= current.medianCostUsd * .8;
  }
  return candidate.medianDurationMs !== null && current.medianDurationMs !== null &&
    candidate.medianDurationMs <= current.medianDurationMs * .8 && candidate.medianDurationMs < current.medianDurationMs;
}

/** Only default tasks are adaptable. Explicit model and configured role pins
 * precede this policy; its choices still pass the delegate's normal admission.
 */
export function measuredTaskLegs(
  tasks: readonly DelegateTask[], baseline: Map<string, TaskLeg>, worker: WorkerLegRef,
  roles: FusionRoleModels | undefined, orchestrator: WorkerLegRef | undefined,
  options: { records: readonly OutcomeRecord[]; minSamples: number; days: number; now?: number;
    remainingOrchestrator: number; attempted: (id: string) => boolean; cliToolsStayOn: (provider: string) => boolean;
    identityFor?: (provider: string) => string | undefined },
): { legs: Map<string, TaskLeg>; decisions: RoutingDecision[] } {
  const legs = new Map(baseline);
  const decisions: RoutingDecision[] = [];
  const now = options.now ?? Date.now();
  const since = now - options.days * 86_400_000;
  let strongLeft = Math.max(0, options.remainingOrchestrator);
  const heldLocal = new Set(roles?.localLegProviderIds ?? []);
  // Baseline pins remain admitted even when they occur later in task order.
  // Reserve every already-assigned local provider before any automatic pick.
  const configuredLocal = new Set(Object.values(roles?.byRole ?? {}).filter((entry) => entry?.local === true).map((entry) => entry!.providerId));
  for (const leg of baseline.values()) if (configuredLocal.has(leg.providerId)) heldLocal.add(leg.providerId);
  for (const task of tasks) {
    const original = baseline.get(task.id)!;
    const excluded: RoutingDecision["excluded"] = [];
    const decision: RoutingDecision = { taskId: task.id, selectedProvider: original.providerId, selectedModel: original.model,
      reason: "default-preferred", basis: "objective-task-checks", candidates: [], excluded };
    decisions.push(decision);
    if (task.model !== undefined || (task.role !== undefined && roles?.byRole[task.role] !== undefined)) {
      decision.reason = "pinned"; continue;
    }
    if (options.attempted(task.id)) { decision.reason = "retry-family"; continue; }
    const candidates: Candidate[] = [{ leg: original, local: heldLocal.has(worker.providerId) }];
    const build = roles?.byRole.build;
    if (build !== undefined && build.providerId !== worker.providerId) {
      candidates.push({ leg: { providerId: build.providerId, model: build.model ?? build.providerId, isWorkerLeg: false,
        ...(build.providerId === orchestrator?.providerId ? { orchestrator: true as const } : { role: "build" as const }) }, local: build.local });
    }
    if (orchestrator !== undefined && orchestrator.providerId !== worker.providerId &&
      !candidates.some((c) => c.leg.providerId === orchestrator.providerId)) {
      candidates.push({ leg: { ...orchestrator, isWorkerLeg: false, orchestrator: true }, local: heldLocal.has(orchestrator.providerId) });
    }
    // A build target is only evidence for a default/build task; do not treat
    // build outcomes as evidence for review/plan/utility tasks.
    const eligible = candidates.filter(({ leg, local }) => {
      let why: string | undefined;
      if (!leg.isWorkerLeg && task.role !== undefined && task.role !== "build" && leg.role === "build") why = "task-role";
      else if (!leg.isWorkerLeg && options.cliToolsStayOn(leg.providerId)) why = "cli-tools-stay-on";
      else if (leg.orchestrator && strongLeft === 0) why = "strong-target-cap";
      else if (local && heldLocal.size > 0 && !heldLocal.has(leg.providerId) && roles?.mixLocalModels !== true) why = "mix-local-models";
      if (why !== undefined) { excluded.push({ provider: leg.providerId, reason: why }); return false; }
      return true;
    });
    const stats = eligible.map((candidate) => ({ candidate, stats: evidence(options.records, candidate.leg, task, since, now, options.identityFor?.(candidate.leg.providerId)) }));
    decision.candidates = stats.map((s) => s.stats);
    const base = stats.find((s) => s.candidate.leg.isWorkerLeg);
    if (base === undefined || base.stats.blocked) { decision.reason = "blocking-history"; continue; }
    if (base.stats.verifiedSamples < options.minSamples) { decision.reason = "insufficient-evidence"; continue; }
    let chosen = base;
    for (const item of stats) {
      if (item.stats.blocked) { excluded.push({ provider: item.stats.provider, reason: "blocking-history" }); continue; }
      if (item.stats.verifiedSamples < options.minSamples) continue;
      if (improves(item.stats, chosen.stats)) chosen = item;
    }
    if (chosen === base) continue;
    decision.reason = "measured-improvement";
    decision.selectedProvider = chosen.candidate.leg.providerId;
    decision.selectedModel = chosen.candidate.leg.model;
    legs.set(task.id, chosen.candidate.leg);
    if (chosen.candidate.leg.orchestrator) strongLeft -= 1;
    if (chosen.candidate.local) heldLocal.add(chosen.candidate.leg.providerId);
  }
  return { legs, decisions };
}
