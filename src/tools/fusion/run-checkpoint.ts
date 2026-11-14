import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  currentTurnOwnerProbe,
  isTurnOwnerGone,
  serializeTurnOwner,
  turnOwnerFor,
  type TurnOwnerProbe,
} from "../../session/turn-owner.js";
import type { MergeTaskSuggestion } from "./branch-merge.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  WORKER_STATUS_ORDER,
  type WorkerTaskResult,
  type WorkerTaskStatus,
  type WorkerToolStats,
} from "./worker-result.js";
import { MAX_WORKER_QUESTION_CHARS } from "./worker-question.js";
import { UNTRACKED_WRITE_TOOLS, type FileChange } from "./worker-changes.js";
import { incompleteArtifactManifest, storedArtifactManifest } from "./artifact-manifest.js";
import type { ArtifactManifest } from "./artifact-manifest-types.js";
import { OS_FS_WRITE_CONTRACT } from "../os/fs/fs-write-contract.js";
import { OS_FS_EDIT_CONTRACT } from "../os/fs/fs-edit-contract.js";
import { OS_FS_PATCH_CONTRACT } from "../os/fs/fs-patch-contract.js";
import { OS_FS_MOVE_CONTRACT } from "../os/fs/fs-move-contract.js";
import { OS_FS_TRASH_CONTRACT } from "../os/fs/fs-trash-contract.js";
import { OS_FS_RESTORE_CONTRACT } from "../os/fs/fs-restore-contract.js";

// The operation contracts own mutation metadata; the worker's writes tally
// intentionally omits move/trash and cannot establish legacy coverage.
const FILE_MUTATIONS: ReadonlySet<string> = new Set([
  OS_FS_WRITE_CONTRACT, OS_FS_EDIT_CONTRACT, OS_FS_PATCH_CONTRACT,
  OS_FS_MOVE_CONTRACT, OS_FS_TRASH_CONTRACT, OS_FS_RESTORE_CONTRACT,
].filter((operation) => !operation.readonly).map((operation) => operation.name));

export function checkpointHasFileMutations(tools: WorkerToolStats): boolean {
  return tools.writes > 0 || Object.keys(tools.byTool).some((tool) => FILE_MUTATIONS.has(tool));
}

/**
 * Checkpoints of a fusion run (ATO-617): a long fan-out survives a crash,
 * a quit or an update instead of vanishing with its ephemeral workers.
 *
 * One JSON file per run under `<stateDir>/fusion-runs/`, written after
 * every finished task and every finished wave, deleted when the run ends
 * normally. A file left behind is a run that did not end: the process
 * died, or the turn was stopped. `run-resume.ts` turns it into a resume.
 *
 * Files rather than a table in `sessions.sqlite`: the session store's
 * schema and its turn marks are pinned invariants, a checkpoint is
 * written from inside a running tool (where a second writer on that
 * database would contend with the turn's own saves), and a run that
 * cannot be checkpointed must never fail the fan-out. Every write here
 * is best-effort, atomic (temp file + rename) and never throws.
 */

export const FUSION_RUNS_DIR_NAME = "fusion-runs";

/** How long an unfinished run is offered before it is dropped. */
export const FUSION_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A worker's reply kept in the checkpoint, at most this many chars. */
export const CHECKPOINT_REPLY_CHARS = 4_000;
/** Bounds durable input and verification targets without silently losing coverage. */
export const CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
export const CHECKPOINT_MAX_CHANGES = 256;
const CHECKPOINT_PATH_CHARS = 4_096;

const CHECKPOINT_VERSION = 1;

/** Run ids name files: nothing that could leave the directory. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tools whose repeat cannot change anything outside the worker's
 * approved directories: reads, lookups and the turn's own terminals.
 * File tools (`os.fs.*`) count too: they act inside the fan-out's write
 * scope, behind the input guard and the restore point, which is the
 * same ground a re-run covers. Anything else — a shell command, git
 * that commits or pushes, an HTTP request, an email, an MCP tool, a paid
 * generation — may already have happened once, so the task is not run
 * again without the person's yes.
 */
