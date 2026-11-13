import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { sanitizeModelAlias } from "../../analytics/sanitize-model-alias.js";
import { reportedCostUsd } from "../../llm/provider/usage-cost.js";
import { classifyWorkerFailure } from "./failure-breaker.js";
import { tryAcquireOutcomeLock } from "./outcome-log-lock.js";
import {
  taskSpendUsd,
  type WorkerPricing,
  type WorkerTaskResult,
  type WorkerTaskStatus,
} from "./worker-result.js";

/**
 * The fusion outcome log: one NDJSON line per finished worker task and
 * one per fusion turn, under `<stateDir>/fusion/outcomes.ndjson`, so
 * `atomic-agent fusion report` can answer "is my local worker model good
 * enough, and what does the strong side cost?".
 *
 * Counts and categories only. No prompt, reply, instruction, title, task
 * id, path or error text is written: a failure is a category from a
 * fixed list (`failureCategory`), a session is a short one-way hash
 * (`sessionTag`), a model is the configured provider id and model label
 * (a local file path cut to its base name, `outcomeLabel`).
 * The file is bounded (`OUTCOME_LOG_MAX_BYTES`, `OUTCOME_LOG_KEEP`
 * rotated files) and a failed write is logged and dropped: the log never
 * fails a fan-out or a turn.
 */

export const FUSION_OUTCOMES_DIR_NAME = "fusion";
export const FUSION_OUTCOMES_FILE_NAME = "outcomes.ndjson";
/** The live file rotates once an append would take it past this. */
export const OUTCOME_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Rotated files kept (`outcomes.ndjson.1` newest … `.N` oldest). */
export const OUTCOME_LOG_KEEP = 2;
/** Orchestrator steps listed per turn line; a longer turn keeps the first ones. */
export const TURN_STEPS_RECORDED = 100;
/** The record shape's version, for a reader that meets an older file. */
export const OUTCOME_RECORD_VERSION = 1;

/** Where a task ran: the local worker leg, a cloud leg, or the orchestrator's own leg. */
export type OutcomeLeg = "local" | "cloud" | "orchestrator";

export type JudgeOutcome = "green" | "red" | "unverified" | "off";

/** Under `isolation: "worktree"`: what became of the task's workspace. */
export type MergeOutcome = "merged" | "conflict" | "held";

/**
 * Why a task did not come back green, from a fixed list. A non-`ok`
 * status other than `failed` is its own category; a `failed` row is the
 * failure breaker's blocker class when it has one, else what demoted it.
 */
export type FailureCategory =
  | Exclude<WorkerTaskStatus, "ok" | "failed">
  | "tool-protocol"
  | "cli-missing"
  | "not-signed-in"
  | "out-of-credit"
  | "syntax"
  | "checks"
  | "judge-red"
  | "not-started"
  | "error";

export interface TaskOutcomeRecord {
  v: number;
  type: "task";
  /** ISO time the fan-out finished. */
  ts: string;
  /** `sessionTag` of the orchestrator's session. */
  session: string;
  provider: string;
  model: string;
  leg: OutcomeLeg;
  /** The role that picked the model, `"orchestrator"` for that target, else null. */
  role: string | null;
  /** Requested task role, independently of the execution leg's role. */
  taskRole?: string | null;
  /** Objective declared checks only; neither judge/self-report nor full integration acceptance. */
  acceptance?: "checks-passed" | "checks-failed";
  acceptanceScope?: "task-checks";
  /** SHA256 of known configured request identity, stable through execution; not served-model attestation. */
  routingIdentity?: string;
  status: WorkerTaskStatus;
  failure: FailureCategory | null;
  /** This turn's attempt at the task (1 = first), replans and re-delegations alike. */
  attempt: number;
  /** The judge re-ran the task once with its findings. */
  judgeRetried: boolean;
  selfCheckNotice: boolean;
  escalations: number;
  judge: JudgeOutcome;
  syntaxDemoted: boolean;
  steps: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Of `tokensIn`, served from a prompt cache; null when not reported. */
  cachedTokens: number | null;
  /** Null when the leg has no price and the service sent no bill. */
  costUsd: number | null;
  /** Null without isolation. */
  merge: MergeOutcome | null;
}

