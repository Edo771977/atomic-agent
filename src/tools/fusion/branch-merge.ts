/**
 * Merging an isolated task back (branch isolation, ATO-946).
 *
 * After its wave, each task's workspace (`branch-workspace.ts`) is
 * merged into the working directory, in the caller's task order, one
 * file at a time against the snapshot every workspace started from:
 *
 *  - a file only this task changed is copied in (or removed);
 *  - a file the folder also changed since the snapshot (an earlier
 *    task of the wave, or the person) is merged with
 *    `git merge-file`; a clean text merge is written, anything else
 *    (overlapping edits, binary, an edit against a removal) is a
 *    conflict: the folder's file is left exactly as it is, both sides
 *    are saved under `.atomic-agent/fusion-merge/`, and the planner
 *    gets a merge task for them;
 *  - a declared input (`contract.inputs`, F51) the task removed or cut
 *    to under half its lines is refused at the door, whatever the
 *    worker's tools allowed inside its workspace (ATO-860, ATO-883).
 *
 * A task that failed, was cancelled, timed out or never got a slot is
 * not merged: its workspace, and what it wrote there, is thrown away.
 * A task that finished but is red before its merge (a `gate`: its own
 * contract checks, the judge) is not merged either: its changes are
 * kept as a patch under `.atomic-agent/fusion-merge/<task>.patch`
 * (`branch-diff.ts`), and its workspace is kept when a retry will work
 * on in it.
 */
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { runCommand } from "../../sandbox/command-runner.js";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import {
  BRANCH_MERGE_DIR,
  createBranchSet,
  ensureMergeDir,
  readEntry,
  sameEntry,
  touchedPaths,
  workspaceTouches,
  type PathEntry,
  type BranchSet,
  type BranchWorkspace,
  type CreateBranchSetOptions,
} from "./branch-workspace.js";
import {
  removeTaskPatch,
  workspaceChanges,
  writeTaskPatch,
  type PatchGit,
  type SavedTaskPatch,
  type WorkspaceChange,
} from "./branch-diff.js";
import { resolveContractInputs } from "./contract-inputs.js";
import { inputPathIdentity } from "../os/fs/fs-input-path-identity.js";
import type { ContractProvide } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";
import { comparableScopePath } from "./scope-path.js";

/** Statuses whose workspace is merged back; everything else is discarded. */
export const MERGED_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  "ok",
  "no_changes",
  "needs_orchestrator",
  "max_steps",
]);

/**
 * A three-way text merge of `current` with `other` over `base` (absolute
 * paths). `clean: true` with the merged text, or `clean: false`.
 */
export type MergeFile = (input: {
  current: string;
  base: string;
  other: string;
  cwd: string;
}) => Promise<{ clean: true; merged: string } | { clean: false }>;