const REPEAT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "finish",
  "tool.view",
  "skill.view",
  "os.web.search",
  "os.web.fetch",
  "os.git.status",
  "os.git.log",
  "os.git.diff",
  "os.git.show",
  "os.git.blame",
  "os.proc.list",
  "os.window.list",
  "os.clipboard.read",
  "memory.notes.recall",
  "memory.lessons.recall",
  "memory.procedures.recall",
  "memory.profile.list",
  "memory.profile.history",
  "tasks.list",
  "tasks.show",
  "vision.describe",
  "verify.syntax",
  "mcp.resource.list",
  "mcp.prompt.list",
  "browser.read_aria",
  "browser.screenshot",
]);

/** Whether one call of `tool` may have changed something a re-run would change again. */
export function toolHasSideEffects(tool: string): boolean {
  if (tool.startsWith("os.fs.")) return false;
  return !REPEAT_SAFE_TOOLS.has(tool);
}

/** What a finished task left in the checkpoint. */
export interface CheckpointTaskResult {
  status: WorkerTaskStatus;
  reply: string;
  stepCount: number;
  durationMs: number;
  tools: WorkerToolStats;
  error?: string;
  notes?: string[];
  /** The worker leg's priced spend for this task, `0` when unpriced. */
  costUsd: number;
  changes?: FileChange[];
  shellRan?: true;
  /** Absent in older v1 files. Incomplete coverage must never resume green. */
  artifactMetadata?: "complete" | "incomplete";
  artifactManifest?: ArtifactManifest;
  /**
   * A `needs_input` task's question (ATO-945), kept apart from the
   * clipped reply so a resume still shows it. Absent in older v1 files.
   */
  question?: string;
}

export interface CheckpointTask {
  id: string;
  title: string;
  /**
   * The worker called a tool with effects outside its files
   * (`toolHasSideEffects`). Recorded as the calls start, so a worker
   * killed mid-task is still known to have run a command.
   */
  sideEffects: boolean;
  /** The side-effecting tools it called, for the person's question. */
  sideEffectTools: string[];
  /** Absent while the task has not finished. */
  result?: CheckpointTaskResult;
}

export type FusionRunState = "running" | "interrupted";

export interface FusionRunCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  runId: string;
  /** The orchestrator's session the fan-out ran on. */
  sessionId: string;
  workingDir: string;
  /** The person's request behind the turn, when the runtime knew it. */
  originalRequest?: string;
  /**
   * The call's own arguments (`tasks`, `maxWorkers`, `contract`), replayed
   * through `parseDelegateArgs` on resume so a resumed run is the same
   * run, not a re-plan.
   */
  args: Record<string, unknown>;
  /** `running` while a process works on it; `interrupted` once its turn was stopped. */
  state: FusionRunState;
  /** The process working on it (`serializeTurnOwner`), to tell live from dead. */
  owner: string;
  waveCount: number;
  wavesDone: number;
  tasks: CheckpointTask[];
  /** Priced spend so far (workers, escalations, judge), carried into a resume's cap. */
  spentUsd: number;
  /** Merges the planner still owes, from waves already merged back. */
  merges?: MergeTaskSuggestion[];
  startedAt: number;
  updatedAt: number;
  /** How many times the run was resumed. */
  resumes: number;
}

export interface FusionRunStartInput {
  /** Continue this run's file (a resume); absent mints a new id. */
  runId?: string;
  sessionId: string;
  workingDir: string;
  originalRequest?: string;
  args: Record<string, unknown>;
  tasks: readonly Pick<DelegateTask, "id" | "title">[];
  waveCount: number;
  /** The checkpoint a resume continues: its finished tasks and spend stand. */
  resumedFrom?: FusionRunCheckpoint;
}

export interface FusionRunStoreOptions {
  /** `<stateDir>/fusion-runs`. */
  dir: string;
  now?: () => number;
  probe?: TurnOwnerProbe;
  retentionMs?: number;
}

/**
 * The run files of one state dir. One instance per runtime; it knows
 * which runs this process is working on right now, so a fan-out in
 * flight is never offered for resuming.
 */