export interface TurnOutcomeRecord {
  v: number;
  type: "turn";
  ts: string;
  session: string;
  orchestrator: {
    /** The provider that served the turn's last orchestrator step. */
    provider: string;
    model: string;
    requests: number;
    tokensIn: number;
    tokensOut: number;
    /** Null when no step reported a cache figure. */
    cachedTokens: number | null;
    /**
     * The orchestrator's requests plus the judge and escalation calls;
     * null when none of them was priced.
     */
    costUsd: number | null;
    /** The requests alone; null when unpriced (a subscription CLI leg). */
    requestCostUsd: number | null;
    judgeCostUsd: number;
    escalationCostUsd: number;
    /** Per orchestrator step: prompt tokens and cache hits (null: not reported). */
    steps: Array<{ in: number; cached: number | null }>;
  };
  fanouts: number;
  /** Every task that ran, worker and orchestrator legs alike. */
  tasks: { total: number; ok: number; failed: number };
  /**
   * Of those, the `model: "orchestrator"` tasks: strong-side spend (null
   * when unpriced), kept out of the worker figures. Their own `"task"`
   * records carry the same cost.
   */
  orchestratorTasks: { total: number; costUsd: number | null };
  /** Worker-leg tasks' tokens. */
  workerTokens: number;
  workerMs: number;
  /** Priced worker-leg spend; null when no worker row was priced. */
  workerCostUsd: number | null;
}

export type OutcomeRecord = TaskOutcomeRecord | TurnOutcomeRecord;

/**
 * A short, one-way tag for a session id: enough to group a session's
 * lines, nothing that names it. Traces key files by the raw id; this
 * log is meant to be read (and shared) as an aggregate, so it does not.
 */
