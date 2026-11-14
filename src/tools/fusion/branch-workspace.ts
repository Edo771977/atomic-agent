/**
 * A workspace per fusion task (branch isolation, ATO-946).
 *
 * Parallel workers used to write straight into the working directory:
 * two of them editing the same file raced, and a worker that went wrong
 * left its damage behind with nothing to throw away. With
 * `llm.runMode.fusion.isolation: "worktree"` every task of a wave gets
 * a workspace of its own, made from one snapshot of the working
 * directory taken just before the wave, plus one more workspace from
 * the same snapshot that nobody writes to: the merge base
 * (`branch-merge.ts`).
 *
 * Inside a git repo a workspace is a detached `git worktree` of a
 * snapshot commit: `git stash create` captures the tracked files'
 * uncommitted state without touching the working tree or the stash
 * list (HEAD when there is nothing uncommitted). The commit supplies
 * Git metadata only: a tracked path whose checkout differs from the
 * original's actual bytes is overlaid from them into the base, then from
 * that frozen base into each task, bypassing clean/smudge filters and
 * Git's stat cache; an identical checkout is kept (only its mode and
 * times are the source's) and costs no copy budget. Untracked files and
 * ignored files are copied in. Ignored directories (a virtualenv, `dist/`,
 * a cache) are normally symlinked to the original's like the shared
 * dependency directories (`node_modules`, `target`, `.venv`) and cost no
 * copy budget; with `privateDependencyDirectories` (a candidate) ignored
 * directories are copied privately and tasks copy the dependency
 * directories privately too. A
 * denied generated symlink becomes a junction; only with no link at all
 * does it become a bounded private copy, made once in the base and
 * linked from there by the tasks when they can.
 * Outside git, or when git cannot snapshot
 * (no commit yet, a merge in progress, no git binary), a workspace is
 * a private folder copy without the original's git metadata. Copying
 * is bounded across the base and every task. A tree too large to copy is not
 * isolated at all; the caller refuses the wave before any worker starts.
 *
 * Dependencies and build outputs are readable but never merged; private
 * copies keep a task's writes to them disposable, while writes through a
 * shared dependency link land in the original (as on `verify.run`). Existing user symlinks retain their targets; this is
 * workspace isolation, not a process sandbox. Submodules are not checked
 * out in a worktree.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand, type CommandResult } from "../../sandbox/command-runner.js";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import { VERIFY_COPY_EXCLUDED, VERIFY_COPY_MAX_BYTES } from "../verify/verify-workspace-copy.js";
import { createDirectoryIgnorePolicy, type DirectoryIgnorePolicy, type IgnoreGit } from "./branch-ignore-policy.js";

/** Where conflicting sides are saved for the merge task, relative to the working directory. */
export const BRANCH_MERGE_DIR = join(".atomic-agent", "fusion-merge");

/**
 * The merge folder inside `realDir`, made with a `.gitignore` of `*`
 * so nothing saved there (patches, conflict sides) is committed by
 * accident. Returns its absolute path.
 */
export async function ensureMergeDir(realDir: string): Promise<string> {
  const dir = join(realDir, BRANCH_MERGE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
  return dir;
}

/** Every temporary folder fusion makes starts with this (run roots, patch stores). */
export const FUSION_TMP_PREFIX = "atag-fusion-";
/** The run root's owner record: the process that may still use it. */
const OWNER_FILE = "owner.json";
/** A fusion folder with no owner record is left alone this long (it may be being made). */
const UNOWNED_GRACE_MS = 60 * 60 * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function staleRoot(root: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(root, OWNER_FILE), "utf8")) as { pid?: unknown; recovery?: unknown };
    if (owner.recovery === true) return false;
    return typeof owner.pid !== "number" || !processAlive(owner.pid);
  } catch {
    const info = await stat(root).catch(() => null);
    return info !== null && Date.now() - info.mtimeMs > UNOWNED_GRACE_MS;
  }
}

/**
 * Make git forget the worktrees at or under `removed`, whose folders
 * Node's `rm` already deleted: `git worktree prune`, then, only for a
 * registration prune left (a locked one) whose folder is really gone,
 * `git worktree remove --force`. Git never walks a live workspace
 * tree: one that holds a generated junction could lead a Git for
 * Windows recursive delete into the original's dependency directory,
 * while Node's `rm` removes a link (symlink or junction) without
 * following it. Never throws.
 */
async function forgetRemovedWorktrees(git: GitExec, top: string, removed: readonly string[]): Promise<void> {
  if (removed.length === 0) return;
  try {
    await git(["worktree", "prune"], top);
    const listed = await git(["worktree", "list", "--porcelain", "-z"], top);
    if (!ok(listed)) return;
    let left = false;
    for (const line of zList(listed.stdout)) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      if (!removed.some((root) => path === root || path.startsWith(`${root}${sep}`))) continue;
      if (await lstat(path).then(() => true, () => false)) continue;
      await git(["worktree", "remove", "--force", "--force", path], top);
      left = true;
    }
    if (left) await git(["worktree", "prune"], top);
  } catch {
    // Housekeeping: a leftover registration is pruned by a later run.
  }
}

/**
 * `rm -r` of a workspace tree. Workspace directories carry the original's
 * modes, so a read-only directory in the project is read-only here too
 * and, for a non-root user, refuses deleting its entries. On EACCES/EPERM
 * every directory in the tree (links never followed) gets owner rwx and
 * the removal is retried once. `remove` is a test seam.
 */
