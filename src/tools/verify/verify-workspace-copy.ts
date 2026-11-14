/**
 * The throwaway copy `verify.run` works in.
 *
 * Verification executes things — test runners, servers, pages — and
 * what they write (caches, logs, a harness the model wrote to check its
 * own work) used to land in the deliverable. So a run happens in a copy
 * under the OS temp dir and the copy is deleted afterwards.
 *
 * macOS: `cp -c -R` (clonefile) — instant on APFS whatever the size, so
 * nothing is excluded. Elsewhere: a plain copy with `node_modules`,
 * `.git`, `dist`, `build`, `target`, `.venv` left out and symlinked into
 * the copy instead; a tree over the copy limit (those excluded; 2 GiB,
 * `tools.verify.maxCopyBytes`) is not copied at all — verification is
 * refused rather than run in the original.
 * On the copy path the symlinked `.git` is the real one: a command that
 * commits inside the copy commits for real.
 *
 * Windows: a directory symlink needs Developer Mode or the symlink
 * privilege. Refused (EPERM/EACCES), the excluded directory is linked
 * with a junction instead — same write semantics (writes through it
 * reach the original). A symlink inside the tree falls back the same way:
 * a directory link becomes a junction to the matching directory in the
 * copy when its target is inside the tree (writes stay in the copy), or
 * to the real target when it points outside (writes reach that target,
 * as with an excluded directory); a file link inside the tree becomes a
 * copy of its target, counted against the copy limit, and one pointing
 * outside the tree makes the workspace unavailable. With neither
 * available the workspace is unavailable and says how to fix it.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  stat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const VERIFY_COPY_EXCLUDED: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".venv",
]);

export const VERIFY_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface VerifyWorkspace {
  /** The copy's path. An unavailable workspace must never be executed. */
  readonly dir: string;
  readonly isolated: boolean;
  /** `in-place` is retained for legacy embedders; execution refuses it. */
  readonly method: "clonefile" | "copy" | "unavailable" | "in-place";
  readonly error?: string;
  cleanup(): Promise<void>;
}

export interface CreateWorkspaceOptions {
  platform?: NodeJS.Platform;
  tmpRoot?: string;
  maxBytes?: number;
  /** Test seam: the clone attempt. Resolves `true` when the clone is complete. */
  clone?: (src: string, dest: string) => Promise<boolean>;
  /** Test seam: `fs.promises.symlink` (to simulate a refused link). */
  symlink?: SymlinkFn;
  /** Test seam: `fs.promises.rm` for cleanup. */
  remove?: (path: string, options: { recursive: true; force: true; maxRetries: number; retryDelay: number }) => Promise<void>;
}

/**
 * Cleanup retries: on Windows a just-exited process, an antivirus scan or
 * an indexer can hold a file for a moment (EBUSY/EPERM/ENOTEMPTY); Node's
 * `rm` retries those with a linear backoff.
 */
const CLEANUP_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export type SymlinkFn = (target: string, path: string, type?: "dir" | "file" | "junction") => Promise<void>;

export interface CopyTreeOptions {
  platform?: NodeJS.Platform;
  symlink?: SymlinkFn;
  /** Bytes the copy may write (files and refused-link targets); unlimited when omitted. */
  maxBytes?: number;
}

function copyLimitError(limit: number): Error {
  return new Error(`workspace exceeds the ${limit}-byte copy limit (${[...VERIFY_COPY_EXCLUDED].join(", ")} not counted); raise \`tools.verify.maxCopyBytes\` in the config, or move large generated files into one of those directories`);
}

const LINK_REFUSED = new Set(["EPERM", "EACCES"]);

