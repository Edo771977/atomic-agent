import { isAbsolute, relative, resolve } from "node:path";

import type { CompressedToolResult } from "../../compressor/result-compressor.js";

/**
 * What a worker's file tools did to one path, from the runtime's own
 * record of the calls (`tool_call_executed`), never from the reply.
 *
 * The orchestrator used to learn which files a task touched from the
 * worker's prose, up to 4,000 chars of it per row, and then re-read the
 * files to check. The tools already know: a write says whether the file
 * existed and how many lines it had, an edit or a patch what it added
 * and removed, a move where the file went. One line per row built from
 * that is cheaper to read and does not depend on the worker reporting
 * it, or reporting it truthfully.
 */
export interface FileChange {
  /** Relative to the worker's working directory when inside it, else absolute. */
  path: string;
  kind: "new" | "modified" | "restored" | "trashed";
  /** Absent when no call said (a replace of a file too large to read). */
  addedLines?: number;
  removedLines?: number;
  /** Where the file was before an `os.fs.move`, displayed like `path`. */
  movedFrom?: string;
}

/** How many paths a `changed:` line names before "+N more". */
export const CHANGED_PATHS_SHOWN = 12;

/**
 * Tools that can write files the file tools never report: a shell
 * command, an archive extraction, a skill's script, a checkout.
 * `verify.run` works in a throwaway copy and counts only when its
 * result says it ran in place (`isolated: false`).
 */
export const UNTRACKED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "os.shell.run",
  "os.fs.archive.extract",
  "skill.run_script",
  "os.git.checkout",
]);

/** The `changed:` line's label once a shell command ran. */
const SHELL_RAN_LABEL = "changed (file tools only; shell commands ran)";

interface Entry {
  kind: FileChange["kind"];
  added: number | undefined;
  removed: number | undefined;
  movedFrom?: string;
}

/**
 * Accumulates one worker's file changes, path by path, in first-touch
 * order. Only successful calls count; a patch counts the files it
 * applied. Shell commands can change files too and are not seen here:
 * the line says what the file tools did, marks itself when such a
 * command ran (`shellRan`), and the declared-file check on disk and the
 * syntax pass over the declared files still cover the rest.
 */
export class FileChangeLog {
  private readonly entries = new Map<string, Entry>();
  private untracked = false;

  constructor(private readonly workingDir?: string) {}

  /** Whether a tool that can write outside the file tools ran. */
  shellRan(): boolean {
    return this.untracked;
  }

  observe(result: CompressedToolResult): void {
    if (ranUntrackedWriter(result)) this.untracked = true;
    if (result.status !== "ok") return;
    const d = result.details;
    switch (result.tool) {
      case "os.fs.write": {
        const path = stringOf(d.path);
        if (path === undefined) return;
        this.touch(path, d.existed === false ? "new" : "modified", d);
        return;
      }
      case "os.fs.edit": {
        const path = stringOf(d.path);
        if (path !== undefined) this.touch(path, "modified", d);
        return;
      }
      case "os.fs.patch": {
        if (d.mode !== "applied" || !Array.isArray(d.files)) return;
        for (const raw of d.files) {
          if (!raw || typeof raw !== "object") continue;
          const file = raw as Record<string, unknown>;
          const path = stringOf(file.absolute) ?? stringOf(file.path);
          if (file.applied !== true || path === undefined) continue;
          this.touch(path, "modified", file);
        }
        return;
      }
      case "os.fs.restore": {
        const path = stringOf(d.path);
        if (path === undefined) return;
        const key = this.key(path);
        const prior = this.entries.get(key);
        this.entries.set(key, {
          kind: "restored",
          added: undefined,
          removed: undefined,
          ...(prior?.movedFrom === undefined ? {} : { movedFrom: prior.movedFrom }),
        });
        return;
      }
      case "os.fs.move": {
        if (!Array.isArray(d.moves)) return;
        for (const raw of d.moves) {
          if (!raw || typeof raw !== "object") continue;
          const from = stringOf((raw as Record<string, unknown>).from);
          const to = stringOf((raw as Record<string, unknown>).to);
          if (from === undefined || to === undefined) continue;
          const fromKey = this.key(from);
          const prior = this.entries.get(fromKey);
          this.entries.delete(fromKey);
          // A file this worker created and then renamed is still new;
          // one it found and moved keeps where it came from.
          this.entries.set(this.key(to), {
            kind: prior?.kind ?? "modified",
            added: prior?.added ?? 0,
            removed: prior?.removed ?? 0,
            ...(prior?.kind === "new"
              ? {}
              : { movedFrom: prior?.movedFrom ?? fromKey }),
          });
        }
        return;
      }
      case "os.fs.trash": {
        const paths = Array.isArray(d.paths) ? d.paths : [d.path];
        for (const raw of paths) {
          const path = stringOf(raw);
          if (path === undefined) continue;
          const key = this.key(path);
          // Created and thrown away: nothing changed on that path.
          if (this.entries.get(key)?.kind === "new") this.entries.delete(key);
          else this.entries.set(key, { kind: "trashed", added: undefined, removed: undefined });
        }
        return;
      }
      default:
        return;
    }
  }