export async function removeWorkspaceTree(
  path: string,
  remove: (target: string) => Promise<void> = (target) => rm(target, { recursive: true, force: true }),
): Promise<void> {
  try {
    await remove(path);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
  }
  const unlock = async (dir: string): Promise<void> => {
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return;
    await chmod(dir, (info.mode & 0o777) | 0o700).catch(() => undefined);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await unlock(join(dir, entry.name));
    }
  };
  await unlock(path);
  await remove(path);
}

/**
 * Remove what a fusion run that died (a crash, a kill, a throw nobody
 * cleaned up after) left behind: its run roots under `tmpRoot` whose
 * owner process is gone, and the git worktrees `repoTop` still records
 * inside them (folders first, with Node; see `forgetRemovedWorktrees`).
 * A root another live process owns is never touched. Never throws.
 */
export async function sweepStaleBranchSets(
  tmpRoot: string,
  repoTop: string | undefined,
  git: GitExec,
): Promise<void> {
  try {
    const stale: string[] = [];
    for (const entry of await readdir(tmpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(FUSION_TMP_PREFIX)) continue;
      const root = join(tmpRoot, entry.name);
      if (await staleRoot(root)) stale.push(await realpath(root).catch(() => root));
    }
    for (const root of stale) await removeWorkspaceTree(root).catch(() => undefined);
    if (repoTop !== undefined) await forgetRemovedWorktrees(git, repoTop, stale);
  } catch {
    // Housekeeping; never a reason to fail a fan-out.
  }
}

export type BranchMethod = "worktree" | "clonefile" | "copy";

/**
 * Size, mtime and mode of one file or symlink at workspace creation:
 * what "changed" is measured against. A chmod moves only the mode.
 */
export interface FileStamp {
  size: number;
  mtimeMs: number;
  /** Permission bits; a symlink's are not compared. */
  mode?: number;
  /** A symlink, stamped itself (never followed). */
  link?: boolean;
}

export interface BranchWorkspace {
  readonly taskId: string;
  /** Short, path-safe name: the workspace's folder and its merge folder. */
  readonly name: string;
  /** The task's working directory: the working directory's twin inside the workspace. */
  readonly dir: string;
  /** Files as they were when the workspace was made, by path relative to `dir`. */
  readonly manifest: ReadonlyMap<string, FileStamp>;
  /** Private ignored directories: available to checks, never merged as outputs. */
  readonly excludedDirectories?: ReadonlySet<string>;
  /** Frozen rules also classify ignored directories created after dispatch. */
  readonly directoryIgnorePolicy?: DirectoryIgnorePolicy;
  /** Tracked files and their ancestor directories: never excluded by name or ignore rule. */
  readonly trackedPaths?: ReadonlySet<string>;
  /**
   * Files under directories the frozen ignore rules classify as ignored
   * (not linked, not excluded by name) at creation: what a merge leaves
   * out, so a new or changed one can be reported instead of dropped silently.
   */
  readonly ignoredManifest?: ReadonlyMap<string, FileStamp>;
}

export interface BranchSet {
  /** Keep a rejected candidate for manual recovery when a bounded patch cannot be saved; never resumable. */
  retainForRecovery?(): Promise<void>;
  readonly method: BranchMethod;
  /** The working directory the workspaces mirror and are merged back into. */
  readonly realDir: string;
  /** The untouched snapshot every workspace started from. */
  readonly baseDir: string;
  readonly workspaces: ReadonlyMap<string, BranchWorkspace>;
  /**
   * Removes every workspace (worktrees included) and prunes git's
   * records. Never throws. With `keep`, the workspaces of those task ids
   * and the base stay for a later call (a judge's retry works on in the
   * workspace it was judged red in); a call without `keep` removes the
   * rest.
   */
  cleanup(keep?: readonly string[]): Promise<void>;
}

