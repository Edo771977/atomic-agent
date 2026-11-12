import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

/**
 * Durability halves of a tmp-file-then-rename write. A rename is atomic,
 * but without an fsync of the tmp file first a power loss can leave the
 * new name pointing at a file whose data never reached the disk (an empty
 * `config.json` or `.env` after reboot); without an fsync of the directory
 * afterwards the rename itself may not survive.
 */

/**
 * Create `path` with `payload` and flush it to disk before returning.
 * `flag` is the open flag (`"w"` or `"wx"`); `mode` applies on creation.
 */
export function writeFileSyncedSync(
  path: string,
  payload: string,
  options: { mode: number; flag?: "w" | "wx" },
): void {
  const fd = openSync(path, options.flag ?? "w", options.mode);
  try {
    const data = Buffer.from(payload, "utf8");
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
