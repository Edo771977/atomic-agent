import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
