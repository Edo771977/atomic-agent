/**
 * What an isolated task changed, as a unified diff against the snapshot
 * its workspace started from (branch isolation, ATO-946).
 *
 * Two readers: a task held back from the merge (`branch-merge.ts`) is
 * kept as a patch file under `.atomic-agent/fusion-merge/`, for the
 * orchestrator to re-delegate from or the person to inspect; and the
 * judge (`judge.ts`) reads the task's changes instead of the first
 * characters of each declared file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import {
  BRANCH_MERGE_DIR,
  touchedPaths,
  type BranchSet,
  type BranchWorkspace,
} from "./branch-workspace.js";

export type WorkspaceChangeKind = "added" | "modified" | "removed" | "binary";

export interface WorkspaceChange {
  /** Relative to the workspace's `dir`, `/`-separated. */
  path: string;
  kind: WorkspaceChangeKind;
  /** The unified diff for this path (`a/` and `b/` prefixes), or a one-line note for a binary. */
  patch: string;
  /** An added text file's content: the judge reads it as a file head. */
  content?: string;
}

/** Lines of context around each hunk. */
export const DIFF_CONTEXT_LINES = 3;
/** A file pair the diff cannot finish in this long gets a note, not a hunk. */
const DIFF_TIMEOUT_MS = 2_000;

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

function slash(rel: string): string {
  return rel.split(sep).join("/");
}

/**
 * Every path the task added, changed or removed, with its diff. A file
 * touched but left byte-identical is not a change.
 */
export async function workspaceChanges(
  set: Pick<BranchSet, "baseDir">,
  workspace: BranchWorkspace,
  context: number = DIFF_CONTEXT_LINES,
): Promise<WorkspaceChange[]> {
  const out: WorkspaceChange[] = [];
  for (const rel of await touchedPaths(workspace)) {
    const [base, task] = await Promise.all([
      readOrNull(join(set.baseDir, rel)),
      readOrNull(join(workspace.dir, rel)),
    ]);
    if (base === null && task === null) continue;
    if (base !== null && task !== null && base.equals(task)) continue;
    const path = slash(rel);
    if ((base !== null && !isText(base)) || (task !== null && !isText(task))) {
      out.push({
        path,
        kind: "binary",
        patch: `Binary files ${base === null ? "/dev/null" : `a/${path}`} and ${task === null ? "/dev/null" : `b/${path}`} differ\n`,
      });
      continue;
    }
    const before = base?.toString("utf8") ?? "";
    const after = task?.toString("utf8") ?? "";
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
      ...(kind === "added" ? { content: after } : {}),
    });
  }
  return out;
}

/** The changes as one patch file (`git apply` takes the text hunks). */
export function renderPatch(changes: readonly WorkspaceChange[]): string {
  return changes.map((c) => (c.patch.endsWith("\n") ? c.patch : `${c.patch}\n`)).join("");
}

/** `.atomic-agent/fusion-merge/<task>.patch`, relative to the working directory. */
export function taskPatchPath(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return join(BRANCH_MERGE_DIR, `${safe}.patch`);
}

/**
 * Save a held-back task's changes into the working directory. Returns
 * the path relative to it; a later attempt of the same task replaces
 * its patch.
 */
export async function saveTaskPatch(
  realDir: string,
  taskId: string,
  patch: string,
): Promise<string> {
  const rel = taskPatchPath(taskId);
  const at = join(realDir, rel);
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, patch);
  return rel;
}