/** Runs git; resolves `null` when git is not there to run. */
export type GitExec = (
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult | null>;

export interface CreateBranchSetOptions {
  signal?: AbortSignal;
  tmpRoot?: string;
  platform?: NodeJS.Platform;
  /** Test seam. */
  git?: GitExec;
  /** Test seam: independent Git evaluator for frozen directory-ignore rules. */
  ignoreGit?: IgnoreGit;
  /** Maximum actual copied bytes across base and tasks; not Git's separate checkout materializations. */
  maxCopyBytes?: number;
  /**
   * Give each task workspace a private copy of the shared dependency
   * directories (charged to the copy budget) instead of a link to the
   * original's, and copy every ignored directory privately (into the base
   * too) instead of linking it. Candidate integration sets this: nothing
   * may reach the original before promotion. The base, which nobody writes
   * to, still links the dependency directories.
   */
  privateDependencyDirectories?: boolean;
  /** Told why `createBranchSet` returned `null` (the copy limit), in words for the user. */
  onRefusal?: (reason: string) => void;
}

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Git with no pager, no prompt, no hooks and none of the agent's keys
 * in its environment (the same rules as `runGit`).
 */
async function executeGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<CommandResult | null> {
  signal?.throwIfAborted();
  try {
    return await runCommand(
      "git",
      ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args],
      {
        cwd,
        env: {
          ...buildCommandEnv(process.env),
          GIT_PAGER: "",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        timeoutMs: GIT_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      },
    );
  } catch {
    return null;
  }
}
export const defaultGitExec: GitExec = (args, cwd) => executeGit(args, cwd);

function ok(result: CommandResult | null): result is CommandResult {
  return (
    result !== null &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.truncated
  );
}

/** `NUL`-separated git output as a list, empty entries dropped. */
function zList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** `t0-build_parser`: index first so two ids that sanitise alike stay apart. */
export function workspaceName(index: number, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `t${index}-${safe}`;
}

function isUnderMergeDir(rel: string): boolean {
  return rel === BRANCH_MERGE_DIR || rel.startsWith(`${BRANCH_MERGE_DIR}${sep}`);
}

/**
 * Every regular file and symlink under `root` with its size, mtime and
 * mode. Symlinks are stamped, not followed; the copy exclusions (`.git`,
 * `node_modules`, …) and the merge folder are skipped: none of it is
 * merged back. A path in `trackedPaths` (a tracked file or one of its
 * ancestors, e.g. `scripts/build`) is kept despite its name or an ignore
 * rule: a tracked change there is a deliverable. Files left out because
 * an ignore rule classifies one of their directories go to `dropped`.
 */
export async function stampTree(
  root: string,
  excludedDirectories: ReadonlySet<string> = new Set(),
  directoryIgnorePolicy?: DirectoryIgnorePolicy,
  signal?: AbortSignal,
  trackedPaths: ReadonlySet<string> = new Set(),
  dropped?: Map<string, FileStamp>,
): Promise<Map<string, FileStamp>> {
  signal?.throwIfAborted();
  const out = new Map<string, FileStamp>();
  const directories: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.name === ".git") continue;
      if (VERIFY_COPY_EXCLUDED.has(entry.name) && !trackedPaths.has(rel)) continue;
      if (isUnderMergeDir(rel) || excludedDirectories.has(rel)) continue;
      if (entry.isDirectory()) {
        directories.push(rel);
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const info = await lstat(full);
          signal?.throwIfAborted();
          out.set(
            rel,
            info.isSymbolicLink()
              ? { size: info.size, mtimeMs: info.mtimeMs, link: true }
              : { size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 },
          );
        } catch {
          signal?.throwIfAborted();
          // Vanished mid-walk.
        }
      }
    }
  }
  signal?.throwIfAborted();
  const ignored = await directoryIgnorePolicy?.(directories, signal);
  signal?.throwIfAborted();
  if (ignored !== undefined && ignored.size > 0) {
    for (const rel of out.keys()) {
      signal?.throwIfAborted();
      if (trackedPaths.has(rel)) continue;
      for (let dir = dirname(rel); dir !== "."; dir = dirname(dir)) {
        if (ignored.has(dir)) { dropped?.set(rel, out.get(rel)!); out.delete(rel); break; }
      }
    }
  }
  return out;
}

/**
 * Copy one file with its permission bits and its times. The times are
 * the source's, not the copy's: the declared-file check reads an mtime
 * at or after the worker's start as "written by this task", so a
 * workspace made just before it ran would make every idle worker look
 * like it wrote its files (`ok` instead of `no_changes`). The task's
 * manifest is still stamped from the copy, and any later write moves
 * the mtime away from the preserved one.
 */
async function copyFileKeepingMode(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  const info = await lstat(from);
  await chmod(to, info.mode & 0o777);
  await utimes(to, info.atime, info.mtime);
}

class PrivateCopyLimitError extends Error {
  /** `pending`: bytes of the file that did not fit, not yet charged. */
  constructor(readonly pending = 0) { super("the private workspace copies exceed the copy byte limit"); }
}

/** Why a dependency directory was copied: no link was possible, or a candidate must own it. */
type DependencyCopyKind = "unlinked" | "private";

/**
 * Run a dependency directory's copy, charging its bytes (including a
 * file that did not fit) to `kind`; a nested dependency directory is
 * charged to the outermost copy only.
 */
async function chargeDependencyCopy(budget: PrivateCopyBudget, kind: DependencyCopyKind, copy: () => Promise<void>): Promise<void> {
  if (budget.chargingDependency === true) return copy();
  budget.chargingDependency = true;
  const before = budget.left;
  let pending = 0;
  try {
    await copy();
  } catch (err) {
    if (err instanceof PrivateCopyLimitError) pending = err.pending;
    throw err;
  } finally {
    delete budget.chargingDependency;
    budget.dependencyBytes[kind] += before - budget.left + pending;
  }
}

/**
 * The refusal for a copy that hit the limit: dependency copies are named
 * only when the rest of what was copied, the file that did not fit
 * included, would have fitted without them.
 */
function copyLimitReason(budget: PrivateCopyBudget, limit: number, err: PrivateCopyLimitError): string {
  const needed = limit - budget.left + err.pending;
  const blame = (bytes: number): boolean => bytes > 0 && needed - bytes <= limit;
  if (blame(budget.dependencyBytes.unlinked)) {
    return `dependency folders could not be linked on this system and copying them exceeds the copy limit (${limit} bytes)`;
  }
  if (blame(budget.dependencyBytes.private)) {
    return `the candidate's private copy of the dependency folders exceeds the copy limit (${limit} bytes)`;
  }
  return "the folder is too large to copy";
}

