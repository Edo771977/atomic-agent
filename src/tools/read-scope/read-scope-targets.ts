/**
 * Which registered tools READ the filesystem, and which of their
 * arguments name what they read. Shared by the session read scope and
 * the narrower fusion-worker one (`read-scope.ts`).
 */

import { isAbsolute, join } from "node:path";
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
type LocalFileUrl = { path: string } | { error: string } | null;

function parseLocalFileUrl(url: string): LocalFileUrl {
  // WHATWG URL parsing removes HT/LF/CR, including inside a scheme.
  // Inspect the parsed protocol at every wrapper, rather than a raw
  // prefix that misses `view-\tsource:` while the browser accepts it.
  let rest = url.trim().replace(/[\t\r\n]/g, "");
  let parsed: URL;
  for (;;) {
    try {
      parsed = new URL(rest);
    } catch {
      return /^file:/i.test(rest) ? { error: "has an invalid local file URL" } : null;
    }
    if (parsed.protocol !== "view-source:") break;
    rest = parsed.pathname.trim();
  }
  if (parsed.protocol !== "file:") return null;
  try {
    const path = fileURLToPath(parsed);
    // Node permits NUL in the decoded string, but no filesystem API can
    // open it. Windows also forbids the remaining ASCII control bytes.
    if ((process.platform === "win32" ? /[\x00-\x1f]/ : /\x00/).test(path)) {
      return { error: "has an invalid local file path" };
    }
    return { path };
  } catch {
    // A drive-less Windows URL, foreign file host, invalid escape or
    // encoded separator cannot be checked as a native path. Never drop
    // its host/drive semantics and let a browser resolve it differently.
    return { error: "cannot be mapped to an absolute local path on this platform" };
  }
}

export function localFileOfUrl(url: string): string | null {
  const local = parseLocalFileUrl(url);
  return local !== null && "path" in local ? local.path : null;
}

/** A local URL the browser must refuse, rather than opening unchecked. */
export function invalidLocalFileUrlReason(url: string): string | null {
  const local = parseLocalFileUrl(url);
  return local !== null && "error" in local ? local.error : null;
}

/** URL reads share argument selection between validation and path extraction. */
const URL_READ_TARGETS: ReadonlyMap<string, (args: Record<string, unknown>) => string | undefined> = new Map([
  ["browser.navigate", (args) => nonEmpty(args.url)],
  ["browser.tabs", (args) => args.action === "new" ? nonEmpty(args.url) : undefined],
]);

/** Invalid local URLs must not become an empty, implicitly allowed target set. */
export function invalidReadUrlTarget(
  tool: string,
  args: Record<string, unknown>,
): { url: string; why: string } | null {
  const url = URL_READ_TARGETS.get(tool)?.(args);
  if (url === undefined) return null;
  const why = invalidLocalFileUrlReason(url);
  return why === null ? null : { url, why };
}

function gitRepoArg(pathKey?: "path" | "paths"): ReadTargetsOf {
  return (args) => {
    const targets: string[] = [];
    const repo = nonEmpty(args.repo);
    if (repo !== undefined) targets.push(repo);
    if (pathKey !== undefined) {
      const raw = args[pathKey];
      const paths = Array.isArray(raw) ? raw.map(nonEmpty) : [nonEmpty(raw)];
      // git runs in `repo` (or the working directory), so a relative
      // pathspec names a file under it: `../` climbs out like any read.
      for (const path of paths) {
        if (path === undefined) continue;
        targets.push(isAbsolute(path) || repo === undefined ? path : join(repo, path));
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
  // are resolved against that repository; an absolute one is checked as
  // is. A revision cannot smuggle in a path: the tools refuse one that
  // starts with `-` (`revisionArg` in git-runner.ts).
  ["os.git.status", gitRepoArg()],
  ["os.git.branch", gitRepoArg()],
  ["os.git.show", gitRepoArg()],
  ["os.git.log", gitRepoArg("path")],
  ["os.git.blame", gitRepoArg("path")],
  ["os.git.diff", gitRepoArg("paths")],
  // A file:// page (or its view-source:) reads that file into the
  // browser, and the page text comes back to the model.
  ...Array.from(URL_READ_TARGETS, ([name, urlOf]): [string, ReadTargetsOf] => [name, (args) => {
    const url = urlOf(args);
    const file = url === undefined ? null : localFileOfUrl(url);
    return file === null ? [] : [file];
  }]),
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