export class FusionRunStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly probe: TurnOwnerProbe;
  private readonly retentionMs: number;
  private readonly active = new Set<string>();

  constructor(options: FusionRunStoreOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? currentTurnOwnerProbe();
    this.retentionMs = options.retentionMs ?? FUSION_RUN_RETENTION_MS;
  }

  static isValidRunId(runId: string): boolean {
    return RUN_ID_PATTERN.test(runId);
  }

  /** Begin (or, with `runId`, continue) checkpointing a run. */
  start(input: FusionRunStartInput): FusionRunRecorder {
    const runId =
      input.runId !== undefined && FusionRunStore.isValidRunId(input.runId)
        ? input.runId
        : `fr-${randomUUID()}`;
    const at = this.now();
    const before = new Map(
      (input.resumedFrom?.tasks ?? []).map((t) => [t.id, t]),
    );
    const checkpoint: FusionRunCheckpoint = {
      version: CHECKPOINT_VERSION,
      runId,
      sessionId: input.sessionId,
      workingDir: input.workingDir,
      ...(input.originalRequest === undefined
        ? {}
        : { originalRequest: input.originalRequest }),
      args: input.args,
      state: "running",
      owner: serializeTurnOwner(turnOwnerFor(this.probe, at)),
      waveCount: input.waveCount,
      wavesDone: 0,
      tasks: input.tasks.map((t) => {
        const prior = before.get(t.id);
        // A finished task stands; an unfinished one keeps what is known
        // about its side effects, so a second resume still asks.
        return prior === undefined
          ? { id: t.id, title: t.title, sideEffects: false, sideEffectTools: [] }
          : { ...prior, title: t.title };
      }),
      spentUsd: input.resumedFrom?.spentUsd ?? 0,
      ...(input.resumedFrom?.merges === undefined
        ? {}
        : { merges: input.resumedFrom.merges }),
      startedAt: input.resumedFrom?.startedAt ?? at,
      updatedAt: at,
      resumes: (input.resumedFrom?.resumes ?? -1) + 1,
    };
    this.active.add(runId);
    const recorder = new FusionRunRecorder(this, checkpoint);
    recorder.flush();
    return recorder;
  }

  /** The run's checkpoint, or `null` when there is none (or it is unreadable). */
  load(runId: string): FusionRunCheckpoint | null {
    if (!FusionRunStore.isValidRunId(runId)) return null;
    const checkpoint = readCheckpoint(this.path(runId));
    return checkpoint?.runId === runId ? checkpoint : null;
  }

  /** A process — this one, or another alive — is working on the run now. */
  isLive(checkpoint: FusionRunCheckpoint): boolean {
    if (this.active.has(checkpoint.runId)) return true;
    if (checkpoint.state === "interrupted") return false;
    return !isTurnOwnerGone(checkpoint.owner, this.probe);
  }

  /**
   * Runs that did not end and nobody is working on, newest first;
   * `sessionId` narrows to one session. Runs past the retention are
   * deleted on the way.
   */
  listResumable(sessionId?: string): FusionRunCheckpoint[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: FusionRunCheckpoint[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const runId = name.slice(0, -".json".length);
      if (!FusionRunStore.isValidRunId(runId)) continue;
      const checkpoint = readCheckpoint(join(this.dir, name));
      if (checkpoint === null || checkpoint.runId !== runId) continue;
      if (this.now() - checkpoint.updatedAt > this.retentionMs) {
        if (!this.active.has(runId)) this.remove(runId);
        continue;
      }
      if (sessionId !== undefined && checkpoint.sessionId !== sessionId) continue;
      if (this.isLive(checkpoint)) continue;
      out.push(checkpoint);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Drop a run that is not live. `false` when there was none to drop. */
  discard(runId: string): boolean {
    const checkpoint = this.load(runId);
    if (checkpoint === null || this.isLive(checkpoint)) return false;
    return this.remove(runId);
  }

  /** @internal — the recorder's write. */
  write(checkpoint: FusionRunCheckpoint): string | undefined {
    try {
      const durable = structuredClone(checkpoint);
      // Labels are display-only; ids, arguments and the operator request
      // retain their exact bytes for replay and input-file protection.
      for (const task of durable.tasks) task.title = task.title.slice(0, 8_192);
      let json = JSON.stringify(durable);
      if (Buffer.byteLength(json, "utf8") > CHECKPOINT_MAX_BYTES) {
        // Verification telemetry can exceed the aggregate budget despite
        // each individual row fitting. Keep the run and fail coverage closed.
        for (const task of durable.tasks) {
          if (task.result === undefined) continue;
          task.result.changes = [];
          task.result.notes = ["checkpoint detail omitted to stay within its storage budget"];
          task.result.reply = "";
          task.result.tools.byTool = {};
          task.sideEffectTools = task.sideEffectTools.slice(0, 8).map((tool) => tool.slice(0, 1_024));
          task.result.artifactMetadata = "incomplete";
          if (task.result.artifactManifest !== undefined) task.result.artifactManifest = incompleteArtifactManifest(task.result.artifactManifest);
        }
        json = JSON.stringify(durable);
      }
      if (Buffer.byteLength(json, "utf8") > CHECKPOINT_MAX_BYTES) {
        this.remove(checkpoint.runId);
        return "exact replay arguments, identity and original request exceed the 8 MiB checkpoint budget";
      }
      mkdirSync(this.dir, { recursive: true });
      const file = this.path(checkpoint.runId);
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, json, "utf8");
      renameSync(tmp, file);
      return undefined;
    } catch {
      // Best-effort: a read-only state dir or a full disk costs the run
      // its resumability, never the fan-out.
      return "checkpoint storage is unavailable";
    }
  }

  /** @internal — the recorder's end. */
  release(runId: string, keep: boolean): void {
    this.active.delete(runId);
    if (!keep) this.remove(runId);
  }

  /** @internal */
  stamp(): number {
    return this.now();
  }

  private remove(runId: string): boolean {
    try {
      unlinkSync(this.path(runId));
      return true;
    } catch {
      return false;
    }
  }

  private path(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }
}

