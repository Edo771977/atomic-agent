import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { writeOwnerOnlyFileAtomicSync } from "../config/owner-only-file.js";

/**
 * Flat-file store mapping webhook names to the session id they
 * persistently reuse across hits. Kept deliberately tiny — just
 * `<name>: <sessionId>` on disk — because the volume is bounded by the
 * operator's config and we want the persistence format to be
 * human-editable for recovery scenarios.
 *
 * Concurrency: all writes are synchronous through the single HTTP
 * server process, and we reread on every get so operators can hot-swap
 * entries by editing the file. A missing or unreadable file reads as an
 * empty map rather than failing the whole webhook pipeline. Writes go
 * to a tmp file renamed over the map (owner-only, like `config.json`),
 * so a crash or a reader mid-write never sees a truncated map.
 *
 * A file that reads but is not a JSON object is moved aside to
 * `<file>.corrupt-<time>` (and reported through `onCorrupt`) before the
 * empty map is used. Its bindings are lost either way — `get` cannot
 * resolve them and the next `set` would overwrite the file — so moving
 * it keeps the content for hand recovery and, just as important, lets
 * session retention read the pin file again: retention skips its prune
 * while `webhook-sessions.json` exists but does not parse, and without
 * this a corrupt map would stop every future prune. The runtime calls
 * `recoverCorruptFile()` once at boot so this happens even when no
 * webhook fires.
 */

/**
 * The file's name under the state dir. Exported because session
 * retention reads the same file to learn which sessions a binding pins
 * (`readWebhookPinnedSessionIds`), and two spellings of one filename is
 * how that check quietly stops finding anything.
 */
export const WEBHOOK_SESSIONS_FILENAME = "webhook-sessions.json";

export interface WebhookSessionStoreCorruptInfo {
  path: string;
  /** Where the corrupt file now lives, or null when the move failed. */
  movedTo: string | null;
  /** Errno code of a failed move, when there was one. */
  moveError?: string;
}

export interface WebhookSessionStoreOptions {
  /** Told once per corrupt file found. Never given file content. */
  onCorrupt?: (info: WebhookSessionStoreCorruptInfo) => void;
  now?: () => Date;
}

export class WebhookSessionStore {
  private readonly path: string;
  private readonly onCorrupt: (info: WebhookSessionStoreCorruptInfo) => void;
  private readonly now: () => Date;

  constructor(path: string, options: WebhookSessionStoreOptions = {}) {
    this.path = path;
    this.onCorrupt = options.onCorrupt ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  get(name: string): string | null {
    const map = this.readMap();
    const value = map[name];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /**
   * Persist a webhook name -> sessionId binding. Overwrites any
   * existing entry. Callers create the session upstream via
   * `AgentRuntime.createSession` — this store only remembers the id.
   */
  set(name: string, sessionId: string): void {
    const map = this.readMap();
    map[name] = sessionId;
    this.writeMap(map);
  }

  delete(name: string): void {
    const map = this.readMap();
    if (!(name in map)) return;
    delete map[name];
    this.writeMap(map);
  }

  /** Read the file once, moving it aside if it is corrupt. Never throws. */
  recoverCorruptFile(): void {
    this.readMap();
  }

  private readMap(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.moveAside();
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  }

  private moveAside(): void {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const target = `${this.path}.corrupt-${stamp}`;
    try {
      renameSync(this.path, target);
      this.onCorrupt({ path: this.path, movedTo: target });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.onCorrupt({
        path: this.path,
        movedTo: null,
        ...(code ? { moveError: code } : {}),
      });
    }
  }

  private writeMap(map: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeOwnerOnlyFileAtomicSync(
      this.path,
      `${JSON.stringify(map, null, 2)}\n`,
    );
  }
}
