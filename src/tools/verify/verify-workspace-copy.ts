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
 * the copy instead; a tree over 2 GB (those excluded) is not copied at
 * all — verification is refused rather than run in the original.
 * On the copy path the symlinked `.git` is the real one: a command that
 * commits inside the copy commits for real.
 *
 * Windows: a directory symlink needs Developer Mode or the symlink
 * privilege. Refused (EPERM/EACCES), the excluded directory is linked
 * with a junction instead — same write semantics (writes through it
 * reach the original). A symlink inside the tree falls back the same way
 * (junction for a directory, a copy of the target for a file). With
 * neither available the workspace is unavailable and says how to fix it.
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
import { dirname, join, resolve } from "node:path";

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
}

export type SymlinkFn = (target: string, path: string, type?: "dir" | "file" | "junction") => Promise<void>;

export interface CopyTreeOptions {
  platform?: NodeJS.Platform;
  symlink?: SymlinkFn;
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
  const platform = options.platform ?? process.platform;
  const link = options.symlink ?? symlink;
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
        const absolute = resolve(dirname(from), target);
        const info = await stat(absolute).catch(() => undefined);
        if (info?.isDirectory()) await linkDirectory(absolute, to, platform, link);
        else if (info?.isFile()) await copyFile(absolute, to);
        else throw linkUnavailableError(to, platform, err);
      }
    } else if (entry.isDirectory()) {
      if (VERIFY_COPY_EXCLUDED.has(entry.name)) {
        await linkDirectory(from, to, platform, link);
      } else {
        await copyTreeWithExclusions(from, to, options);
      }
    } else if (entry.isFile()) {
      await copyFile(from, to);
      const mode = (await lstat(from)).mode & 0o777;
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
  const cleanup = async (): Promise<void> => {
    try {
      await rm(dest, { recursive: true, force: true });
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
    return { dir: dest, isolated: false, method: "unavailable", error: `workspace exceeds the ${limit}-byte copy limit`, cleanup };
  }
  try {
    await copyTreeWithExclusions(workingDir, dest, { platform, ...(options.symlink === undefined ? {} : { symlink: options.symlink }) });
  } catch (err) {
    await cleanup();
    const reason = err instanceof Error ? err.message : String(err);
    return { dir: dest, isolated: false, method: "unavailable", error: `could not copy workspace: ${reason}`, cleanup: async () => {} };
  }
  return { dir: dest, isolated: true, method: "copy", cleanup };
}
