import { existsSync, readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

/**
 * What outside `sessions.sqlite` points at a session by id, and would be
 * left holding a dead pointer if retention took the row.
 *
 * Both sources live in the state dir and neither can have a foreign key
 * into the sessions table — one is a separate SQLite file (SQLite has no
 * cross-file FKs), the other is a JSON file. So the only thing that keeps
 * a prune honest is reading them, and the cost of not reading them is a
 * scheduled job or a webhook binding that silently stops working.
 *
 * Every reader here is read-only. A missing file or a missing `tasks`
 * table reads as "no pins": the surfaces they describe are optional
 * (`tasks.enabled`, a webhook the operator may never have configured).
 * A file that exists but cannot be read or parsed throws
 * `SessionPinsReadError` instead: it may still name live bindings, and an
 * empty keep-list would let retention prune exactly those sessions. The
 * caller skips the prune and boots anyway.
 *
 * What is deliberately *not* here: the Telegram and Discord per-chat
 * session pointers. Those two paths already treat a pointer to a missing
 * session as something to heal rather than an error — see
 * `acquireOrCreateSession` in both inbound handlers, which logs
 * `pointer references missing session, recreating`, releases the approval
 * binding and mints a fresh session with the same chat metadata.
 */

/**
 * A pin source exists but could not be read. Carries the source, the
 * path and a short reason (an errno code, `parse` or `sqlite`), never
 * file content.
 */
export class SessionPinsReadError extends Error {
  constructor(
    public readonly source: "tasks" | "webhooks",
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`could not read ${source} session pins from ${path} (${reason})`);
    this.name = "SessionPinsReadError";
  }
}

/**
 * What the operator should do about an unreadable pin file. Retention
 * keeps skipping its pass until the file reads again (pruning blind
 * could take a pinned session), so this is shown wherever the skip is
 * reported: the boot warning and `atomic-agent doctor`.
 */
export function describeSessionPinsFix(err: SessionPinsReadError): string {
  const { path, reason } = err;
  if (reason === "EACCES" || reason === "EPERM") {
    return `make ${path} readable by the user that runs atomic-agent (check ls -l "${path}", then chmod 600 "${path}")`;
  }
  if (err.source === "webhooks" && reason === "parse") {
    return `${path} is not valid JSON; repair it by hand, or move it aside (its persistent webhook bindings are lost either way; the webhook store moves it to ${path}.corrupt-<time> the next time it starts)`;
  }
  if (err.source === "tasks" && (reason === "SQLITE_BUSY" || reason === "SQLITE_LOCKED")) {
    return `another process held a lock on ${path}; this usually clears by the next start`;
  }
  if (err.source === "tasks") {
    return `check ${path} with sqlite3 "${path}" "PRAGMA integrity_check"; restore it from a backup or move it aside (the scheduled tasks in it are lost if moved)`;
  }
  return `check that ${path} is readable, or move it aside`;
}

function failureReason(err: unknown, fallback: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : fallback;
}

/**
 * Everything that pins a session, from every source, deduped. Throws
 * `SessionPinsReadError` when a source exists but cannot be read.
 */
export function readSessionPins(sources: {
  tasksDbFile?: string | null;
  webhookSessionsFile?: string | null;
}): string[] {
  return [
    ...new Set([
      ...readTaskPinnedSessionIds(sources.tasksDbFile),
      ...readWebhookPinnedSessionIds(sources.webhookSessionsFile),
    ]),
  ];
}

/**
 * Sessions a scheduled task points at, from `tasks.sqlite`.
 *
 * `TaskRunner` finds out that a session is gone by marking the task
 * `blocked` with `session_not_found`, which is a scheduled job that
 * stops happening without telling anyone.
 */
export function readTaskPinnedSessionIds(
  tasksDbFile: string | null | undefined,
): string[] {
  if (!tasksDbFile || !existsSync(tasksDbFile)) return [];
  let db: Database.Database | null = null;
  try {
    db = new DatabaseCtor(tasksDbFile, {
      readonly: true,
      fileMustExist: true,
    });
    const rows = db
      .prepare(
        `SELECT DISTINCT session_id AS id FROM tasks WHERE session_id IS NOT NULL`,
      )
      .all() as { id: unknown }[];
    return onlyIds(rows.map((row) => row.id));
  } catch (err) {
    // A database with no `tasks` table yet pins nothing; anything else
    // (a corrupt file, a lock, a permission error) is unknown pins.
    if (err instanceof Error && /no such table: tasks\b/.test(err.message)) {
      return [];
    }
    throw new SessionPinsReadError(
      "tasks",
      tasksDbFile,
      failureReason(err, "sqlite"),
    );
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to do with a handle that will not close.
    }
  }
}

/**
 * Sessions a `persistent` webhook binding reuses, from
 * `webhook-sessions.json` — a flat `{ <webhookName>: <sessionId> }` map
 * (see `WebhookSessionStore`).
 *
 * `resolveWebhookSessionId` hands the stored id straight back on every
 * hit and only creates a session when there is no entry at all, so a
 * pruned row does not heal itself: the binding keeps its dead id and
 * every later hit materialises a task that blocks with
 * `session_not_found`.
 */
export function readWebhookPinnedSessionIds(
  webhookSessionsFile: string | null | undefined,
): string[] {
  if (!webhookSessionsFile) return [];
  let raw: string;
  try {
    raw = readFileSync(webhookSessionsFile, "utf8");
  } catch (err) {
    if (failureReason(err, "") === "ENOENT") return [];
    throw new SessionPinsReadError(
      "webhooks",
      webhookSessionsFile,
      failureReason(err, "read"),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // A half-written or hand-broken file may still have named live
    // bindings: unknown pins, not none.
    throw new SessionPinsReadError("webhooks", webhookSessionsFile, "parse");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  return onlyIds(Object.values(parsed as Record<string, unknown>));
}

/** Non-empty strings only — the file is hand-editable. */
function onlyIds(values: readonly unknown[]): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
