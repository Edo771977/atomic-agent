import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LessonStore, LessonValidationError } from "./lessons/lesson-store.js";
import { MemoryStore, MemoryValidationError } from "./memory-store.js";
import {
  ProcedureStore,
  ProcedureValidationError,
} from "./procedures/procedure-store.js";
import { ProfileStore, ProfileValidationError } from "./profile-store.js";

// Synthetic shapes only: never a real credential.
const OPENAI_LIKE = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const GITHUB_LIKE = "ghp_" + "0123456789abcdefghijABCDEFGHIJklmn";

describe("durable memory refuses credentials", () => {
  let tmp: string;
  let dbFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-memory-secret-"));
    dbFile = join(tmp, "memory.sqlite");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("profile facts", () => {
    let store: ProfileStore;
    beforeEach(() => {
      store = new ProfileStore({ dbFile });
    });
    afterEach(() => store.close());

    it("rejects a secret-shaped value without echoing it", () => {
      let caught: unknown;
      try {
        store.set("deploy_note", `use ${OPENAI_LIKE} for prod`);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProfileValidationError);
      expect((caught as ProfileValidationError).field).toBe("value");
      expect((caught as Error).message).not.toContain(OPENAI_LIKE);
      expect(store.list()).toEqual([]);
      expect(store.listForPrompt()).toEqual([]);
    });

    it("rejects a key that names a credential", () => {
      for (const key of ["openai_api_key", "github_token", "db_password", "apiKey"]) {
        expect(() => store.set(key, "value-without-shape")).toThrow(
          ProfileValidationError,
        );
      }
      expect(store.list()).toEqual([]);
    });

    it("keeps ordinary facts and keys that only mention a credential", () => {
      store.set("password_manager", "1Password");
      store.set("timezone", "Europe/Lisbon");
      store.set("max_tokens_preference", "4096");
      store.set("api_key_location", "stored in .env as OPENAI_API_KEY=[redacted:secret]");
      expect(store.list().map((f) => f.key).sort()).toEqual([
        "api_key_location",
        "max_tokens_preference",
        "password_manager",
        "timezone",
      ]);
    });

    it("still lets a legacy secret key be removed", () => {
      expect(store.remove("openai_api_key")).toBe(false);
    });
  });

  it("rejects a note that carries a credential", () => {
    const store = new MemoryStore({ dbFile, maxEntries: 1000 });
    try {
      expect(() =>
        store.store({ content: `CI uses GITHUB_TOKEN=${GITHUB_LIKE}` }),
      ).toThrow(MemoryValidationError);
      expect(store.count()).toBe(0);
      store.store({ content: "CI reads GITHUB_TOKEN from the repository secrets" });
      expect(store.count()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a lesson that carries a credential", () => {
    const store = new LessonStore({ dbFile });
    try {
      expect(() =>
        store.create({
          activation: "calling the API",
          principle: `send Authorization: Bearer ${OPENAI_LIKE}`,
          parentIds: [1, 2],
        }),
      ).toThrow(LessonValidationError);
      expect(store.countAll()).toBe(0);
      expect(() =>
        store.create({
          activation: `when ${OPENAI_LIKE} is needed`,
          principle: "read it from the environment",
          parentIds: [1, 2],
        }),
      ).toThrow(/credential/);
    } finally {
      store.close();
    }
  });

  it("rejects a procedure that carries a credential", () => {
    const store = new ProcedureStore({ dbFile });
    try {
      expect(() =>
        store.create({
          activation: "deploying the service",
          steps: [
            { description: `export TOKEN=${GITHUB_LIKE}`, toolHint: null },
            { description: "run the deploy script", toolHint: null },
          ],
          parentLessonIds: [1],
          parentMemoryIds: [],
        }),
      ).toThrow(ProcedureValidationError);
      expect(store.countAll()).toBe(0);
      expect(() =>
        store.create({
          activation: "deploying the service",
          steps: [
            { description: `export TOKEN=${GITHUB_LIKE}`, toolHint: null },
            { description: "run the deploy script", toolHint: null },
          ],
          parentLessonIds: [1],
          parentMemoryIds: [],
        }),
      ).toThrow(/steps.*credential|credential/);
    } finally {
      store.close();
    }
  });
});