/** One run's checkpoint as the fan-out writes it. */
export class FusionRunRecorder {
  private ended = false;
  private warning: string | undefined;
  /** The task tree's parent links (ATO-1320); absent without a tree. */
  private parentOf: ((taskId: string) => string | undefined) | undefined;

  constructor(
    private readonly store: FusionRunStore,
    private readonly checkpoint: FusionRunCheckpoint,
  ) {}

  get runId(): string {
    return this.checkpoint.runId;
  }

  get checkpointWarning(): string | undefined {
    return this.warning;
  }

  /** A copy of what is recorded so far. */
  snapshot(): FusionRunCheckpoint {
    return structuredClone(this.checkpoint);
  }

  /**
   * How a subtask of a split finds the top-level task it belongs to
   * (ATO-1320). Only the orchestrator's own tasks have a row here; a
   * child's spend and side effects count on its root, found through
   * the tree's parent links rather than by cutting the id at `/`,
   * since a root's own id may contain one.
   */
  useParents(parentOf: (taskId: string) => string | undefined): void {
    this.parentOf = parentOf;
  }

  /** The checkpoint row `taskId` counts on: its own, or its root's. */
  private rowFor(taskId: string): FusionRunCheckpoint["tasks"][number] | undefined {
    let id: string | undefined = taskId;
    for (let hops = 0; id !== undefined && hops < 64; hops += 1) {
      const current: string = id;
      const task = this.checkpoint.tasks.find((t) => t.id === current);
      if (task !== undefined) return task;
      id = this.parentOf?.(current);
    }
    return undefined;
  }

  /**
   * A worker started `tool`. Written only when it is the task's first
   * side-effecting call: a worker killed right after it is still known
   * not to be safe to repeat.
   */
  noteTool(taskId: string, tool: string): void {
    if (this.ended || !toolHasSideEffects(tool)) return;
    const task = this.rowFor(taskId);
    if (task === undefined || task.sideEffectTools.includes(tool)) return;
    const first = !task.sideEffects;
    task.sideEffects = true;
    task.sideEffectTools.push(tool);
    if (first) this.flush();
  }

