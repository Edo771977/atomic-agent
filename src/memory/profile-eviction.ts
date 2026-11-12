import type Database from "better-sqlite3";

export interface EvictedProfileFact {
  id: number;
  key: string;
}

/** One overflow sweep that removed at least one fact. */
export interface ProfileEviction {
  /** In eviction order (lowest utility first). */
  evicted: readonly EvictedProfileFact[];
  maxEntries: number;
  /** Active unpinned facts left after the sweep. */
  activeUnpinned: number;
}

/**
 * Prepare "forget this key": delete every row for it, active and
 * superseded. A row of another key that cross-key superseded one of them
 * keeps its own value with its `supersedes` pointer cleared (it must not
 * point at a row that no longer exists); an older row of another key
 * that one of them superseded stays superseded. Shared by
 * `ProfileStore.remove` and eviction so the two cannot drift. The
 * returned function must run inside the caller's transaction and
 * returns the number of rows deleted.
 */
export function prepareProfileKeyForget(
  db: Database.Database,
): (key: string) => number {
  const deleteKeyStmt = db.prepare(`DELETE FROM profile_facts WHERE key = ?`);
  const clearSupersedesIntoKeyStmt = db.prepare(
    `UPDATE profile_facts
        SET supersedes = NULL
      WHERE key <> @key
        AND supersedes IN (SELECT id FROM profile_facts WHERE key = @key)`,
  );
  return (key) => {
    clearSupersedesIntoKeyStmt.run({ key });
    return (deleteKeyStmt.run(key) as { changes: number }).changes;
  };
}

/** Throws unless `maxEntries` is a positive integer. */
export function assertProfileMaxEntries(maxEntries: number): void {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error(
      `ProfileStore: maxEntries must be a positive integer, got ${maxEntries}`,
    );
  }
}

/**
 * Enforces `memory.profile.maxEntries` on `profile_facts` (issue #407).
 *
 * **What counts.** Only active (`superseded_by IS NULL`) **unpinned**
 * facts. Pinned facts are never counted and never evicted: they are the
 * ones the operator or the model marked as always-relevant, and an
 * automatic path deciding one of them is expendable is exactly the
 * failure the issue describes. If pinned facts alone grow past any
 * budget, nothing here removes them — the `### profile` clip warning is
 * the signal, and removal stays an explicit `memory.profile.remove`.
 *
 * **Order.** `vote_score ASC, updated_at ASC, id ASC` — downvoted facts
 * first, then the stalest, ties by id — the same ladder `ProcedureStore`
 * uses. Profile rows carry no recall counters, so there is nothing else
 * to weigh. The row being written is never a candidate: a `set()` that
 * succeeds and then evicts its own write would be a silent no-op.
 *
 * **What eviction does.** It forgets the key exactly like
 * `ProfileStore.remove(key)` (both use `prepareProfileKeyForget`): the
 * active row and every superseded version go, so `history(key)` is
 * empty afterwards — notes evict by delete too. Eviction is the budget
 * deciding a fact is expendable; keeping its invisible history would
 * let rows the cap never counts grow without bound. A later write of
 * the key starts a fresh chain.
 *
 * **When.** Inside the `set()` transaction, after the insert, so the
 * table is never observed over the cap and a failed write evicts
 * nothing. A lowered cap is applied on the next write, not at startup.
 */
export class ProfileEvictor {
  private readonly countStmt: Database.Statement;
  private readonly pickStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly forgetKey: (key: string) => number;

  constructor(
    db: Database.Database,
    private readonly maxEntries: number,
  ) {
    assertProfileMaxEntries(maxEntries);
    this.forgetKey = prepareProfileKeyForget(db);
    this.countStmt = db.prepare(
      `SELECT COUNT(*) AS count FROM profile_facts
        WHERE superseded_by IS NULL AND pinned = 0`,
    );
    this.pickStmt = db.prepare(
      `SELECT id, key FROM profile_facts
        WHERE superseded_by IS NULL AND pinned = 0 AND id != @keep_id
        ORDER BY vote_score ASC, updated_at ASC, id ASC
        LIMIT @limit`,
    );
    // The predicate repeats the pick's filter so this statement cannot
    // delete a pinned or historical row whatever id it is handed.
    this.deleteStmt = db.prepare(
      `DELETE FROM profile_facts
        WHERE id = ? AND superseded_by IS NULL AND pinned = 0`,
    );
  }

  /**
   * Trim active unpinned facts down to the cap, sparing `keepId`. Must
   * run inside the caller's write transaction. `null` when under the cap.
   */
  evictOverflow(keepId: number): ProfileEviction | null {
    const { count } = this.countStmt.get() as { count: number };
    if (count <= this.maxEntries) return null;
    const picked = this.pickStmt.all({
      keep_id: keepId,
      limit: count - this.maxEntries,
    }) as EvictedProfileFact[];
    const evicted: EvictedProfileFact[] = [];
    for (const row of picked) {
      const result = this.deleteStmt.run(row.id) as { changes: number };
      if (result.changes > 0) {
        // The active row is gone; drop the rest of the key's history.
        this.forgetKey(row.key);
        evicted.push({ id: row.id, key: row.key });
      }
    }
    if (evicted.length === 0) return null;
    return {
      evicted,
      maxEntries: this.maxEntries,
      activeUnpinned: count - evicted.length,
    };
  }
}