  list(): FileChange[] {
    return [...this.entries].map(([path, e]) => ({
      path,
      kind: e.kind,
      ...(e.added === undefined ? {} : { addedLines: e.added }),
      ...(e.removed === undefined ? {} : { removedLines: e.removed }),
      ...(e.movedFrom === undefined ? {} : { movedFrom: e.movedFrom }),
    }));
  }

  private touch(path: string, kind: "new" | "modified", d: Record<string, unknown>): void {
    const key = this.key(path);
    const added = numberOf(d.addedLines);
    const removed = numberOf(d.removedLines);
    const prior = this.entries.get(key);
    if (prior === undefined || prior.kind === "trashed") {
      this.entries.set(key, { kind, added, removed });
      return;
    }
    // Counts add up while every call reported one; one call that could
    // not say makes the total unknown rather than an undercount.
    this.entries.set(key, {
      kind: prior.kind === "new" ? "new" : "modified",
      added: prior.added === undefined || added === undefined ? undefined : prior.added + added,
      removed: prior.removed === undefined || removed === undefined ? undefined : prior.removed + removed,
      ...(prior.movedFrom === undefined ? {} : { movedFrom: prior.movedFrom }),
    });
  }

  private key(path: string): string {
    if (this.workingDir === undefined) return path;
    const absolute = isAbsolute(path) ? path : resolve(this.workingDir, path);
    const rel = relative(this.workingDir, absolute);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
  }
}

/**
 * A call that may have written files on its own: one of
 * `UNTRACKED_WRITE_TOOLS` that ran (a shell command that exited, even
 * non-zero, or was detached; not one the guard or the parser refused),
 * or a `verify.run` that ran in place.
 */
function ranUntrackedWriter(result: CompressedToolResult): boolean {
  const d = result.details;
  if (result.tool === "verify.run") return d.isolated === false;
  if (!UNTRACKED_WRITE_TOOLS.has(result.tool)) return false;
  if (result.status === "ok") return true;
  return result.tool === "os.shell.run" && ("exitCode" in d || d.detached === true);
}

/** Two rows' changes as one (a split task's parent and its children). */
export function mergeFileChanges(
  lists: readonly (readonly FileChange[] | undefined)[],
): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const list of lists) {
    for (const change of list ?? []) byPath.set(change.path, change);
  }
  return [...byPath.values()];
}

/** `a.ts (+40/-3)`, `b.ts (new, +12)`, `c.ts (moved from d.ts)`. */
function describeChange(change: FileChange): string {
  const delta =
    change.addedLines === undefined || change.removedLines === undefined
      ? undefined
      : `+${change.addedLines}/-${change.removedLines}`;
  const parts: string[] = [];
  if (change.kind === "new") {
    parts.push(change.addedLines === undefined ? "new" : `new, +${change.addedLines}`);
  } else if (change.kind === "restored") {
    parts.push("restored");
  } else if (change.kind === "trashed") {
    parts.push("trashed");
  } else if (delta !== undefined) {
    if (delta !== "+0/-0" || change.movedFrom === undefined) parts.push(delta);
  } else {
    parts.push("rewritten");
  }
  if (change.movedFrom !== undefined) parts.push(`moved from ${change.movedFrom}`);
  return `${change.path} (${parts.join(", ")})`;
}

/**
 * The row's `changed:` line, written by the runtime from the tool
 * calls: at most `CHANGED_PATHS_SHOWN` paths, then "+N more". Labelled
 * `changed (file tools only; shell commands ran):` when `shellRan`, so
 * the list does not read as complete. `null` when the file tools
 * changed nothing and no shell command ran.
 */
export function describeChanges(
  changes: readonly FileChange[] | undefined,
  options: { shown?: number; shellRan?: boolean } = {},
): string | null {
  const label = options.shellRan === true ? SHELL_RAN_LABEL : "changed";
  if (changes === undefined || changes.length === 0) {
    return options.shellRan === true ? `${label}: nothing by the file tools` : null;
  }
  const listed = changes.slice(0, options.shown ?? CHANGED_PATHS_SHOWN).map(describeChange);
  const more = changes.length - listed.length;
  return `${label}: ${listed.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
}

/** The changed paths that should be on disk now (not trashed). */
export function presentChangedPaths(
  changes: readonly FileChange[] | undefined,
): string[] {
  return (changes ?? []).filter((c) => c.kind !== "trashed").map((c) => c.path);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