  /** A task finished: its row and its spend are written at once. */
  recordTask(result: WorkerTaskResult, costUsd = 0): void {
    if (this.ended) return;
    const own = this.checkpoint.tasks.find((t) => t.id === result.id);
    const task = own ?? this.rowFor(result.id);
    if (task === undefined) return;
    // The finished row's own tool counts also decide, for a worker whose
    // tool events were not seen (a test harness, an embedder).
    for (const tool of Object.keys(result.tools.byTool)) {
      if (toolHasSideEffects(tool) && !task.sideEffectTools.includes(tool)) {
        task.sideEffects = true;
        task.sideEffectTools.push(tool);
      }
    }
    const spend = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    if (own === undefined) {
      // A subtask of a split (ATO-1320): its spend and side effects
      // count on its root, whose own row is written when the split closes.
      this.checkpoint.spentUsd += spend;
      this.flush();
      return;
    }
    const changes = result.changes ?? [];
    const artifactManifest = result.artifactManifest === undefined ? undefined : storedArtifactManifest(result.artifactManifest);
    const shellRan = result.shellRan === true ||
      Object.keys(result.tools.byTool).some((tool) => UNTRACKED_WRITE_TOOLS.has(tool));
    const complete = !shellRan && changes.length <= CHECKPOINT_MAX_CHANGES && changes.every(validChange) &&
      (!checkpointHasFileMutations(result.tools) || changes.length > 0) &&
      (result.notes === undefined || (result.notes.length <= 64 && result.notes.every((n) => n.length <= CHECKPOINT_REPLY_CHARS))) &&
      !artifactManifest?.coverage.reasons.includes("metadata_truncated");
    task.result = {
      status: result.status,
      reply: result.reply.slice(0, CHECKPOINT_REPLY_CHARS),
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      tools: result.tools,
      ...(result.error === undefined ? {} : { error: result.error.slice(0, CHECKPOINT_REPLY_CHARS) }),
      ...(result.notes === undefined ? {} : { notes: result.notes.slice(0, 64).map((n) => n.slice(0, CHECKPOINT_REPLY_CHARS)) }),
      ...(result.question === undefined ? {} : { question: result.question.slice(0, MAX_WORKER_QUESTION_CHARS) }),
      costUsd: spend,
      changes: changes.filter(validChange).slice(0, CHECKPOINT_MAX_CHANGES),
      ...(shellRan ? { shellRan: true } : {}),
      artifactMetadata: complete ? "complete" : "incomplete",
      ...(artifactManifest === undefined ? {} : { artifactManifest }),
    };
    this.checkpoint.spentUsd += spend;
    this.flush();
  }

  /** Final evidence augments an existing row without charging its spend twice. */
  recordArtifactManifest(taskId: string, manifest: ArtifactManifest): void {
    if (this.ended) return;
    const result = this.checkpoint.tasks.find(t => t.id === taskId)?.result;
    if (result === undefined) return;
    result.artifactManifest = storedArtifactManifest(manifest);
    if (result.artifactManifest.coverage.reasons.includes("metadata_truncated")) result.artifactMetadata = "incomplete";
    this.flush();
  }

  /** Spend not on a finished row (an escalation, the judge, a split's parent). */
  addSpend(usd: number): void {
    if (this.ended || !Number.isFinite(usd) || usd <= 0) return;
    this.checkpoint.spentUsd += usd;
    this.flush();
  }

  /** A wave's merge conflicts, kept for the planner across a restart. */
  recordMerges(merges: readonly MergeTaskSuggestion[]): void {
    if (this.ended || merges.length === 0) return;
    this.checkpoint.merges = [...(this.checkpoint.merges ?? []), ...merges];
    this.flush();
  }

  /** `done` waves have finished. */
  recordWave(done: number): void {
    if (this.ended) return;
    this.checkpoint.wavesDone = Math.max(this.checkpoint.wavesDone, done);
    this.flush();
  }

  /**
   * The run ended. `complete` deletes the file: nothing is left to
   * resume. `interrupted` (the turn was stopped) keeps it, marked so it
   * is offered at once rather than after its process is gone.
   */
  finish(outcome: "complete" | "interrupted"): void {
    if (this.ended) return;
    if (outcome === "interrupted") {
      this.checkpoint.state = "interrupted";
      this.flush();
    }
    this.ended = true;
    this.store.release(this.checkpoint.runId, outcome === "interrupted");
  }

  /** @internal */
  flush(): void {
    this.checkpoint.updatedAt = this.store.stamp();
    this.warning = this.store.write(this.checkpoint);
  }
}