interface PrivateCopyBudget {
  left: number;
  signal?: AbortSignal;
  /** Only links made by this copy operation may be expanded on link failure. */
  generatedDirectoryLinks: Map<string, string>;
  /**
   * Set while making a workspace that must own its dependency directories:
   * the original they are copied from (the base only holds links to it).
   */
  privateDependenciesFrom?: string;
  /**
   * With `privateDependenciesFrom`: the git repository holding the
   * original (`top`, and the working directory relative to it). `worktree`
   * when every workspace is a worktree of the whole repository; otherwise
   * only the working directory is copied.
   */
  privateDependencyRepository?: { top: string; rel: string; worktree: boolean };
  /** Set while making a private-dependency set's base: unlinkable dependencies get an empty placeholder. */
  dependencyPlaceholders?: boolean;
  /** Bytes charged by dependency directory copies, by why they were copied. */
  dependencyBytes: Record<DependencyCopyKind, number>;
  /** Set while a dependency directory's copy is being charged. */
  chargingDependency?: boolean;
  /** A candidate's set: ignored directories are copied privately, not linked to the original. */
  privateIgnoredDirectories?: boolean;
}

/**
 * Dependency and build-cache directories shared with the original by a
 * symlink instead of copied: they are routinely far larger than the
 * project itself (hundreds of MB, 100k+ files), and copying them into
 * the base and every task both blew the copy limit and refused isolation
 * for ordinary repos. Never stamped or merged (`VERIFY_COPY_EXCLUDED`).
 * Writes through the link reach the original, as for `verify.run`;
 * `privateDependencyDirectories` copies them instead. Hosts that deny
 * symlinks get junctions; with no link at all, budgeted private copies.
 */
export const SHARED_DEPENDENCY_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", "target", ".venv"]);

/** Link errors that mean "this host cannot make that link", not a broken tree. */
const LINK_UNAVAILABLE = ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"];

function linkUnavailable(err: unknown, codes: readonly string[] = LINK_UNAVAILABLE): boolean {
  return codes.includes((err as NodeJS.ErrnoException).code ?? "");
}

/**
 * A directory link to `target`: a symlink, else (Windows without the
 * symlink privilege) a junction, which resolves the same way. `false`
 * when the host allows neither; other errors throw.
 */
async function linkDirectory(target: string, to: string): Promise<boolean> {
  try {
    await symlink(target, to, "dir");
    return true;
  } catch (err) {
    if (!linkUnavailable(err)) throw err;
  }
  try {
    // Node ignores the type outside Windows; there it makes a junction.
    await symlink(target, to, "junction");
    return true;
  } catch (err) {
    // A junction cannot reach every volume (network shares: EINVAL).
    if (!linkUnavailable(err, [...LINK_UNAVAILABLE, "EINVAL", "EXDEV"])) throw err;
    return false;
  }
}

/**
 * Share a real directory by a link (symlink or junction). When no link
 * is possible the directory is copied privately, counted against the
 * budget, and remembered so a refusal can name the cause; the base of a
 * private-dependency set, which nobody writes to or runs in, instead
 * holds an empty placeholder (its tasks copy from the original).
 */
async function linkDirectoryOrCopy(from: string, to: string, budget: PrivateCopyBudget, rel: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  if (await linkDirectory(from, to)) {
    budget.generatedDirectoryLinks.set(to, from);
    return;
  }
  budget.signal?.throwIfAborted();
  if (budget.dependencyPlaceholders === true) {
    await mkdir(to, { recursive: true });
    return;
  }
  await chargeDependencyCopy(budget, "unlinked", () => copyPrivateEntry(from, to, budget, rel, false));
}

/** Whether any component of `rel` names a shared dependency directory. */
function underSharedDependencyDirectory(rel: string): boolean {
  return rel.split(sep).some((name) => SHARED_DEPENDENCY_DIRECTORIES.has(name));
}

/**
 * Copy entries without sharing the source's git metadata. Only links
 * created here point back at the source: a shared dependency directory
 * (`SHARED_DEPENDENCY_DIRECTORIES`), or with `shared` an ignored
 * directory inside one, which costs no copy budget. With
 * `budget.privateDependenciesFrom` such an entry is instead copied
 * privately from the original (the source's link would lead there).
 */
async function copyPrivateEntry(
  from: string,
  to: string,
  budget: PrivateCopyBudget,
  rel = "",
  shared = rel.length > 0 && SHARED_DEPENDENCY_DIRECTORIES.has(basename(rel)),
): Promise<void> {
  budget.signal?.throwIfAborted();
  if (isUnderMergeDir(rel)) return;
  if (shared && budget.privateDependenciesFrom !== undefined) {
    const origin = join(budget.privateDependenciesFrom, rel);
    const own = await lstat(origin).catch(() => null);
    // A user's own link (or a path only the source has) keeps its normal copy.
    if (own !== null && !own.isSymbolicLink()) {
      // Nested shared names redirect to the same original path: copied too.
      await chargeDependencyCopy(budget, "private", () => copyPrivateEntry(origin, to, budget, rel, false));
      return;
    }
  }
  const info = await lstat(from);
  if (shared && budget.privateDependenciesFrom === undefined && info.isDirectory()) {
    await linkDirectoryOrCopy(await realpath(from), to, budget, rel);
  } else if (info.isSymbolicLink() && budget.generatedDirectoryLinks.has(from)) {
    await linkDirectoryOrCopy(budget.generatedDirectoryLinks.get(from)!, to, budget, rel);
  } else if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (name === ".git") continue;
      await copyPrivateEntry(join(from, name), join(to, name), budget, join(rel, name));
    }
  } else if (info.isSymbolicLink()) {
    await mkdir(dirname(to), { recursive: true });
    await recreateLink(from, to, budget, rel);
  } else if (info.isFile()) {
    if (info.size > budget.left) throw new PrivateCopyLimitError(info.size);
    budget.left -= info.size;
    await copyFileKeepingMode(from, to);
    budget.signal?.throwIfAborted();
    // A file growing during the copy must not evade the shared limit.
    budget.left -= (await lstat(to)).size - info.size;
    if (budget.left < 0) throw new PrivateCopyLimitError();
  } else {
    throw new Error(`cannot copy a special workspace entry: ${from}`);
  }
}

