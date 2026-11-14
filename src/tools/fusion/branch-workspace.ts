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
 * Git metadata only: tracked paths are overlaid from the original's
 * actual bytes into the base, then from that frozen base into each
 * task, bypassing clean/smudge filters and Git's stat cache. Untracked files are
 * copied in; ignored directories and ignored files are copied privately
 * so a test run still finds them, except the shared dependency
 * directories (`node_modules`, `target`, `.venv`), which are normally symlinked
 * to the original's and cost no copy budget (with
 * `privateDependencyDirectories`, tasks copy them privately instead). A
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
 * Remove what a fusion run that died (a crash, a kill, a throw nobody
 * cleaned up after) left behind: its run roots under `tmpRoot` whose
 * owner process is gone, and the git worktrees `repoTop` still records
 * inside them. A root another live process owns is never touched.
 * Never throws.
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
    if (repoTop !== undefined) {
      const listed = await git(["worktree", "list", "--porcelain", "-z"], repoTop);
      if (ok(listed)) {
        for (const line of zList(listed.stdout)) {
          if (!line.startsWith("worktree ")) continue;
          const path = line.slice("worktree ".length);
          if (stale.some((root) => path === root || path.startsWith(`${root}${sep}`))) {
            await git(["worktree", "remove", "--force", path], repoTop).catch(() => null);
          }
        }
      }
    }
    for (const root of stale) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (repoTop !== undefined && stale.length > 0) {
      await git(["worktree", "prune"], repoTop).catch(() => null);
    }
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
   * original's. Candidate integration sets this: nothing may reach the
   * original before promotion. The base, which nobody writes to, still links.
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
 * rule: a tracked change there is a deliverable.
 */