function readCheckpoint(file: string): FusionRunCheckpoint | null {
  let parsed: unknown;
  try {
    if (statSync(file).size > CHECKPOINT_MAX_BYTES) return null;
    const bytes = readFileSync(file);
    if (bytes.length > CHECKPOINT_MAX_BYTES) return null;
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!record(parsed)) return null;
  const c = parsed as Partial<FusionRunCheckpoint>;
  if (
    c.version !== CHECKPOINT_VERSION ||
    !boundedString(c.runId, 64) || !RUN_ID_PATTERN.test(c.runId) ||
    !boundedString(c.sessionId, CHECKPOINT_MAX_BYTES) ||
    !boundedString(c.workingDir, CHECKPOINT_MAX_BYTES) ||
    !record(c.args) ||
    !Array.isArray(c.tasks) ||
    c.tasks.length > 16 || !c.tasks.every(validTask) ||
    new Set(c.tasks.map((t) => t.id)).size !== c.tasks.length ||
    !nonnegative(c.updatedAt) || !nonnegative(c.startedAt) ||
    !nonnegative(c.spentUsd) || !nonnegative(c.wavesDone) ||
    !nonnegative(c.waveCount) || !nonnegative(c.resumes) ||
    (c.state !== "running" && c.state !== "interrupted") ||
    !boundedString(c.owner, CHECKPOINT_MAX_BYTES) ||
    (c.originalRequest !== undefined && !boundedString(c.originalRequest, CHECKPOINT_MAX_BYTES)) ||
    (c.merges !== undefined && (!Array.isArray(c.merges) || !c.merges.every((m) =>
      record(m) && boundedString(m.id, CHECKPOINT_MAX_BYTES) && boundedString(m.title, CHECKPOINT_MAX_BYTES) &&
      boundedString(m.instructions, CHECKPOINT_MAX_BYTES) && stringList(m.files, CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_BYTES))))
  ) {
    return null;
  }
  for (const task of c.tasks) {
    if (task.result?.artifactManifest !== undefined) {
      task.result.artifactManifest = storedArtifactManifest(task.result.artifactManifest);
      if (task.result.artifactManifest.coverage.reasons.includes("metadata_truncated")) task.result.artifactMetadata = "incomplete";
    }
  }
  return c as FusionRunCheckpoint;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringList(value: unknown, count: number, chars: number): value is string[] {
  return Array.isArray(value) && value.length <= count && value.every((v) => boundedString(v, chars));
}

function validChange(value: unknown): value is FileChange {
  return record(value) && boundedString(value.path, CHECKPOINT_PATH_CHARS) && value.path.length > 0 &&
    ["new", "modified", "restored", "trashed"].includes(value.kind as string) &&
    (value.addedLines === undefined || nonnegative(value.addedLines)) &&
    (value.removedLines === undefined || nonnegative(value.removedLines)) &&
    (value.movedFrom === undefined || boundedString(value.movedFrom, CHECKPOINT_PATH_CHARS));
}

function validTask(value: unknown): value is CheckpointTask {
  if (!record(value) || !boundedString(value.id, CHECKPOINT_MAX_BYTES) || !boundedString(value.title, CHECKPOINT_MAX_BYTES) ||
      typeof value.sideEffects !== "boolean" || !stringList(value.sideEffectTools, CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_BYTES)) return false;
  const r = value.result;
  if (r === undefined) return true;
  if (!record(r) || !WORKER_STATUS_ORDER.includes(r.status as WorkerTaskStatus) ||
      !boundedString(r.reply, CHECKPOINT_REPLY_CHARS) || !nonnegative(r.stepCount) ||
      !nonnegative(r.durationMs) || !nonnegative(r.costUsd) || !record(r.tools) ||
      !nonnegative(r.tools.calls) || !nonnegative(r.tools.errors) || !nonnegative(r.tools.writes) ||
      !record(r.tools.byTool) ||
      !Object.entries(r.tools.byTool).every(([tool, count]) => tool.length <= CHECKPOINT_MAX_BYTES && nonnegative(count))) return false;
  return (r.error === undefined || boundedString(r.error, CHECKPOINT_MAX_BYTES)) &&
    (r.notes === undefined || stringList(r.notes, CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_BYTES)) &&
    (r.changes === undefined || (Array.isArray(r.changes) && r.changes.length <= CHECKPOINT_MAX_CHANGES && r.changes.every(validChange))) &&
    (r.shellRan === undefined || r.shellRan === true) &&
    (r.question === undefined || boundedString(r.question, MAX_WORKER_QUESTION_CHARS)) &&
    (r.artifactMetadata === undefined || r.artifactMetadata === "complete" || r.artifactMetadata === "incomplete");
}
