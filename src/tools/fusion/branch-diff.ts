/**
 * What an isolated task changed, as a unified diff against the snapshot
 * its workspace started from (branch isolation, ATO-946).
 *
 * Two readers: a task held back from the merge (`branch-merge.ts`) is
 * kept as a patch file under `.atomic-agent/fusion-merge/`, for the
 * orchestrator to re-delegate from or the person to inspect; and the
 * judge (`judge.ts`) reads the task's changes instead of the first
 * characters of each declared file.
 *
 * The saved patch must carry everything, because the workspace is
 * removed once it is written: with git on the machine it is made by git
 * itself (`git diff-tree --binary` between two throwaway trees of the
 * touched paths, base side and task side, hashed with `--no-filters`),
 * so binary files, empty files, removals, exec-bit changes and symlinks
 * all `git apply`. Without git, the patch has the text changes and
 * everything a text patch cannot carry is copied into a folder next to
 * it, and the note says so.
 */
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { runCommand, type CommandResult } from "../../sandbox/command-runner.js";
import { buildCommandEnv } from "../../sandbox/command-env.js";
import {
  BRANCH_MERGE_DIR,
  ensureMergeDir,
  FUSION_TMP_PREFIX,
  readEntry,
  sameEntry,
  touchedPaths,
  type BranchSet,
  type BranchWorkspace,
  type PathEntry,
} from "./branch-workspace.js";

export type WorkspaceChangeKind = "added" | "modified" | "removed" | "binary" | "special";

export interface WorkspaceChange {
  /** Relative to the workspace's `dir`, `/`-separated. */
  path: string;
  kind: WorkspaceChangeKind;
  /**
   * The unified diff for this path (`a/` and `b/` prefixes), or a
   * one-line note for a binary, a symlink or a mode change.
   */
  patch: string;
  /** An added text file's content: the judge reads it as a file head. */
  content?: string;
  /** The diff could not be computed in time: only a note. */
  notComputed?: true;
}

/** Lines of context around each hunk. */
export const DIFF_CONTEXT_LINES = 3;
/** A file pair the diff cannot finish in this long gets a note, not a hunk. */
const DIFF_TIMEOUT_MS = 2_000;

function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

function slash(rel: string): string {
  return rel.split(sep).join("/");
}

function describeSpecial(path: string, base: PathEntry | null, task: PathEntry | null): string {
  const side = (e: PathEntry | null): string =>
    e === null
      ? "nothing"
      : e.link !== undefined
        ? `a symlink to ${e.link}`
        : `a${e.executable ? "n executable" : ""} file`;
  return `${path}: ${side(base)} → ${side(task)}\n`;
}

/**
 * Every path the task added, changed or removed, with its diff. A file
 * touched but left byte-identical (same exec bit) is not a change.
 */
export async function workspaceChanges(
  set: Pick<BranchSet, "baseDir">,
  workspace: BranchWorkspace,
  context: number = DIFF_CONTEXT_LINES,
  signal?: AbortSignal,
): Promise<WorkspaceChange[]> {
  const out: WorkspaceChange[] = [];
  for (const rel of await touchedPaths(workspace, signal)) {
    signal?.throwIfAborted();
    const [base, task] = await Promise.all([
      readEntry(join(set.baseDir, rel)),
      readEntry(join(workspace.dir, rel)),
    ]);
    signal?.throwIfAborted();
    if (base === null && task === null) continue;
    if (sameEntry(base, task)) continue;
    const path = slash(rel);
    if (
      base?.link !== undefined ||
      task?.link !== undefined ||
      (base !== null && task !== null && base.data.equals(task.data))
    ) {
      out.push({ path, kind: "special", patch: describeSpecial(path, base, task) });
      continue;
    }
    if ((base !== null && !isText(base.data)) || (task !== null && !isText(task.data))) {
      out.push({
        path,
        kind: "binary",
        patch: `Binary files ${base === null ? "/dev/null" : `a/${path}`} and ${task === null ? "/dev/null" : `b/${path}`} differ\n`,
      });
      continue;
    }
    const before = base?.data.toString("utf8") ?? "";
    const after = task?.data.toString("utf8") ?? "";
    const kind: WorkspaceChangeKind =
      base === null ? "added" : task === null ? "removed" : "modified";
    const patch = createTwoFilesPatch(
      base === null ? "/dev/null" : `a/${path}`,
      task === null ? "/dev/null" : `b/${path}`,
      before,
      after,
      undefined,
      undefined,
      { context, headerOptions: FILE_HEADERS_ONLY, timeout: DIFF_TIMEOUT_MS },
    );
    out.push({
      path,
      kind,
      patch:
        patch ??
        `--- a/${path}\n+++ b/${path}\n[diff not computed: the change is too large to compare]\n`,
      ...(patch === undefined ? { notComputed: true as const } : {}),
      ...(kind === "added" ? { content: after } : {}),
    });
  }
  return out;
}

