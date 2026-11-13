import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWebhookPinnedSessionIds, SessionPinsReadError } from "../session/index.js";
import { WEBHOOK_SESSIONS_FILENAME, WebhookSessionStore } from "./webhook-session-store.js";

describe("WebhookSessionStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-webhook-sessions-"));
    path = join(dir, WEBHOOK_SESSIONS_FILENAME);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists bindings and reads them back", () => {
    const store = new WebhookSessionStore(path);
    store.set("deploy", "s1");
    store.set("build", "s2");
    store.delete("build");
    expect(new WebhookSessionStore(path).get("deploy")).toBe("s1");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ deploy: "s1" });
  });

  // A write in place truncates the file first: a crash or a concurrent
  // reader in between sees an empty or half-written map, and session
  // retention would then not know which sessions the bindings pin.
  it("replaces the file by rename instead of rewriting it in place", () => {
    const store = new WebhookSessionStore(path);
    store.set("deploy", "s1");
    const before = statSync(path).ino;
    store.set("deploy", "s2");
    expect(statSync(path).ino).not.toBe(before);
    expect(store.get("deploy")).toBe("s2");
    // No tmp file is left beside it.
    expect(readdirSync(dir)).toEqual([WEBHOOK_SESSIONS_FILENAME]);
  });

  // A corrupt map made retention skip its prune on every boot, and the
  // store used to read it as {} and later overwrite it silently.
  it("moves a corrupt map aside, reports it, and lets the pin reader read again", () => {
    writeFileSync(path, '{ "deploy": "s1", ');
    const seen: unknown[] = [];
    const store = new WebhookSessionStore(path, {
      onCorrupt: (info) => seen.push(info),
      now: () => new Date("2026-01-02T03:04:05.678Z"),
    });
    expect(() => readWebhookPinnedSessionIds(path)).toThrow(SessionPinsReadError);

    store.recoverCorruptFile();

    const moved = `${path}.corrupt-2026-01-02T03-04-05-678Z`;
    expect(seen).toEqual([{ path, movedTo: moved }]);
    expect(readFileSync(moved, "utf8")).toBe('{ "deploy": "s1", ');
    expect(existsSync(path)).toBe(false);
    expect(readWebhookPinnedSessionIds(path)).toEqual([]);
    expect(store.get("deploy")).toBeNull();
    store.set("deploy", "s2");
    expect(store.get("deploy")).toBe("s2");
    expect(seen).toHaveLength(1);
  });

  it("moves a JSON non-object map aside too, and leaves a good map alone", () => {
    writeFileSync(path, "[1,2]");
    const seen: unknown[] = [];
    new WebhookSessionStore(path, { onCorrupt: (i) => seen.push(i) }).recoverCorruptFile();
    expect(seen).toHaveLength(1);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, '{"deploy":"s1"}');
    new WebhookSessionStore(path, { onCorrupt: (i) => seen.push(i) }).recoverCorruptFile();
    expect(seen).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe('{"deploy":"s1"}');
  });
});