/** `git merge-file -p`: exit 0 is a clean merge, anything else is not. */
export const gitMergeFile: MergeFile = async ({ current, base, other, cwd }) => {
  try {
    const result = await runCommand(
      "git",
      ["merge-file", "-p", "-L", "current", "-L", "base", "-L", "task", current, base, other],
      {
        cwd,
        env: { ...buildCommandEnv(process.env), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024 * 1024,
      },
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      return { clean: false };
    }
    return { clean: true, merged: result.stdout };
  } catch {
    return { clean: false };
  }
};

export interface RefusedPath {
  path: string;
  reason: string;
}

export interface BranchMergeOutcome {
  taskId: string;
  /** Paths written into (or removed from) the working directory. */
  applied: string[];
  /**
   * Of `applied`, those merged with `merge-file` because the folder had
   * moved too: what landed is not what the task's gate checked.
   */
  threeWay?: string[];
  /** Paths left as the folder has them, sides saved under `savedDir`. */
  conflicts: string[];
  /** Declared inputs the task would have removed or cut down. */
  refused: RefusedPath[];
  /** Paths that could neither be written nor saved: this task's change is gone. */
  lost?: string[];
  /** Where the conflicting sides were saved, relative to the working directory. */
  savedDir?: string;
  /**
   * Files the task added, changed or removed under a directory the ignore
   * rules classify as ignored (one it created, such as `src/generated/`):
   * never merged, so reported instead of dropped silently.
   */
  ignoredChanges?: string[];
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n += 1;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

/** Text a merge may touch: no NUL, and valid UTF-8 (merge output comes back as a string). */
function mergeableText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/**
 * Why writing `task` over the declared input `base` is refused, or
 * `undefined` when it is an edit in place.
 */
export function inputReplacement(
  base: Buffer | null,
  task: Buffer | null,
): string | undefined {
  if (base === null) return undefined;
  if (task === null) return "would remove the user's file";
  const before = lineCount(base);
  const after = lineCount(task);
  if (before >= 4 && after * 2 < before) {
    return `would replace the user's file (${before} → ${after} lines)`;
  }
  return undefined;
}

async function writeKeepingMode(from: string, to: string, entry: PathEntry): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  if (entry.link !== undefined) {
    // A symlink lands as a symlink, not as a copy of what it points at.
    await rm(to, { force: true });
    await symlink(entry.link, to);
    return;
  }
  // Never write through a symlink the folder has where the file goes.
  if ((await lstat(to).catch(() => null))?.isSymbolicLink() === true) {
    await rm(to, { force: true });
  }
  await copyFile(from, to);
  const mode = (await lstat(from)).mode & 0o777;
  await chmod(to, mode).catch(() => undefined);
}

/**
 * Merge one workspace into `set.realDir`. `protectedPaths` are the
 * declared inputs relative to the working directory.
 */
export async function mergeBranch(
  set: Pick<BranchSet, "realDir" | "baseDir">,
  workspace: BranchWorkspace,
  protectedPaths: ReadonlySet<string>,
  mergeFile: MergeFile = gitMergeFile,
): Promise<BranchMergeOutcome> {
  const outcome: BranchMergeOutcome = {
    taskId: workspace.taskId,
    applied: [],
    conflicts: [],
    refused: [],
  };
  const savedRoot = join(BRANCH_MERGE_DIR, workspace.name);
  const save = async (rel: string, base: PathEntry | null, task: PathEntry | null): Promise<void> => {
    const at = join(set.realDir, savedRoot, rel);
    await ensureMergeDir(set.realDir);
    await mkdir(dirname(at), { recursive: true });
    if (task !== null) await writeBuffer(`${at}.task`, task.data);
    else await writeBuffer(`${at}.task-removed`, Buffer.alloc(0));
    if (base !== null) await writeBuffer(`${at}.base`, base.data);
    outcome.savedDir = savedRoot;
  };
  const touches = await workspaceTouches(workspace);
  if (touches.ignored.length > 0) outcome.ignoredChanges = touches.ignored;
  for (const rel of touches.touched) {
    const taskPath = join(workspace.dir, rel);
    const basePath = join(set.baseDir, rel);
    const realPath = join(set.realDir, rel);
    const [task, base, current] = await Promise.all([
      readEntry(taskPath),
      readEntry(basePath),
      readEntry(realPath),
    ]);
    // One path that cannot be written (a file where its folder should be,
    // a read-only target) must not cost the rest of the wave.
    try {
      // Touched, not changed: nothing to bring back.
      if (sameEntry(task, base)) continue;
      if (protectedPaths.has(rel)) {
        const reason = inputReplacement(base?.data ?? null, task?.data ?? null);
        if (reason !== undefined) {
          outcome.refused.push({ path: rel, reason });
          continue;
        }
      }
      // Already what the task wants (another task did the same).
      if (sameEntry(current, task)) continue;
      if (sameEntry(current, base)) {
        if (task === null) await rm(realPath, { force: true });
        else await writeKeepingMode(taskPath, realPath, task);
        outcome.applied.push(rel);
        continue;
      }
      // Both sides moved since the snapshot.
      if (
        task !== null &&
        base !== null &&
        current !== null &&
        task.link === undefined &&
        base.link === undefined &&
        current.link === undefined &&
        mergeableText(task.data) &&
        mergeableText(base.data) &&
        mergeableText(current.data)
      ) {
        const merged = await mergeFile({
          current: realPath,
          base: basePath,
          other: taskPath,
          cwd: set.realDir,
        });
        if (merged.clean) {
          await writeBuffer(realPath, Buffer.from(merged.merged, "utf8"));
          outcome.applied.push(rel);
          (outcome.threeWay ??= []).push(rel);
          continue;
        }
      }
      await save(rel, base, task);
      outcome.conflicts.push(rel);
    } catch {
      try {
        await save(rel, base, task);
        outcome.conflicts.push(rel);
      } catch {
        (outcome.lost ??= []).push(rel);
      }
    }
  }
  return outcome;
}

async function writeBuffer(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** A merge the planner should delegate: one per task that hit conflicts. */
export interface MergeTaskSuggestion {
  id: string;
  title: string;
  instructions: string;
  files: string[];
}

export function mergeTaskSuggestion(
  task: Pick<DelegateTask, "id" | "title">,
  outcome: BranchMergeOutcome,
): MergeTaskSuggestion | undefined {
  if (outcome.conflicts.length === 0 || outcome.savedDir === undefined) {
    return undefined;
  }
  const saved = outcome.savedDir.split(sep).join("/");
  const lines = outcome.conflicts.map((rel) => {
    const p = rel.split(sep).join("/");
    return `- ${p}: the folder's version is current; the task's is ${saved}/${p}.task (or ${saved}/${p}.task-removed when it removed the file), and the version both started from is ${saved}/${p}.base.`;
  });
  return {
    id: `merge-${task.id}`,
    title: `Merge ${task.title}`,
    instructions: [
      `Task ${task.id} ("${task.title}") changed files that also changed in the folder while it ran, so they were not merged automatically. For each file below, edit the folder's version in place so it keeps both changes' intent:`,
      ...lines,
      `Then delete ${saved}/.`,
    ].join("\n"),
    files: outcome.conflicts.map((rel) => rel.split(sep).join("/")),
  };
}

/** How many ignored paths a row's note names before it says "and N more". */
const IGNORED_NOTE_NAMES = 10;

/** Whether `path` is `root` or lies under it (both relative, native separators). */
const atOrUnder = (path: string, root: string, platform: NodeJS.Platform): boolean => {
  const child = inputPathIdentity(path, platform), parent = inputPathIdentity(root, platform);
  return child === parent || child.startsWith(`${parent}${platform === "win32" ? "\\" : "/"}`);
};

/**
 * The row after its merge: notes for what landed, the error for what did
 * not. `declared` are the task's declared paths (its `files`, its `provides`
 * file names and `in`), relative to the working directory: one under a
 * path the ignore rules kept out of the merge needs the orchestrator.
 */
export function applyMergeOutcome(
  row: WorkerTaskResult,
  outcome: BranchMergeOutcome,
  declared: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): WorkerTaskResult {
  const notes = [...(row.notes ?? [])];
  if (outcome.applied.length > 0) {
    notes.push(
      `merged ${outcome.applied.length} file${outcome.applied.length === 1 ? "" : "s"} back from its own workspace`,
    );
  }
  const problems: string[] = [];
  const ignored = outcome.ignoredChanges ?? [];
  if (ignored.length > 0) {
    const named = ignored.slice(0, IGNORED_NOTE_NAMES).map((p) => p.split(sep).join("/"));
    const more = ignored.length > named.length ? ` and ${ignored.length - named.length} more` : "";
    notes.push(
      `not merged: ${ignored.length} file${ignored.length === 1 ? "" : "s"} under ignored directories (${named.join(", ")}${more}); git ignore rules keep them out of the folder`,
    );
    const hidden = declared.filter((path) => ignored.some((file) => atOrUnder(file, path, platform)));
    if (hidden.length > 0) {
      problems.push(
        `declared paths lie under ignored directories that are never merged (${hidden.map((p) => p.split(sep).join("/")).join(", ")}); deliver them in tracked or unignored paths`,
      );
    }
  }
  if (outcome.conflicts.length > 0) {
    problems.push(
      `merge conflict in ${outcome.conflicts.join(", ")}: changed in the folder too while this task ran; the folder's version was kept and this task's is saved in ${outcome.savedDir ?? BRANCH_MERGE_DIR} (delegate merge-${row.id})`,
    );
  }
  for (const refused of outcome.refused) {
    problems.push(`merge refused for ${refused.path}: ${refused.reason}, a declared input`);
  }
  if (outcome.lost !== undefined && outcome.lost.length > 0) {
    problems.push(
      `could not write or save ${outcome.lost.join(", ")}: this task's change to ${outcome.lost.length === 1 ? "it" : "them"} is lost and has to be made again`,
    );
  }
  if (problems.length === 0) {
    return notes.length === (row.notes ?? []).length ? row : { ...row, notes };
  }
  return {
    ...row,
    status: row.status === "ok" || row.status === "no_changes" ? "needs_orchestrator" : row.status,
    error: [problems.join("; "), row.error].filter((e) => e !== undefined && e.length > 0).join("; "),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/**
 * Rewrite every mention of a root (the working directory, under any of
 * its spellings) to `to`, longest spelling first and each spot once.
 */
export function rebaseText(text: string, roots: readonly string[], to: string): string {
  const mark = "\u0000workspace\u0000";
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (root.length <= 1) continue;
    out = out.replace(
      new RegExp(`${escapeRegExp(root)}(?=[\\\\/]|$|[^\\w.-])`, "g"),
      mark,
    );
  }
  return out.split(mark).join(to);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The task as its worker sees it: paths into the working directory point into its workspace. */
export function rebaseTask(
  task: DelegateTask,
  roots: readonly string[],
  dir: string,
): DelegateTask {
  const note = `You work in a private copy of the project at ${dir}; what you change there is merged back into the project when you finish.`;
  return {
    ...task,
    instructions: `${note}\n\n${rebaseText(task.instructions, roots, dir)}`,
    ...(task.files === undefined
      ? {}
      : {
          files: task.files.map((f) =>
            isAbsolute(f) ? rebaseText(f, roots, dir) : f,
          ),
        }),
  };
}

/** The approved write scope with every directory inside the working directory moved into `dir`. */
export function rebaseScope(
  scope: readonly string[],
  roots: readonly string[],
  dir: string,
): string[] {
  const privateDir = comparableScopePath(dir);
  if (privateDir === null) return [];
  const comparableRoots = roots.map(comparableScopePath);
  // An uncomparable original root must never leave its possible aliases
  // authorized on the original project. Keep only the private workspace.
  if (comparableRoots.some((root) => root === null)) return [privateDir];
  const safeRoots = comparableRoots.filter((root): root is string => root !== null);
  const out: string[] = [];
  for (const raw of scope) {
    const entry = comparableScopePath(raw);
    if (entry === null) continue;
    const root = [...safeRoots]
      .sort((a, b) => b.length - a.length)
      .find((r) => {
        const rel = relative(resolve(r), resolve(entry));
        return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      });
    const mapped = root === undefined ? entry : join(privateDir, relative(root, entry));
    if (!out.includes(mapped)) out.push(mapped);
  }
  if (!out.includes(privateDir)) out.push(privateDir);
  return out;
}

/** A task's verdict before its merge: its own checks and, when on, the judge. */
export interface GateVerdict {
  /** The row with the verdict folded in. */
  row: WorkerTaskResult;
  /** `false` holds the task's changes back: saved as a patch, the folder untouched. */
  merge: boolean;
  /** Why it is held back, for its row. */
  reason?: string;
  /** Keep its workspace past the wave, for a judge's retry to work on. */
  keep?: boolean;
}

/** What a gate sees of a task's workspace. */
export interface GateWorkspace {
  /** The task's working directory inside its workspace. */
  dir: string;
  /** The working directory the workspace mirrors. */
  realDir: string;
  /** Every spelling of the working directory, for rebasing absolute paths. */
  roots: readonly string[];
  /** What the task changed against the snapshot its workspace started from. */
  changes: () => Promise<WorkspaceChange[]>;
}

/**
 * Decides, inside the workspace and before anything reaches the folder,
 * whether a finished task is merged. Called for the statuses that would
 * merge (`MERGED_STATUSES`), in task order.
 */
export type MergeGate = (
  row: WorkerTaskResult,
  workspace: GateWorkspace,
) => Promise<GateVerdict>;

/** A workspace kept past its wave (`GateVerdict.keep`), with the set it belongs to. */
export interface KeptBranch {
  set: BranchSet;
  workspace: BranchWorkspace;
}

export interface IsolatedWaveInput {
  /** The working directory the wave would otherwise write into. */
  realDir: string;
  tasks: readonly DelegateTask[];
  writeScope: readonly string[];
  /** The contract's declared inputs, as written. */
  inputs: readonly string[];
  /** The contract's `provides`: a task's file names and `in` paths count as declared, like its `files`. */
  provides?: readonly ContractProvide[];
  run: (
    tasks: readonly DelegateTask[],
    taskWorkspace:
      | ((taskId: string) => { workingDir: string; writeScope: readonly string[] } | undefined)
      | undefined,
  ) => Promise<WorkerTaskResult[]>;
  /** Merge only what this passes; absent, every mergeable status merges. */
  gate?: MergeGate;
  /**
   * Workspaces kept from an earlier wave, by task id: those tasks work on
   * in them (and merge against their own base) instead of a fresh one.
   * Their owner removes them (`set.cleanup()`), not this wave.
   */
  kept?: ReadonlyMap<string, KeptBranch>;
  options?: CreateBranchSetOptions & { mergeFile?: MergeFile; patchGit?: PatchGit };
}

export interface IsolatedWaveResult {
  results: WorkerTaskResult[];
  merges: MergeTaskSuggestion[];
  /** Every merge that ran, in the order it reached the folder. */
  outcomes: BranchMergeOutcome[];
  /** Set when the wave ran in place: why it could not be isolated. */
  inPlace?: string;
  /** Workspaces a gate asked to keep; the caller removes them. */
  kept?: Map<string, KeptBranch>;
}

function heldNote(
  reason: string | undefined,
  changes: number,
  patch: SavedTaskPatch | undefined,
  kept: boolean,
): string {
  const why = reason === undefined ? "not merged" : `not merged (${reason})`;
  if (changes === 0) return `${why}: it changed no files`;
  const files = `${changes} file${changes === 1 ? "" : "s"}`;
  let where: string;
  if (patch === undefined) {
    where = `its changes to ${files} could not be saved as a patch`;
  } else {
    where = `its changes to ${files} are kept as a patch at ${patch.path.split(sep).join("/")} (\`git apply\` in the folder); the folder is unchanged`;
    if (patch.filesDir !== undefined) {
      const n = patch.saved ?? 0;
      where += `; ${n} file${n === 1 ? "" : "s"} a text patch cannot carry (binary, too large, empty, a symlink or a mode change) ${n === 1 ? "is" : "are"} saved whole in ${patch.filesDir.split(sep).join("/")}/`;
    }
  }
  return `${why}: ${where}${kept ? "; its workspace is kept for the retry" : ""}`;
}

/**
 * Run one wave with a workspace per task and merge each back, in task
 * order. With a `gate`, a task is merged only when the gate passes it;
 * one it holds back leaves the folder as it was and its changes in a
 * patch file. The workspaces are removed whatever happens, an abort and
 * a throw included, except those a gate kept. If a private workspace
 * cannot be made, no task in this wave starts: requesting isolation must
 * never grant a worker direct access to the original as a fallback.
 */
export async function runIsolatedWave(
  input: IsolatedWaveInput,
): Promise<IsolatedWaveResult> {
  if (input.tasks.length === 0) {
    return { results: await input.run(input.tasks, undefined), merges: [], outcomes: [] };
  }
  const kept = input.kept ?? new Map<string, KeptBranch>();
  const fresh = input.tasks.filter((t) => !kept.has(t.id));
  let set: BranchSet | null = null;
  let reason = "";
  if (fresh.length > 0) {
    try {
      reason = "the folder is too large to copy";
      set = await createBranchSet(
        input.realDir,
        fresh.map((t) => t.id),
        {
          ...input.options,
          onRefusal: (why) => {
            reason = why;
            input.options?.onRefusal?.(why);
          },
        },
      );
    } catch (err) {
      set = null;
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  if (fresh.length > 0 && set === null) {
    return {
      results: input.tasks.map((task): WorkerTaskResult => ({
        id: task.id,
        title: task.title,
        status: "cancelled",
        reply: "",
        stepCount: 0,
        durationMs: 0,
        queueWaitMs: null,
        tools: { calls: 0, errors: 0, writes: 0, byTool: {} },
        error: `not started: could not create a private workspace: ${reason}`,
      })),
      merges: [],
      outcomes: [],
    };
  }
  const freshSet = set;
  const lookup = (taskId: string): KeptBranch | undefined => {
    const own = kept.get(taskId);
    if (own !== undefined) return own;
    const ws = freshSet?.workspaces.get(taskId);
    return ws === undefined || freshSet === null ? undefined : { set: freshSet, workspace: ws };
  };
  const newlyKept = new Map<string, KeptBranch>();
  try {
    const realDir =
      freshSet?.realDir ?? [...kept.values()][0]?.set.realDir ?? input.realDir;
    const roots = [...new Set([input.realDir, realDir])];
    const rebased = input.tasks.map((task) => {
      const branch = lookup(task.id);
      return branch === undefined ? task : rebaseTask(task, roots, branch.workspace.dir);
    });
    const results = await input.run(rebased, (taskId) => {
      const branch = lookup(taskId);
      return branch === undefined
        ? undefined
        : {
            workingDir: branch.workspace.dir,
            writeScope: rebaseScope(input.writeScope, roots, branch.workspace.dir),
          };
    });
    const protectedPaths = new Set(
      resolveContractInputs(input.inputs, realDir)
        .map((abs) => relative(realDir, abs))
        .filter((rel) => rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)),
    );
    // Inputs named through a symlinked path (`/var` vs `/private/var`).
    for (const abs of resolveContractInputs(input.inputs, input.realDir)) {
      const rel = relative(input.realDir, abs);
      if (rel.length > 0 && !rel.startsWith("..")) protectedPaths.add(rel);
    }
    const merges: MergeTaskSuggestion[] = [];
    const outcomes: BranchMergeOutcome[] = [];
    const out: WorkerTaskResult[] = [];
    for (const raw of results) {
      const branch = lookup(raw.id);
      if (branch === undefined) {
        out.push(raw);
        continue;
      }
      const ws = branch.workspace;
      // The planner reads the folder's paths, not a workspace that is
      // about to be removed.
      let row: WorkerTaskResult = {
        ...raw,
        reply: rebaseText(raw.reply, [ws.dir], input.realDir),
        ...(raw.error === undefined
          ? {}
          : { error: rebaseText(raw.error, [ws.dir], input.realDir) }),
      };
      if (!MERGED_STATUSES.has(row.status)) {
        const dropped = (await touchedPaths(ws)).length;
        out.push(
          dropped === 0
            ? row
            : {
                ...row,
                notes: [
                  ...(row.notes ?? []),
                  `its changes to ${dropped} file${dropped === 1 ? "" : "s"} were discarded with its workspace (${row.status})`,
                ],
              },
        );
        continue;
      }
      if (input.gate !== undefined) {
        let verdict: GateVerdict;
        try {
          verdict = await input.gate(row, {
            dir: ws.dir,
            realDir: input.realDir,
            roots,
            changes: () => workspaceChanges(branch.set, ws),
          });
        } catch (err) {
          verdict = {
            row,
            merge: false,
            reason: `its checks could not be run: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        row = verdict.row;
        if (!verdict.merge) {
          const changes = await workspaceChanges(branch.set, ws).catch(
            (): WorkspaceChange[] => [],
          );
          let patch: SavedTaskPatch | undefined;
          if (changes.length > 0) {
            patch = await writeTaskPatch({
              realDir,
              set: branch.set,
              workspace: ws,
              taskId: row.id,
              changes,
              ...(input.options?.patchGit === undefined
                ? {}
                : { patchGit: input.options.patchGit }),
              ...(input.options?.tmpRoot === undefined
                ? {}
                : { tmpRoot: input.options.tmpRoot }),
            }).catch(() => undefined);
          }
          const keep = verdict.keep === true && changes.length > 0;
          if (keep) newlyKept.set(row.id, branch);
          out.push({
            ...row,
            notes: [
              ...(row.notes ?? []),
              heldNote(verdict.reason, changes.length, patch, keep),
            ],
          });
          continue;
        }
      }
      const outcome = await mergeBranch(
        branch.set,
        ws,
        protectedPaths,
        input.options?.mergeFile,
      );
      outcomes.push(outcome);
      // Green now: an earlier attempt's held-back patch is stale.
      if (input.gate !== undefined) await removeTaskPatch(realDir, row.id);
      const task = input.tasks.find((t) => t.id === row.id);
      out.push(applyMergeOutcome(row, outcome, declaredPaths(task, input.provides, [input.realDir, realDir])));
      const suggestion =
        task === undefined ? undefined : mergeTaskSuggestion(task, outcome);
      if (suggestion !== undefined) merges.push(suggestion);
    }
    return {
      results: out,
      merges,
      outcomes,
      ...(newlyKept.size === 0 ? {} : { kept: newlyKept }),
    };
  } finally {
    if (freshSet !== null) {
      await freshSet.cleanup(
        [...newlyKept].filter(([, b]) => b.set === freshSet).map(([id]) => id),
      );
    }
  }
}

/**
 * A task's declared paths (`files`, its `provides` file names and `in`)
 * relative to the working directory; ones outside it are left out.
 */
function declaredPaths(
  task: DelegateTask | undefined,
  provides: readonly ContractProvide[] | undefined,
  roots: readonly string[],
): string[] {
  if (task === undefined) return [];
  const named = [
    ...(task.files ?? []),
    ...(provides ?? []).filter((p) => p.task === task.id).flatMap((p) => [...(p.kind === "file" ? [p.name] : []), ...(p.in === undefined ? [] : [p.in])]),
  ];
  const out = new Set<string>();
  for (const path of named) {
    const rel = isAbsolute(path)
      ? roots.map((root) => relative(root, path)).find((r) => !r.startsWith("..") && !isAbsolute(r))
      : normalize(path);
    if (rel === undefined || rel.length === 0 || rel === "." || rel.startsWith("..")) continue;
    out.add(rel.replace(/[\\/]+$/, ""));
  }
  return [...out];
}

/** The block under the status table that hands conflicts to the planner. */
export function renderMergeBlock(merges: readonly MergeTaskSuggestion[]): string {
  if (merges.length === 0) return "";
  const lines = merges.map(
    (m) => `- ${m.id}: ${m.title} (files: ${m.files.join(", ")})`,
  );
  return [
    "",
    "",
    `Merge needed: ${merges.length} task${merges.length === 1 ? "" : "s"} changed files that also changed in the folder while they ran. The folder's versions were kept. Delegate each merge below as a task (its instructions are in details.merges), or tell the person:`,
    ...lines,
  ].join("\n");
}