/** `target` relative to `root` when it lies inside it, lexically or through its parent's real path. */
async function insideRoot(target: string, root: string): Promise<string | undefined> {
  const within = (path: string): string | undefined => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : undefined;
  };
  const lexical = within(target);
  if (lexical !== undefined) return lexical;
  const parent = await realpath(dirname(target)).catch(() => null);
  return parent === null ? undefined : within(join(parent, basename(target)));
}

/**
 * Where a private dependency copy's link to the absolute `target` must
 * point: the same place in this workspace when it lies inside the
 * original (`workspaceDir`), or inside the repository a worktree holds
 * whole; kept as it is when outside the repository. A target inside the
 * repository but outside a folder copy cannot be made private: throws.
 */
async function privateDependencyTarget(target: string, workspaceDir: string, budget: PrivateCopyBudget, rel: string): Promise<string> {
  const inside = await insideRoot(target, budget.privateDependenciesFrom!);
  if (inside !== undefined) return join(workspaceDir, inside);
  const repository = budget.privateDependencyRepository;
  const inRepository = repository === undefined ? undefined : await insideRoot(target, repository.top);
  if (repository === undefined || inRepository === undefined) return target;
  const where = `the dependency link ${rel} points into the repository outside the working directory (${target})`;
  if (!repository.worktree) {
    throw new Error(`${where}; only the working directory is copied, so a write through it would reach the original`);
  }
  const worktreeRoot = repository.rel.length === 0 ? workspaceDir : workspaceDir.slice(0, workspaceDir.length - repository.rel.length - 1);
  const mapped = join(worktreeRoot, inRepository);
  const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
  if (!await exists(mapped) && await exists(target)) {
    throw new Error(`${where}, which the private worktree does not hold (an untracked or ignored path)`);
  }
  return mapped;
}

/**
 * Copy a user's symlink with its target. Inside a private dependency
 * copy (`budget.privateDependenciesFrom`), an absolute target inside the
 * original (npm workspaces on Windows, pnpm: `node_modules/@s/pkg` →
 * `<project>/packages/pkg`) is pointed at the same place in this
 * workspace instead, so a write through it stays private; in a worktree
 * the same holds for a target elsewhere in the repository (a monorepo's
 * sibling package), and in a folder copy such a target refuses setup
 * (`privateDependencyTarget`). A relative target under a dependency
 * directory is kept when it resolves inside the source tree (from the
 * source link's own folder); one leaving it becomes its absolute
 * original target, then follows the same rules. Targets outside the
 * repository (or, without one, the original) are kept. Where the host denies symlinks, a directory target
 * under a dependency directory becomes a junction to the same resolved
 * path; otherwise the copy fails, naming the link (it is never expanded
 * into a copy).
 */
async function recreateLink(from: string, to: string, budget: PrivateCopyBudget, rel: string): Promise<void> {
  let target = await readlink(from);
  const dependency = rel.length > 0 && underSharedDependencyDirectory(rel) && from.endsWith(`${sep}${rel}`) && to.endsWith(`${sep}${rel}`);
  if (dependency && !isAbsolute(target)) {
    // Resolved where the source link lives: one leaving the source tree
    // would dangle (or hit an unrelated folder) next to the copy.
    const resolved = resolve(dirname(from), target);
    if (await insideRoot(resolved, from.slice(0, from.length - rel.length - 1)) === undefined) target = resolved;
  }
  if (dependency && budget.privateDependenciesFrom !== undefined && isAbsolute(target)) {
    target = await privateDependencyTarget(target, to.slice(0, to.length - rel.length - 1), budget, rel);
  }
  // Windows picks a link's type from its target when none is given, and
  // the target (rewritten into this workspace) may not be copied yet: an
  // untyped link to a directory would then be a broken file link. Take
  // the type from what the original link points at.
  const type = await stat(from).then((found) => found.isDirectory() ? "dir" as const : "file" as const, () => undefined);
  let denied: unknown;
  try {
    await symlink(target, to, type);
    return;
  } catch (err) {
    if (!linkUnavailable(err)) throw err;
    denied = err;
  }
  budget.signal?.throwIfAborted();
  // Only under a dependency directory: never inventoried or merged, so a
  // junction's absolute link text cannot be mistaken for a change.
  if (underSharedDependencyDirectory(rel) && type === "dir") {
    try {
      // A junction needs an absolute target; resolve it where the link lives.
      await symlink(resolve(dirname(to), target), to, "junction");
      return;
    } catch (err) {
      if (!linkUnavailable(err, [...LINK_UNAVAILABLE, "EINVAL", "EXDEV"])) throw err;
    }
  }
  const why = denied instanceof Error ? denied.message : String(denied);
  throw new Error(`cannot recreate the link ${rel || "."} in a private workspace: ${why}`);
}

