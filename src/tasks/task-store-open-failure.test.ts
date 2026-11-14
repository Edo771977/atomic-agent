import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
import { TaskStore } from "./task-store.js";

describe("TaskStore failed initialization", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-open-failure-"));
    dbFile = join(dir, "tasks.sqlite");
    new TaskStore({ dbFile }).close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes a database rejected for a newer schema before returning the error", () => {
    const db = new DatabaseCtor(dbFile);
    db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'version'").run();
    db.close();
    const close = vi.spyOn(DatabaseCtor.prototype, "close");

    expect(() => new TaskStore({ dbFile })).toThrow(/schema version 999.*newer/);
    expect(close).toHaveBeenCalledTimes(1);
    // Windows cannot unlink an open SQLite file; POSIX still checks the
    // close call above, so the resource assertion is meaningful there too.
    expect(() => rmSync(dbFile)).not.toThrow();
  });

  it("closes after statement initialization fails and preserves that error", () => {
    const failure = new Error("injected statement failure");
    const original = DatabaseCtor.prototype.prepare;
    vi.spyOn(DatabaseCtor.prototype, "prepare").mockImplementation(function (this: InstanceType<typeof DatabaseCtor>, sql, ...args) {
      if (sql.startsWith("INSERT INTO tasks")) throw failure;
      return original.call(this, sql, ...args);
    });
    const close = vi.spyOn(DatabaseCtor.prototype, "close");

    expect(() => new TaskStore({ dbFile })).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => rmSync(dbFile)).not.toThrow();
  });
});