export async function stampTree(
  root: string,
  excludedDirectories: ReadonlySet<string> = new Set(),
  directoryIgnorePolicy?: DirectoryIgnorePolicy,
  signal?: AbortSignal,
  trackedPaths: ReadonlySet<string> = new Set(),
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
        if (ignored.has(dir)) { out.delete(rel); break; }
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
  constructor() { super("the private workspace copies exceed the copy byte limit"); }
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
  /** Set while making a private-dependency set's base: unlinkable dependencies get an empty placeholder. */
  dependencyPlaceholders?: boolean;
  /** A dependency directory was copied because no link was possible. */
  dependencyCopied?: boolean;
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
  budget.dependencyCopied = true;
  await copyPrivateEntry(from, to, budget, rel, false);
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
      await copyPrivateEntry(origin, to, budget, rel, false);
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
    if (info.size > budget.left) throw new PrivateCopyLimitError();
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
 * Copy a user's symlink with its target. Inside a private dependency
 * copy (`budget.privateDependenciesFrom`), an absolute target inside the
 * original (npm workspaces on Windows, pnpm: `node_modules/@s/pkg` →
 * `<project>/packages/pkg`) is pointed at the same place in this
 * workspace instead, so a write through it stays private; relative
 * targets already resolve inside the copy, and targets outside the
 * original are kept. Where the host denies symlinks, a directory target
 * under a dependency directory becomes a junction to the same resolved
 * path; otherwise the copy fails, naming the link (it is never expanded
 * into a copy).
 */
async function recreateLink(from: string, to: string, budget: PrivateCopyBudget, rel: string): Promise<void> {
  let target = await readlink(from);
  const origin = budget.privateDependenciesFrom;
  if (origin !== undefined && isAbsolute(target) && underSharedDependencyDirectory(rel) && to.endsWith(`${sep}${rel}`)) {
    const inside = await insideRoot(target, origin);
    if (inside !== undefined) target = join(to.slice(0, to.length - rel.length - 1), inside);
  }
  let denied: unknown;
  try {
    await symlink(target, to);
    return;
  } catch (err) {
    if (!linkUnavailable(err)) throw err;
    denied = err;
  }
  budget.signal?.throwIfAborted();
  // Only under a dependency directory: never inventoried or merged, so a
  // junction's absolute link text cannot be mistaken for a change.
  if (underSharedDependencyDirectory(rel) && await stat(from).then((found) => found.isDirectory(), () => false)) {
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
    // Git lists ignored children (`node_modules/big/`) when a tracked
    // placeholder keeps the dependency directory itself unignored.
    await copyPrivateEntry(join(realDir, path), join(dir, path), budget, path, isDir && underSharedDependencyDirectory(path));
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
  catch (err) { await rm(runRoot, { recursive: true, force: true }); throw err; }
  await sweepStaleBranchSets(dirname(runRoot), snapshot?.top, git);
  const roots: string[] = [];
  const removeRoot = async (root: string): Promise<void> => {
    if (snapshot !== null) {
      await cleanupGit(["worktree", "remove", "--force", root], snapshot.top).catch(
        () => null,
      );
    }
  };
  const workspaceRoots = new Map<string, string>();
  const cleanup = async (keep: readonly string[] = []): Promise<void> => {
    if (keep.length > 0) {
      const kept = new Set(
        keep.flatMap((id) => {
          const root = workspaceRoots.get(id);
          return root === undefined ? [] : [root];
        }),
      );
      const base = roots[0];
      for (const root of roots.splice(0)) {
        if (kept.has(root) || root === base) {
          roots.push(root);
          continue;
        }
        await removeRoot(root);
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
      if (snapshot !== null) {
        await cleanupGit(["worktree", "prune"], snapshot.top).catch(() => null);
      }
      return;
    }
    for (const root of roots) await removeRoot(root);
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    if (snapshot !== null) {
      await cleanupGit(["worktree", "prune"], snapshot.top).catch(() => null);
    }
  };
  const limit = options.maxCopyBytes ?? VERIFY_COPY_MAX_BYTES;
  const budget: PrivateCopyBudget = { left: limit, generatedDirectoryLinks: new Map(), ...(options.signal === undefined ? {} : { signal: options.signal }) };
  try {
    const method: BranchMethod = snapshot === null ? "copy" : "worktree";
    const make = async (name: string, source: string): Promise<string> => {
      const root = join(runRoot, name);
      roots.push(root);
      if (snapshot !== null) return addWorktree(snapshot, source, root, git, budget);
      await copyPrivateEntry(source, root, budget);
      return root;
    };
    // Tasks copy what the base only links; the base itself stays link-only.
    // Without links its dependency directories are placeholders: the
    // tasks' own copies come from the original, so they are copied once.
    if (options.privateDependencyDirectories === true) budget.dependencyPlaceholders = true;
    const baseDir = await make("base", real);
    delete budget.dependencyPlaceholders;
    if (options.privateDependencyDirectories === true) budget.privateDependenciesFrom = real;
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
      workspaces.set(taskId, {
        taskId,
        name,
        dir,
        manifest: await stampTree(dir, excludedDirectories, directoryIgnorePolicy, options.signal, trackedPaths),
        excludedDirectories,
        trackedPaths,
        ...(directoryIgnorePolicy === undefined ? {} : { directoryIgnorePolicy }),
      });
    }
    return { method, realDir: real, baseDir, workspaces, cleanup, retainForRecovery: () => writeFile(join(runRoot, OWNER_FILE), JSON.stringify({ pid: process.pid, recovery: true, createdAt: new Date().toISOString() })) };
  } catch (err) {
    await cleanup();
    if (err instanceof PrivateCopyLimitError) {
      options.onRefusal?.(budget.dependencyCopied === true
        ? `dependency folders could not be linked on this system and copying them exceeds the copy limit (${limit} bytes)`
        : "the folder is too large to copy");
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
  const now = await stampTree(workspace.dir, workspace.excludedDirectories, workspace.directoryIgnorePolicy, signal, workspace.trackedPaths);
  const out: string[] = [];
  for (const [rel, stamp] of now) {
    signal?.throwIfAborted();
    const before = workspace.manifest.get(rel);
    if (
      before === undefined ||
      before.size !== stamp.size ||
      before.mtimeMs !== stamp.mtimeMs ||
      before.link !== stamp.link ||
      before.mode !== stamp.mode
    ) {
      out.push(rel);
    }
  }
  for (const rel of workspace.manifest.keys()) {
    signal?.throwIfAborted();
    if (!now.has(rel)) out.push(rel);
  }
  return out.sort();
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