/**
 * Give every real directory under `dir` that `source` also has the
 * source directory's permission bits. `mkdir` and `git worktree add`
 * apply the umask, so a `chmod 775 src` (or `700`) in the original would
 * otherwise read as a change: the candidate compares directory modes.
 * Deepest first, so a read-only directory is restricted only once its
 * children exist. Links (generated or the user's) are never followed.
 */
async function matchDirectoryModes(source: string, dir: string, signal?: AbortSignal): Promise<void> {
  const changes: { path: string; mode: number }[] = [];
  const walk = async (rel: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const child = join(rel, entry.name);
      if (isUnderMergeDir(child)) continue;
      const from = await lstat(join(source, child)).catch(() => null);
      if (from?.isDirectory() === true) {
        const to = await lstat(join(dir, child));
        if ((to.mode & 0o7777) !== (from.mode & 0o7777)) changes.push({ path: join(dir, child), mode: from.mode & 0o7777 });
      }
      await walk(child);
    }
  };
  await walk("");
  for (const change of changes.reverse()) await chmod(change.path, change.mode);
}

/** Whether two regular files of the same size hold the same bytes. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([open(a, "r"), open(b, "r")]);
  try {
    const one = Buffer.alloc(64 * 1024);
    const two = Buffer.alloc(64 * 1024);
    for (;;) {
      const [x, y] = await Promise.all([left.read(one, 0, one.length, null), right.read(two, 0, two.length, null)]);
      if (x.bytesRead !== y.bytesRead) return false;
      if (x.bytesRead === 0) return true;
      if (!one.subarray(0, x.bytesRead).equals(two.subarray(0, y.bytesRead))) return false;
    }
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}

/**
 * Keep a checked-out tracked entry that already holds the source's
 * bytes (or a symlink's target), giving a file the source's permission
 * bits and times; `false` when it differs and must be replaced.
 */
async function adoptCheckoutEntry(from: string, info: Stats, to: string): Promise<boolean> {
  const there = await lstat(to).catch(() => null);
  if (there === null) return false;
  if (info.isSymbolicLink()) {
    return there.isSymbolicLink() && await readlink(from) === await readlink(to);
  }
  if (!info.isFile() || !there.isFile() || there.size !== info.size) return false;
  if (!await sameBytes(from, to)) return false;
  if ((there.mode & 0o777) !== (info.mode & 0o777)) await chmod(to, info.mode & 0o777);
  // Source times, as for a copy (`copyFileKeepingMode`).
  await utimes(to, info.atime, info.mtime);
  return true;
}

/** What a git snapshot needs: the commit, and what lives outside it. */
interface GitSnapshot {
  top: string;
  /** The working directory relative to the repo's top. */
  rel: string;
  commit: string;
  tracked: string[];
  untracked: string[];
  /** Ignored entries; a trailing `/` marks a directory. */
  ignored: string[];
}

async function gitSnapshot(
  realDir: string,
  git: GitExec,
): Promise<GitSnapshot | null> {
  const topResult = await git(["rev-parse", "--show-toplevel"], realDir);
  if (!ok(topResult)) return null;
  const top = await realpath(topResult.stdout.trim()).catch(() => null);
  if (top === null) return null;
  const rel = relative(top, realDir);
  if (rel.startsWith("..")) return null;
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], realDir);
  if (!ok(head)) return null;
  // A commit object of the tracked files' current state; the working
  // tree, the index and the stash list are left exactly as they were.
  const stash = await git(["stash", "create"], realDir);
  if (!ok(stash)) return null;
  const commit = stash.stdout.trim() || head.stdout.trim();
  const tracked = await git(["ls-files", "--cached", "-z"], realDir);
  const untracked = await git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    realDir,
  );
  const ignored = await git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    realDir,
  );
  if (!ok(tracked) || !ok(untracked) || !ok(ignored)) return null;
  return {
    top,
    rel,
    commit,
    tracked: zList(tracked.stdout),
    untracked: zList(untracked.stdout),
    ignored: zList(ignored.stdout),
  };
}

/** The git repository's top holding `realDir`, even where it cannot be snapshotted. */
async function repositoryTop(realDir: string, git: GitExec): Promise<string | undefined> {
  const result = await git(["rev-parse", "--show-toplevel"], realDir);
  if (!ok(result)) return undefined;
  const top = await realpath(result.stdout.trim()).catch(() => null);
  return top === null || relative(top, realDir).startsWith("..") ? undefined : top;
}

