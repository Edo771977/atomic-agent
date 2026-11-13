import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/**
 * Durability halves of a tmp-file-then-rename write. A rename is atomic,
 * but without an fsync of the tmp file first a power loss can leave the
 * new name pointing at a file whose data never reached the disk (an empty
 * `config.json` or `.env` after reboot); without an fsync of the directory
 * afterwards the rename itself may not survive.
 */

/**
 * fsync answers for a file system that cannot flush (some network, FUSE
 * and virtual file systems). The data is written; durability is just not
 * on offer there, so the write goes ahead rather than failing every save.
 */
const FSYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * Create `path` with `payload` and flush it to disk before returning.
 * `flag` is the open flag (`"w"` or `"wx"`); `mode` applies on creation.
 *
 * `path` is a tmp file the caller owns. If anything fails once it has
 * been created (a write, an fsync error other than "not supported", the
 * close), it is closed and unlinked before the error is rethrown: the
 * payload is often secrets (`.env`, `config.json`), and a stray
 * `.tmp-<pid>` file would keep them on disk.
 */
export function writeFileSyncedSync(
  path: string,
  payload: string,
  options: { mode: number; flag?: "w" | "wx" },
): void {
  const fd = openSync(path, options.flag ?? "w", options.mode);
  let open = true;
  try {
    const data = Buffer.from(payload, "utf8");
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    try {
      fsyncSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !FSYNC_UNSUPPORTED_CODES.has(code)) throw err;
    }
    open = false;
    closeSync(fd);
  } catch (err) {
    if (open) {
      try {
        closeSync(fd);
      } catch {
        // already failing; the unlink below matters more
      }
    }
    try {
      unlinkSync(path);
    } catch {
      // best effort: nothing more to do with a tmp file we cannot remove
    }
    throw err;
  }
}

/**
 * Windows: replacing a file another process holds open (antivirus, a
 * sync client, an editor, another reader of the map) fails with
 * EPERM/EBUSY/EACCES for a few milliseconds. Elsewhere these codes are
 * real errors and fail at once.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_BACKOFF_MS: readonly number[] = [10, 30, 60, 90];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RenameRetryDeps {
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => void;
}

/**
 * `renameSync`, retried on win32 for transient sharing locks: up to
 * five attempts, ~190ms of backoff in total. Throws the last error.
 */
export function renameWithRetrySync(
  from: string,
  to: string,
  deps: RenameRetryDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = RENAME_BACKOFF_MS[attempt];
      if (
        platform !== "win32" ||
        !code ||
        !RENAME_RETRY_CODES.has(code) ||
        delay === undefined
      ) {
        throw err;
      }
      sleep(delay);
    }
  }
}

/**
 * Flush a directory entry change (a rename into `dir`) to disk. Best
 * effort: Windows cannot open a directory for fsync, and some file systems
 * answer EINVAL/EPERM; the rename has already happened, so no error here
 * may fail the write.
 */
export function syncDirectoryBestEffort(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // EINVAL / EPERM / EISDIR: the platform or file system does not
    // support it. Nothing to do.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
