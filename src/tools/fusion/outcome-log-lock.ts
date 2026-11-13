import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

/**
 * The outcome log's cross-process write lock: an `O_EXCL` file beside the
 * log (`<log>.lock`) holding its owner's pid and a random token. The TUI,
 * the sidecar and the scheduler can all append to one log; only the
 * lock's holder may rotate it.
 *
 * Short and never blocking for long: a holder keeps it for one stat,
 * rotate and append. A lock older than `OUTCOME_LOCK_STALE_MS`, or whose
 * owner pid is gone, is broken. A caller that cannot take it within its
 * wait appends without rotating instead.
 */

/** A lock this old is abandoned (its holder needs microseconds). */
export const OUTCOME_LOCK_STALE_MS = 5_000;
/** How long an append waits for the lock before appending without rotating. */
export const OUTCOME_LOCK_WAIT_MS = 25;
const POLL_MS = 2;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function ownerGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** True when the lock at `path` may be broken: too old, or its owner is gone. */
function isStale(path: string, now: number, staleMs: number): boolean {
  try {
    const age = now - statSync(path).mtimeMs;
    if (age > staleMs) return true;
    const pid = Number(readFileSync(path, "utf8").split(" ")[0]);
    return ownerGone(pid);
  } catch {
    // Gone already (released between the create and here): retry the create.
    return false;
  }
}

function tryCreate(path: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface OutcomeLockOptions {
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
}

/**
 * Take the lock at `path`, or `undefined` when another live holder kept
 * it past `waitMs`. The returned function releases it (only while it is
 * still this holder's: a lock broken as stale and re-taken is left alone).
 * Throws only for a filesystem error other than contention.
 */
export function tryAcquireOutcomeLock(
  path: string,
  options: OutcomeLockOptions = {},
): (() => void) | undefined {
  const waitMs = options.waitMs ?? OUTCOME_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? OUTCOME_LOCK_STALE_MS;
  const now = options.now ?? Date.now;
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const deadline = now() + waitMs;
  for (let breaks = 0; ; ) {
    if (tryCreate(path, token)) {
      return () => {
        try {
          if (readFileSync(path, "utf8") === token) unlinkSync(path);
        } catch {
          // Already gone: nothing to release.
        }
      };
    }
    if (breaks < 3 && isStale(path, now(), staleMs)) {
      // Two breakers can race here; the loser's create then fails and it
      // waits like any other contender.
      breaks += 1;
      try {
        unlinkSync(path);
      } catch {
        // Someone else broke it first.
      }
      continue;
    }
    if (now() >= deadline) return undefined;
    sleepSync(POLL_MS);
  }
}