/** One worktree of the snapshot at `root`, with private copies of what git does not carry. */
async function addWorktree(
  snapshot: GitSnapshot,
  realDir: string,
  root: string,
  git: GitExec,
  budget: PrivateCopyBudget,
): Promise<string> {
  const added = await git(
    ["worktree", "add", "--detach", "--quiet", root, snapshot.commit],
    snapshot.top,
  );
  // Read before `ok` narrows: its false branch types a failed run as null.
  const failure = added?.stderr ?? "git not found";
  if (!ok(added)) {
    throw new Error(`git worktree add failed: ${failure.trim()}`);
  }
  const dir = snapshot.rel.length === 0 ? root : join(root, snapshot.rel);
  await mkdir(dir, { recursive: true });
  for (const path of snapshot.tracked) {
    const from = join(realDir, path);
    let info;
    try {
      info = await lstat(from);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const to = join(dir, path);
    // The checkout already holds the source's bytes (the common case):
    // only its mode and times are made the source's, nothing is copied
    // or charged to the copy limit.
    if (info !== undefined && await adoptCheckoutEntry(from, info, to)) continue;
    // Checkout filters and a cached-clean index may disagree with the
    // working tree. Replace, never normalize, the actual source entry.
    await rm(to, { recursive: true, force: true });
    if (info?.isDirectory()) {
      // A submodule remains unpopulated, as with Git worktree checkout.
      // Untracked children of a file replaced by a directory follow below.
      await mkdir(to, { recursive: true });
    } else if (info !== undefined) {
      await copyPrivateEntry(from, to, budget, path);
    }
  }
  for (const path of snapshot.untracked) {
    await copyPrivateEntry(join(realDir, path), join(dir, path), budget, path);
  }
  for (const entry of snapshot.ignored) {
    const isDir = entry.endsWith("/");
    const path = (isDir ? entry.slice(0, -1) : entry).split("/").join(sep);
    // Outside a candidate an ignored directory (a virtualenv, `.next/`,
    // `dist/`, a cache) is linked to the original's, as a dependency
    // directory is: direct mode is not a sandbox, and copying them into
    // the base and every task refused isolation for ordinary repos. A
    // candidate keeps private copies (dependency names aside). Git lists
    // ignored children (`node_modules/big/`) when a tracked placeholder
    // keeps the dependency directory itself unignored.
    const shared = isDir && (budget.privateIgnoredDirectories !== true || underSharedDependencyDirectory(path));
    await copyPrivateEntry(join(realDir, path), join(dir, path), budget, path, shared);
  }
  return dir;
}

/**
 * The base and one workspace per task, all from one snapshot of
 * `realDir`. `null` when nothing can be isolated (a tree too large to
 * copy); throws only when a workspace that was started cannot be
 * finished, after removing what was made.
 */
export async function createBranchSet(
  realDir: string,
  taskIds: readonly string[],
  options: CreateBranchSetOptions = {},
): Promise<BranchSet | null> {
  options.signal?.throwIfAborted();
  const git = options.git ?? ((args, cwd) => executeGit(args, cwd, options.signal));
  const cleanupGit = options.git ?? defaultGitExec;
  const real = await realpath(realDir);
  const runRoot = await realpath(
    await mkdtemp(
      join(
        options.tmpRoot ?? tmpdir(),
        `${FUSION_TMP_PREFIX}${randomBytes(3).toString("hex")}-`,
      ),
    ),
  );
  // Whose it is, so a later run's sweep can tell a dead run's leftovers
  // from a live one's.
  await writeFile(
    join(runRoot, OWNER_FILE),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  ).catch(() => undefined);
  let snapshot: GitSnapshot | null;
  try { snapshot = await gitSnapshot(real, git); }
  catch (err) { await removeWorkspaceTree(runRoot); throw err; }
  await sweepStaleBranchSets(dirname(runRoot), snapshot?.top, git);
  const roots: string[] = [];
  const workspaceRoots = new Map<string, string>();
  // Node's `rm` first (it removes a link, symlink or junction, without
  // following it), then git forgets the worktrees (`forgetRemovedWorktrees`).
  const cleanup = async (keep: readonly string[] = []): Promise<void> => {
    if (keep.length > 0) {
      const kept = new Set(
        keep.flatMap((id) => {
          const root = workspaceRoots.get(id);
          return root === undefined ? [] : [root];
        }),
      );
      const base = roots[0];
      const removed: string[] = [];
      for (const root of roots.splice(0)) {
        if (kept.has(root) || root === base) {
          roots.push(root);
          continue;
        }
        await removeWorkspaceTree(root).catch(() => undefined);
        removed.push(root);
      }
      if (snapshot !== null) await forgetRemovedWorktrees(cleanupGit, snapshot.top, removed);
      return;
    }
    await removeWorkspaceTree(runRoot).catch(() => undefined);
    if (snapshot !== null) await forgetRemovedWorktrees(cleanupGit, snapshot.top, [runRoot]);
  };
  const limit = options.maxCopyBytes ?? VERIFY_COPY_MAX_BYTES;
  const budget: PrivateCopyBudget = { left: limit, generatedDirectoryLinks: new Map(), dependencyBytes: { unlinked: 0, private: 0 }, ...(options.privateDependencyDirectories === true ? { privateIgnoredDirectories: true } : {}), ...(options.signal === undefined ? {} : { signal: options.signal }) };
  try {
    const method: BranchMethod = snapshot === null ? "copy" : "worktree";
    const make = async (name: string, source: string): Promise<string> => {
      const root = join(runRoot, name);
      roots.push(root);
      const dir = snapshot !== null ? await addWorktree(snapshot, source, root, git, budget) : root;
      if (snapshot === null) await copyPrivateEntry(source, root, budget);
      await matchDirectoryModes(source, dir, options.signal);
      return dir;
    };
    // Tasks copy what the base only links; the base itself stays link-only.
    // Without links its dependency directories are placeholders: the
    // tasks' own copies come from the original, so they are copied once.
    if (options.privateDependencyDirectories === true) budget.dependencyPlaceholders = true;
    const baseDir = await make("base", real);
    delete budget.dependencyPlaceholders;
    if (options.privateDependencyDirectories === true) {
      budget.privateDependenciesFrom = real;
      // A folder copy still needs the repository's bounds to refuse links into it.
      const top = snapshot?.top ?? await repositoryTop(real, git);
      if (top !== undefined) {
        budget.privateDependencyRepository = { top, rel: relative(top, real), worktree: snapshot !== null };
      }
    }
    const directoryIgnorePolicy = await createDirectoryIgnorePolicy({
      originalDir: real, baseDir, probeDir: join(runRoot, "ignore-policy"),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      copy: (from, to) => copyPrivateEntry(from, to, budget),
      ...(options.ignoreGit === undefined ? {} : { git: options.ignoreGit }),
    });
    const excludedDirectories = new Set(
      (snapshot?.ignored ?? [])
        .filter((path) => path.endsWith("/"))
        .map((path) => path.slice(0, -1).split("/").join(sep)),
    );
    const trackedPaths = new Set<string>();
    for (const path of snapshot?.tracked ?? []) {
      for (let rel = path.split("/").join(sep); rel !== "." && !trackedPaths.has(rel); rel = dirname(rel)) trackedPaths.add(rel);
    }
    const workspaces = new Map<string, BranchWorkspace>();
    for (const [index, taskId] of taskIds.entries()) {
      const name = workspaceName(index, taskId);
      workspaceRoots.set(taskId, join(runRoot, name));
      const dir = await make(name, baseDir);
      const ignoredManifest = new Map<string, FileStamp>();
      workspaces.set(taskId, {
        taskId,
        name,
        dir,
        manifest: await stampTree(dir, excludedDirectories, directoryIgnorePolicy, options.signal, trackedPaths, ignoredManifest),
        excludedDirectories,
        trackedPaths,
        ignoredManifest,
        ...(directoryIgnorePolicy === undefined ? {} : { directoryIgnorePolicy }),
      });
    }
    return { method, realDir: real, baseDir, workspaces, cleanup, retainForRecovery: () => writeFile(join(runRoot, OWNER_FILE), JSON.stringify({ pid: process.pid, recovery: true, createdAt: new Date().toISOString() })) };
  } catch (err) {
    await cleanup();
    if (err instanceof PrivateCopyLimitError) {
      options.onRefusal?.(copyLimitReason(budget, limit, err));
      return null;
    }
    throw err;
  }
}

/**
 * The paths (relative to the workspace's `dir`) a task added, changed or
 * removed, judged by size and mtime against its manifest. A file merely
 * touched is weeded out later by comparing bytes with the base.
 */
export async function touchedPaths(
  workspace: BranchWorkspace,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await workspaceTouches(workspace, signal)).touched;
}

