import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  readCachedSession,
  resolveSessionPath,
  writeCachedSession,
} from "./atomic-mail-store.js";

describe("Atomic Mail cached session file", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-mail-store-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const session = (n: number) => ({
    sessionJwt: `header.payload-${n}.signature`,
    sessionExpiresAt: 1_000 + n,
  });

  it("replaces session.json by rename, owner-only, and leaves no tmp file", () => {
    writeCachedSession(stateDir, session(1));
    const path = resolveSessionPath(stateDir);
    const before = statSync(path).ino;

    writeCachedSession(stateDir, session(2));

    expect(statSync(path).ino).not.toBe(before);
    expect(readCachedSession(stateDir)).toEqual(session(2));
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(dirname(path))).toEqual(["session.json"]);
  });

  it("removes the file when the session is cleared", () => {
    writeCachedSession(stateDir, session(1));
    writeCachedSession(stateDir, null);
    expect(existsSync(resolveSessionPath(stateDir))).toBe(false);
    expect(readCachedSession(stateDir)).toBeNull();
  });
});