/** Whether a text patch carries this change in full (`git apply` / `patch`). */
function textApplies(change: WorkspaceChange): boolean {
  if (change.kind === "binary" || change.kind === "special") return false;
  if (change.notComputed === true) return false;
  // An empty new file has no hunk: a text patch cannot create it.
  return !(change.kind === "added" && (change.content ?? "").length === 0);
}

/** The text changes as one patch file. */
export function renderPatch(changes: readonly WorkspaceChange[]): string {
  return changes
    .filter(textApplies)
    .map((c) => (c.patch.endsWith("\n") ? c.patch : `${c.patch}\n`))
    .join("");
}

/**
 * `.atomic-agent/fusion-merge/<task>-<hash>.patch`, relative to the
 * working directory: the id made path-safe, plus a short hash of the
 * id itself, so two ids that sanitise alike (`a/b`, `a_b`) never share
 * a patch.
 */
export function taskPatchPath(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  const hash = createHash("sha256").update(taskId).digest("hex").slice(0, 6);
  return join(BRANCH_MERGE_DIR, `${safe}-${hash}.patch`);
}

/** The folder of whole files saved beside a text-only patch. */
function taskFilesPath(patchRel: string): string {
  return `${patchRel.slice(0, -".patch".length)}.files`;
}

/**
 * A task that merged green after an earlier attempt was held back: its
 * old patch (and saved files) no longer describe anything. Never throws.
 */
export async function removeTaskPatch(realDir: string, taskId: string): Promise<void> {
  const rel = taskPatchPath(taskId);
  await rm(join(realDir, rel), { force: true }).catch(() => undefined);
  await rm(join(realDir, taskFilesPath(rel)), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/** Runs git for the patch; resolves `null` when git is not there to run. */
export type PatchGit = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; input?: string; signal?: AbortSignal },
) => Promise<CommandResult | null>;

const PATCH_GIT_TIMEOUT_MS = 120_000;
const PATCH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Git with none of the person's config (no filters, no diff drivers, no
 * `diff.noprefix`), no hooks, no prompt and none of the agent's keys.
 */
export const defaultPatchGit: PatchGit = async (args, options) => {
  options.signal?.throwIfAborted();
  try {
    return await runCommand("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: options.cwd,
      env: {
        ...buildCommandEnv(process.env),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_PAGER: "",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        ...options.env,
      },
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: PATCH_GIT_TIMEOUT_MS,
      maxOutputBytes: PATCH_MAX_BYTES,
    });
  } catch {
    return null;
  }
};

function ran(result: CommandResult | null): result is CommandResult {
  return result !== null && result.exitCode === 0 && !result.timedOut && !result.truncated;
}

/**
 * The binary patch from `baseDir` to `taskDir` over `paths` (relative,
 * OS separators), made by git in a throwaway object store; `null` when
 * git cannot make it.
 */
