import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isInside } from "../../approval/fanout-scope.js";
import { resolveUserPath } from "../os/expand-home.js";

export const MAX_CHECK_INPUTS = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

/** Exact literal files only. Unlike editable contract.inputs, a check input is immutable for this run. */
export function readCheckInputs(value: unknown, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CHECK_INPUTS) {
    problems.push(`contract.checkInputs must be an array of at most ${MAX_CHECK_INPUTS} literal file paths`);
    return undefined;
  }
  const paths: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > 4096 || /[*?[\]{}\0]/.test(item)) {
      problems.push(`contract.checkInputs[${index}] must be a literal file path without patterns (at most 4096 characters)`);
    } else if (!paths.includes(item.trim())) paths.push(item.trim());
  }
  return paths.length === 0 ? undefined : paths;
}

interface Stamp { sha256: string; mode: number }
export interface CheckInputSnapshot {
  readonly paths: readonly string[];
  /** Verify every declared file against the pre-worker original bytes, type and mode. */
  verify(root: string, signal: AbortSignal): Promise<number>;
}

export async function freezeCheckInputs(root: string, declarations: readonly string[], signal: AbortSignal): Promise<CheckInputSnapshot> {
  const problems: string[] = [];
  readCheckInputs([...declarations], problems);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const paths = [...new Set(declarations.map(path => {
    const absolute = resolveUserPath(path, root);
    if (!isInside(root, absolute) || absolute === root) throw new Error("check input must stay inside the original project");
    const rel = relative(root, absolute);
    if (rel.split(sep).some(component => component.includes(":"))) throw new Error("check input alternate streams are unsupported");
    return rel;
  }))];
  const scan = async (dir: string, stop: AbortSignal): Promise<Map<string, Stamp>> => {
    let left = MAX_BYTES;
    const entries = new Map<string, Stamp>();
    for (const path of paths) {
      stop.throwIfAborted();
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
        const info = await lstat(join(dir, parent));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("check input has a non-directory or linked ancestor");
      }
      const absolute = join(dir, path), before = await lstat(absolute);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("check input must be a regular file, never a symlink");
      if (before.size > MAX_FILE_BYTES || before.size > left) throw new Error("check input byte limit exceeded");
      const hash = createHash("sha256"); let bytes = 0;
      for await (const chunk of createReadStream(absolute, { signal: stop, highWaterMark: 64 * 1024 })) {
        bytes += (chunk as Buffer).length; left -= (chunk as Buffer).length;
        if (bytes > MAX_FILE_BYTES || left < 0) throw new Error("check input byte limit exceeded");
        hash.update(chunk);
      }
      const after = await lstat(absolute);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("check input changed during read");
      entries.set(path, { sha256: hash.digest("hex"), mode: after.mode & 0o777 });
    }
    return entries;
  };
  const original = await scan(root, signal);
  return { paths, async verify(dir, stop) {
    let current: Map<string, Stamp>;
    try { current = await scan(dir, stop); }
    catch (error) { throw new Error(`declared check input cannot be verified: ${error instanceof Error ? error.message : String(error)}`); }
    for (const [path, stamp] of original) {
      const now = current.get(path);
      if (now?.sha256 !== stamp.sha256 || now.mode !== stamp.mode) throw new Error(`declared check input changed: ${path.split(sep).join("/")}`);
    }
    return current.size;
  } };
}