export function sessionTag(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

const MODEL_FILE_EXTENSION = /\.(?:gguf|ggml|bin|safetensors|onnx|pt|pth)$/i;

/**
 * A model or provider label safe to write: configured text kept as is,
 * unless it reads as a local file path (a llama-server model set to
 * `/home/alice/models/x.gguf`), which keeps only the file's base name,
 * without its model-file extension, normalised by `sanitizeModelAlias`.
 * Path-like: a backslash; a leading `/`, `~`, `.` or drive letter; more
 * than one `/`; or a model-file extension. A single-slash `vendor/model`
 * id is a model id, not a path.
 */
export function outcomeLabel(value: string): string {
  const pathLike =
    value.includes("\\") ||
    /^(?:[/~.]|[A-Za-z]:)/.test(value) ||
    value.split("/").length > 2 ||
    MODEL_FILE_EXTENSION.test(value);
  if (!pathLike) return value;
  const base = value.split(/[/\\]/).filter((part) => part.length > 0).pop() ?? "";
  return sanitizeModelAlias(base.replace(MODEL_FILE_EXTENSION, "")) ?? "local-model";
}

/** The category a non-green row is counted under; null for `ok`. */
export function failureCategory(
  row: Pick<WorkerTaskResult, "status" | "error" | "syntax" | "checks" | "judge">,
): FailureCategory | null {
  if (row.status === "ok") return null;
  if (row.status !== "failed") return row.status;
  if ((row.error ?? "").startsWith("not started:")) return "not-started";
  const cls = classifyWorkerFailure(row);
  if (cls?.blocker === true) {
    return cls.signature.slice("blocker:".length) as FailureCategory;
  }
  if ((row.syntax?.failedFiles.length ?? 0) > 0) return "syntax";
  if ((row.checks?.failed ?? 0) > 0) return "checks";
  if (row.judge !== undefined && !row.judge.green) return "judge-red";
  return "error";
}

export function judgeOutcome(row: Pick<WorkerTaskResult, "judge">): JudgeOutcome {
  if (row.judge === undefined) return "off";
  if (row.judge.unverified !== undefined) return "unverified";
  return row.judge.green ? "green" : "red";
}

/** What the delegate knows about one task's leg and attempt. */
export interface TaskOutcomeContext {
  provider: string;
  model: string;
  leg: OutcomeLeg;
  role: string | null;
  taskRole?: string | null;
  routingIdentity?: string;
  attempt: number;
  pricing: WorkerPricing | undefined;
  merge: MergeOutcome | null;
}

/** USD kept to a millionth of a dollar: sums of floats stay readable in the file. */
export function roundUsd(usd: number): number;
export function roundUsd(usd: number | null): number | null;
export function roundUsd(usd: number | null): number | null {
  return usd === null ? null : Math.round(usd * 1e6) / 1e6;
}

/** A row's cost, or null when nothing could price it. */
export function rowCostUsd(
  row: Pick<WorkerTaskResult, "usage" | "billing">,
  pricing: WorkerPricing | undefined,
): number | null {
  if (row.usage === undefined) return pricing === undefined ? null : 0;
  if (
    pricing === undefined &&
    row.billing === undefined &&
    reportedCostUsd(row.usage) === undefined
  ) {
    return null;
  }
  return taskSpendUsd(row, pricing);
}

/** One task's line. Reads only counts and fixed categories off the row. */
export function taskOutcomeRecord(
  row: WorkerTaskResult,
  context: TaskOutcomeContext,
  sessionId: string,
  now: Date,
): TaskOutcomeRecord {
  return {
    v: OUTCOME_RECORD_VERSION,
    type: "task",
    ts: now.toISOString(),
    session: sessionTag(sessionId),
    provider: outcomeLabel(context.provider),
    model: outcomeLabel(context.model),
    leg: context.leg,
    role: context.role,
    ...(context.taskRole === undefined ? {} : { taskRole: context.taskRole }),
    ...(context.routingIdentity !== undefined && /^[a-f0-9]{64}$/.test(context.routingIdentity) ? { routingIdentity: context.routingIdentity } : {}),
    ...((row.checks?.total ?? 0) > 0 && (row.escalations ?? 0) === 0 && row.judge?.retried !== true &&
      context.merge !== "held" && context.merge !== "conflict"
      ? (row.checks!.failed > 0 && row.status === "failed"
        ? { acceptance: "checks-failed" as const, acceptanceScope: "task-checks" as const }
        : row.checks!.failed === 0 && row.status === "ok"
          ? { acceptance: "checks-passed" as const, acceptanceScope: "task-checks" as const } : {})
      : {}),
    status: row.status,
    failure: failureCategory(row),
    attempt: Math.max(1, context.attempt),
    judgeRetried: row.judge?.retried === true,
    selfCheckNotice: row.selfCheckNotice === true,
    escalations: row.escalations ?? 0,
    judge: judgeOutcome(row),
    syntaxDemoted: (row.syntax?.failedFiles.length ?? 0) > 0,
    steps: row.stepCount,
    durationMs: Math.max(0, Math.round(row.durationMs)),
    tokensIn: row.usage?.promptTokens ?? 0,
    tokensOut: row.usage?.completionTokens ?? 0,
    cachedTokens: row.usage?.cachedTokens ?? null,
    costUsd: roundUsd(rowCostUsd(row, context.pricing)),
    merge: context.merge,
  };
}

/** The writer `fusion.delegate` and the runtime append through. */
export interface FusionOutcomeSink {
  append(records: readonly OutcomeRecord[]): void;
}

export interface FusionOutcomeLogOptions {
  /** `<stateDir>/fusion/outcomes.ndjson`. */
  path: string;
  maxBytes?: number;
  keep?: number;
  /** Read per append, so the config toggle takes effect without a restart. */
  enabled?: () => boolean;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

export function outcomeLogPath(stateDir: string): string {
  return join(stateDir, FUSION_OUTCOMES_DIR_NAME, FUSION_OUTCOMES_FILE_NAME);
}

/** The live file first, then the rotated ones, newest first. */
export function outcomeLogFiles(path: string, keep = OUTCOME_LOG_KEEP): string[] {
  return [path, ...Array.from({ length: keep }, (_, i) => `${path}.${i + 1}`)];
}

/**
 * Appends whole lines, rotating before an append would pass the size
 * bound: `.N` is dropped, each `.i` becomes `.i+1`, the live file `.1`.
 * Synchronous, so lines from concurrent fan-outs never interleave; across
 * processes, rotation happens only under `<log>.lock` (`outcome-log-lock.ts`).
 */
export class FusionOutcomeLog implements FusionOutcomeSink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly enabled: () => boolean;
  private readonly warn: FusionOutcomeLogOptions["warn"];

  constructor(options: FusionOutcomeLogOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes ?? OUTCOME_LOG_MAX_BYTES;
    this.keep = Math.max(0, options.keep ?? OUTCOME_LOG_KEEP);
    this.enabled = options.enabled ?? (() => true);
    this.warn = options.warn;
  }

  append(records: readonly OutcomeRecord[]): void {
    if (records.length === 0) return;
    try {
      if (!this.enabled()) return;
      const text = records.map((r) => `${JSON.stringify(r)}\n`).join("");
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Other processes (TUI, sidecar, scheduler) append to the same file:
      // only the lock's holder rotates, checking the size once it holds it.
      // Without the lock in a short wait, the line goes in unrotated.
      let release: (() => void) | undefined;
      try {
        release = tryAcquireOutcomeLock(`${this.path}.lock`);
      } catch {
        release = undefined;
      }
      try {
        if (release !== undefined) this.rotateFor(Buffer.byteLength(text));
        // A crash mid-append leaves a torn last line: start on a fresh one,
        // so only the torn line is lost to a reader.
        appendFileSync(this.path, this.endsTorn() ? `\n${text}` : text, { mode: 0o600 });
      } finally {
        release?.();
      }
    } catch (err) {
      // Never the fan-out's problem: the line is dropped and said once here.
      this.warn?.("fusion: the outcome log could not be written", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private endsTorn(): boolean {
    let fd: number | undefined;
    try {
      const size = statSync(this.path).size;
      if (size === 0) return false;
      fd = openSync(this.path, "r");
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private rotateFor(incoming: number): void {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size === 0 || size + incoming <= this.maxBytes) return;
    if (this.keep === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    rmSync(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i -= 1) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        // A gap in the chain is fine: that file did not exist.
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // Gone already (a writer outside the lock's rules): the append
      // starts a fresh live file.
    }
  }
}