function isLinkRefused(err: unknown): boolean {
  return LINK_REFUSED.has((err as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function linkUnavailableError(path: string, platform: NodeJS.Platform, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const fix =
    platform === "win32"
      ? "enable Windows Developer Mode (or grant the symlink privilege), or work on an NTFS volume that supports links (junctions)"
      : "work on a filesystem that supports symbolic links";
  return new Error(`cannot link ${path} into the verification copy (${reason}); ${fix}`);
}

/** Link the directory `target` at `path`: a symlink, else (Windows) a junction. */
async function linkDirectory(target: string, path: string, platform: NodeJS.Platform, link: SymlinkFn): Promise<void> {
  try {
    await link(target, path, "dir");
    return;
  } catch (err) {
    if (!isLinkRefused(err)) throw err;
    if (platform !== "win32") throw linkUnavailableError(path, platform, err);
  }
  try {
    // A junction needs an absolute target and no privilege.
    await link(resolve(target), path, "junction");
  } catch (err) {
    throw linkUnavailableError(path, platform, err);
  }
}

function cloneWithCp(src: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("cp", ["-c", "-R", src, dest], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Byte size of the tree minus the excluded directories; stops early past `limit`. */
export async function measureTree(root: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!VERIFY_COPY_EXCLUDED.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(join(dir, entry.name))).size;
      } catch {
        // Vanished mid-walk; not worth failing a measurement over.
      }
      if (total > limit) return total;
    }
  }
  return total;
}

/**
 * Copy `src` into `dest` (which must not exist), symlinking the
 * excluded directories — at any depth — back to their originals.
 */
export async function copyTreeWithExclusions(src: string, dest: string, options: CopyTreeOptions = {}): Promise<void> {
  const context: CopyContext = {
    platform: options.platform ?? process.platform,
    link: options.symlink ?? symlink,
    srcRoot: resolve(src),
    destRoot: resolve(dest),
    budget: { limit: options.maxBytes ?? Number.POSITIVE_INFINITY, used: 0 },
  };
  await copyDirectory(src, dest, context);
}

interface CopyContext {
  readonly platform: NodeJS.Platform;
  readonly link: SymlinkFn;
  readonly srcRoot: string;
  readonly destRoot: string;
  readonly budget: { readonly limit: number; used: number };
}

/** Charge `bytes` against the copy limit before writing them. */
function charge(context: CopyContext, bytes: number): void {
  context.budget.used += bytes;
  if (context.budget.used > context.budget.limit) throw copyLimitError(context.budget.limit);
}

/** `absolute` relative to `root` when it lies inside it, else `undefined`. */
function insideTree(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute);
  if (rel === "") return rel;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

/**
 * A symlink the host refused to recreate (Windows without the symlink
 * privilege). A directory becomes a junction: to the matching path in
 * the copy when the target is inside the tree (so writes stay in the
 * copy), to the real target otherwise (like an excluded directory,
 * writes through it reach that target). A file inside the tree becomes
 * a copy of its target, charged against the copy limit (the measurement
 * skips links); a file outside the tree is refused rather than copied
 * out of a place the workspace does not own.
 */
async function recreateRefusedLink(from: string, to: string, target: string, context: CopyContext, cause: unknown): Promise<void> {
  const { platform, link } = context;
  const absolute = resolve(dirname(from), target);
  const info = await stat(absolute).catch(() => undefined);
  const rel = insideTree(context.srcRoot, absolute);
  if (info?.isDirectory()) {
    await linkDirectory(rel === undefined ? absolute : join(context.destRoot, rel), to, platform, link);
  } else if (info?.isFile()) {
    if (rel === undefined) throw outsideFileLinkError(to, target, platform, cause);
    charge(context, info.size);
    await copyFile(absolute, to);
  } else {
    throw linkUnavailableError(to, platform, cause);
  }
}

function outsideFileLinkError(path: string, target: string, platform: NodeJS.Platform, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`cannot recreate the file symlink ${path} -> ${target} in the verification copy (${reason}): its target is outside the workspace and is not copied; ${platform === "win32" ? "enable Windows Developer Mode (or grant the symlink privilege)" : "work on a filesystem that supports symbolic links"}, or replace the link with the file itself`);
}

async function copyDirectory(src: string, dest: string, context: CopyContext): Promise<void> {
  const { platform, link } = context;
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(from);
      try {
        await link(target, to);
      } catch (err) {
        if (!isLinkRefused(err) || platform !== "win32") throw err;
        await recreateRefusedLink(from, to, target, context, err);
      }
    } else if (entry.isDirectory()) {
      if (VERIFY_COPY_EXCLUDED.has(entry.name)) {
        await linkDirectory(from, to, platform, link);
      } else {
        await copyDirectory(from, to, context);
      }
    } else if (entry.isFile()) {
      const info = await lstat(from);
      charge(context, info.size);
      await copyFile(from, to);
      const mode = info.mode & 0o777;
      if (mode & 0o111) await chmod(to, mode);
    }
    // Sockets, FIFOs, devices: not part of a deliverable, skipped.
  }
}

/** Create a copy or report why it is unavailable; never fall back to in-place execution. */
export async function createVerifyWorkspace(
  workingDir: string,
  options: CreateWorkspaceOptions = {},
): Promise<VerifyWorkspace> {
  const platform = options.platform ?? process.platform;
  const dest = join(
    options.tmpRoot ?? tmpdir(),
    `atag-verify-${randomBytes(4).toString("hex")}`,
  );
  const remove = options.remove ?? rm;
  const cleanup = async (): Promise<void> => {
    try {
      await remove(dest, CLEANUP_RM_OPTIONS);
    } catch (err) {
      // A bad temp root can be a file: no destination was created there.
      if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
    }
  };
  if (platform === "darwin") {
    const cloned = await (options.clone ?? cloneWithCp)(workingDir, dest);
    if (cloned) return { dir: dest, isolated: true, method: "clonefile", cleanup };
    await cleanup();
  }
  const limit = options.maxBytes ?? VERIFY_COPY_MAX_BYTES;
  if ((await measureTree(workingDir, limit)) > limit) {
    return { dir: dest, isolated: false, method: "unavailable", error: copyLimitError(limit).message, cleanup };
  }
  try {
    await copyTreeWithExclusions(workingDir, dest, { platform, maxBytes: limit, ...(options.symlink === undefined ? {} : { symlink: options.symlink }) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await cleanup();
    } catch (cleanupErr) {
      // Keep the copy failure as the cause; the caller retries the cleanup
      // and reports it if the partial copy is still in the way.
      const cleanupReason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      return { dir: dest, isolated: false, method: "unavailable", error: `could not copy workspace: ${reason} (and could not remove the partial copy ${dest}: ${cleanupReason})`, cleanup };
    }
    return { dir: dest, isolated: false, method: "unavailable", error: `could not copy workspace: ${reason}`, cleanup: async () => {} };
  }
  return { dir: dest, isolated: true, method: "copy", cleanup };
}