function stampMoved(before: FileStamp | undefined, now: FileStamp): boolean {
  return (
    before === undefined ||
    before.size !== now.size ||
    before.mtimeMs !== now.mtimeMs ||
    before.link !== now.link ||
    before.mode !== now.mode
  );
}

/** Paths added, changed or removed relative to `before`, sorted. */
function movedPaths(before: ReadonlyMap<string, FileStamp>, now: ReadonlyMap<string, FileStamp>, signal?: AbortSignal): string[] {
  const out: string[] = [];
  for (const [rel, stamp] of now) {
    signal?.throwIfAborted();
    if (stampMoved(before.get(rel), stamp)) out.push(rel);
  }
  for (const rel of before.keys()) {
    signal?.throwIfAborted();
    if (!now.has(rel)) out.push(rel);
  }
  return out.sort();
}

/**
 * `touchedPaths`, plus `ignored`: files the task added, changed or
 * removed under a directory the frozen ignore rules classify as ignored
 * (one it created, say `src/generated/`), which are never merged.
 */
export async function workspaceTouches(
  workspace: BranchWorkspace,
  signal?: AbortSignal,
): Promise<{ touched: string[]; ignored: string[] }> {
  const dropped = new Map<string, FileStamp>();
  const now = await stampTree(workspace.dir, workspace.excludedDirectories, workspace.directoryIgnorePolicy, signal, workspace.trackedPaths, dropped);
  return {
    touched: movedPaths(workspace.manifest, now, signal),
    ignored: movedPaths(workspace.ignoredManifest ?? new Map(), dropped, signal),
  };
}

/**
 * One path as a merge or a patch sees it: a regular file's bytes and
 * exec bit, or a symlink's target (never followed). `null` for nothing
 * there, a directory, or what cannot be read.
 */
export interface PathEntry {
  data: Buffer;
  executable: boolean;
  /** Set for a symlink: its target, as written. */
  link?: string;
}

export async function readEntry(path: string): Promise<PathEntry | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      return { data: Buffer.from(link, "utf8"), executable: false, link };
    }
    if (!info.isFile()) return null;
    return { data: await readFile(path), executable: (info.mode & 0o111) !== 0 };
  } catch {
    return null;
  }
}

/** The same bytes, kind and exec bit (what git records). */
export function sameEntry(a: PathEntry | null, b: PathEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.data.equals(b.data) &&
    (a.link === undefined) === (b.link === undefined) &&
    a.executable === b.executable
  );
}