export async function gitBinaryPatch(
  baseDir: string,
  taskDir: string,
  paths: readonly string[],
  git: PatchGit = defaultPatchGit,
  tmpRoot: string = tmpdir(),
  signal?: AbortSignal,
): Promise<string | null> {
  const rawGit = git;
  git = async (args, options) => {
    signal?.throwIfAborted();
    const result = await rawGit(args, { ...options, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    return result;
  };
  signal?.throwIfAborted();
  const store = await mkdtemp(join(tmpRoot, `${FUSION_TMP_PREFIX}patch-`));
  try {
    const gitDir = join(store, "objects.git");
    if (!ran(await git(["init", "-q", "--bare", gitDir], { cwd: store, env: {} }))) return null;
    let links = 0;
    const tree = async (root: string, name: string): Promise<string | null> => {
      const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: join(store, `index-${name}`) };
      const entries: Array<{ mode: string; file: string; path: string }> = [];
      for (const rel of paths) {
        signal?.throwIfAborted();
        const entry = await readEntry(join(root, rel));
        if (entry === null) continue;
        let file = join(root, rel);
        if (entry.link !== undefined) {
          // Hash the link's target text, as git stores a symlink.
          file = join(store, `link-${(links += 1)}`);
          await writeFile(file, entry.link);
        }
        entries.push({
          mode: entry.link !== undefined ? "120000" : entry.executable ? "100755" : "100644",
          file,
          path: slash(rel),
        });
      }
      const lines: string[] = [];
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        const hashed = await git(
          ["hash-object", "-w", "--no-filters", "--", ...chunk.map((e) => e.file)],
          { cwd: store, env },
        );
        if (!ran(hashed)) return null;
        const shas = hashed.stdout.trim().split("\n");
        if (shas.length !== chunk.length) return null;
        chunk.forEach((e, j) => lines.push(`${e.mode} ${shas[j]}\t${e.path}\0`));
      }
      if (lines.length > 0) {
        const indexed = await git(["update-index", "-z", "--index-info"], {
          cwd: store,
          env,
          input: lines.join(""),
        });
        if (!ran(indexed)) return null;
      }
      const written = await git(["write-tree"], { cwd: store, env });
      return ran(written) ? written.stdout.trim() : null;
    };
    const before = await tree(baseDir, "base");
    const after = before === null ? null : await tree(taskDir, "task");
    if (before === null || after === null) return null;
    const diff = await git(
      [
        "diff-tree",
        "-r",
        "-p",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `-U${DIFF_CONTEXT_LINES}`,
        before,
        after,
      ],
      { cwd: store, env: { GIT_DIR: gitDir } },
    );
    return ran(diff) ? diff.stdout : null;
  } finally {
    await rm(store, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface SavedTaskPatch {
  /** The patch, relative to the working directory. */
  path: string;
  /** `git`: the patch carries every change; `text`: text changes only. */
  method: "git" | "text";
  /** With `text`: where the rest was copied, relative to the working directory. */
  filesDir?: string;
  /** How many paths were copied there. */
  saved?: number;
}

/**
 * Save a held-back task's changes into the working directory, as a
 * patch that `git apply` takes on the folder (paths relative to the
 * working directory). A later attempt of the same task replaces it.
 */
export async function writeTaskPatch(input: {
  realDir: string;
  set: Pick<BranchSet, "baseDir">;
  workspace: BranchWorkspace;
  taskId: string;
  changes: readonly WorkspaceChange[];
  patchGit?: PatchGit;
  tmpRoot?: string;
  signal?: AbortSignal;
}): Promise<SavedTaskPatch> {
  input.signal?.throwIfAborted();
  const rel = taskPatchPath(input.taskId);
  const at = join(input.realDir, rel);
  const filesRel = taskFilesPath(rel);
  const filesAt = join(input.realDir, filesRel);
  await ensureMergeDir(input.realDir);
  // An earlier attempt's copies are not this attempt's.
  await rm(filesAt, { recursive: true, force: true });
  const paths = await touchedPaths(input.workspace, input.signal);
  const binary = await gitBinaryPatch(
    input.set.baseDir,
    input.workspace.dir,
    paths,
    input.patchGit,
    input.tmpRoot,
    input.signal,
  );
  input.signal?.throwIfAborted();
  if (binary !== null) {
    await writeFile(at, binary);
    return { path: rel, method: "git" };
  }
  await writeFile(at, renderPatch(input.changes));
  const rest = input.changes.filter((c) => !textApplies(c));
  let saved = 0;
  const removed: string[] = [];
  for (const change of rest) {
    input.signal?.throwIfAborted();
    const from = join(input.workspace.dir, ...change.path.split("/"));
    const entry = await readEntry(from);
    if (entry === null) {
      removed.push(change.path);
      continue;
    }
    const to = join(filesAt, ...change.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    if (entry.link !== undefined) await symlink(entry.link, to);
    else {
      await copyFile(from, to);
      if (entry.executable) await chmod(to, 0o755).catch(() => undefined);
    }
    saved += 1;
  }
  if (removed.length > 0) {
    await mkdir(filesAt, { recursive: true });
    await writeFile(join(filesAt, "REMOVED.txt"), `${removed.join("\n")}\n`);
  }
  if (saved === 0 && removed.length === 0) return { path: rel, method: "text" };
  return { path: rel, method: "text", filesDir: filesRel, saved: saved + removed.length };
}
