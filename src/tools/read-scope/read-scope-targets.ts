/**
 * Which registered tools READ the filesystem, and which of their
 * arguments name what they read. Shared by the session read scope and
 * the narrower fusion-worker one (`read-scope.ts`).
 */

import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type ReadTargetsOf = (args: Record<string, unknown>) => string[];

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const pathArg: ReadTargetsOf = (args) => {
  const path = nonEmpty(args.path);
  return path === undefined ? [] : [path];
};

/**
 * The local file a browser URL opens (`file:///…`, also behind
 * `view-source:`), or `null` for any other URL. A browser page on a
 * local file is a read like `os.fs.read`.
 */
export function localFileOfUrl(url: string): string | null {
  let rest = url.trim();
  while (/^view-source:/i.test(rest)) rest = rest.slice("view-source:".length).trim();
  let parsed: URL;
  try {
    parsed = new URL(rest);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  try {
    return fileURLToPath(parsed);
  } catch {
    // A host the platform cannot map (`file://server/…` on POSIX): the
    // path part is still what a browser would try to open.
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      return parsed.pathname;
    }
  }
}

const browserUrlArg: ReadTargetsOf = (args) => {
  const url = nonEmpty(args.url);
  const file = url === undefined ? null : localFileOfUrl(url);
  return file === null ? [] : [file];
};

function gitRepoArg(pathKey?: "path" | "paths"): ReadTargetsOf {
  return (args) => {
    const targets: string[] = [];
    const repo = nonEmpty(args.repo);
    if (repo !== undefined) targets.push(repo);
    if (pathKey !== undefined) {
      const raw = args[pathKey];
      const paths = Array.isArray(raw) ? raw.map(nonEmpty) : [nonEmpty(raw)];
      for (const path of paths) {
        if (path !== undefined && isAbsolute(path)) targets.push(path);
      }
    }
    return targets;
  };
}

/**
 * The read-class filesystem tools and the argument(s) naming what they
 * read. A search tool's omitted root is the working directory, which is
 * inside by definition, so it contributes nothing to check.
 */
export const READ_TOOL_TARGETS: ReadonlyMap<string, ReadTargetsOf> = new Map<
  string,
  ReadTargetsOf
>([
  ["os.fs.read", pathArg],
  ["os.fs.list", pathArg],
  ["os.fs.hash", pathArg],
  ["os.fs.watch", pathArg],
  ["os.fs.read_document", pathArg],
  ["os.fs.archive.list", pathArg],
  ["os.fs.archive.read_entry", pathArg],
  ["os.fs.grep", pathArg],
  // A folder to map or one file to outline; omitted = the working dir.
  ["os.fs.code_map", pathArg],
  [
    "os.fs.glob",
    // `cwd` wins over `path` inside the tool; either names the root.
    (args) => {
      const root = nonEmpty(args.cwd) ?? nonEmpty(args.path);
      return root === undefined ? [] : [root];
    },
  ],
  [
    "os.fs.diff",
    (args) =>
      [nonEmpty(args.aPath), nonEmpty(args.bPath)].filter(
        (path): path is string => path !== undefined,
      ),
  ],
  [
    "vision.describe",
    (args) =>
      [
        nonEmpty(args.path),
        ...(Array.isArray(args.paths) ? args.paths.map(nonEmpty) : []),
      ].filter((path): path is string => path !== undefined),
  ],
  [
    // The first frame of an image-to-video clip: Core reads the file and
    // sends it to OpenRouter, so it is scoped like any read.
    "video.generate",
    (args) => {
      const image = nonEmpty(args.image);
      return image === undefined ? [] : [image];
    },
  ],
  [
    // Not a read, but a way to one: a file moved from outside the scope
    // into the working directory could then be read without asking. Its
    // sources are checked like reads; destinations are writes, which the
    // approval ladder classifies.
    "os.fs.move",
    (args) =>
      (Array.isArray(args.moves) ? args.moves : [args])
        .map((item: unknown) =>
          typeof item === "object" && item !== null
            ? nonEmpty((item as Record<string, unknown>).from)
            : undefined,
        )
        .filter((path): path is string => path !== undefined),
  ],
  // The git read tools print file contents and history of whatever
  // repository `repo` names (omitted = the working directory). Pathspecs
  // are relative to that repository; an absolute one is checked as is.
  ["os.git.status", gitRepoArg()],
  ["os.git.branch", gitRepoArg()],
  ["os.git.show", gitRepoArg()],
  ["os.git.log", gitRepoArg("path")],
  ["os.git.blame", gitRepoArg("path")],
  ["os.git.diff", gitRepoArg("paths")],
  // A file:// page (or its view-source:) reads that file into the
  // browser, and the page text comes back to the model.
  ["browser.navigate", browserUrlArg],
  [
    "browser.tabs",
    (args) => (args.action === "new" ? browserUrlArg(args) : []),
  ],
  [
    // A syntax check reads every file it is handed.
    "verify.syntax",
    (args) =>
      (Array.isArray(args.files) ? args.files.map(nonEmpty) : []).filter(
        (path): path is string => path !== undefined,
      ),
  ],
]);

/** The shell tool, checked by token rather than by a named argument. */
export const SHELL_TOOL = "os.shell.run";

/** Runs a command like the shell does, so its commands get the shell's checks. */
export const VERIFY_TOOL = "verify.run";

/**
 * The commands a `verify.run` call would start, in the shape the shell
 * checks read (`{cmd, args}`). Taken from the raw arguments, whatever
 * the `kind`, because this runs before the tool validates them.
 */
export function verifyRunShellCalls(
  args: Record<string, unknown>,
): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  if (typeof args.cmd === "string") calls.push({ cmd: args.cmd, args: args.args });
  const start = args.start;
  if (typeof start === "object" && start !== null) {
    const { cmd, args: startArgs } = start as Record<string, unknown>;
    if (typeof cmd === "string") calls.push({ cmd, args: startArgs });
  }
  return calls;
}

/** `https://…`, `data:…` — not a filesystem path, not this module's business. */
export const URL_LIKE = /^[a-z][a-z0-9+.-]*:(?:\/\/|[^\\/])/i;
