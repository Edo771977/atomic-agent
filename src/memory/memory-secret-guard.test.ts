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
import {
  containsSecret,
  containsSecretPair,
  isSecretKey,
} from "./memory-secret-guard.js";

// Synthetic shapes only: never a real credential.
const OPENAI_LIKE = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const GITHUB_LIKE = "ghp_" + "0123456789abcdefghijABCDEFGHIJklmn";
const HEX32 = "9f86d081884c7d65" + "9a2feaa0c55ad015";
const STRIPE_LIKE = "sk_" + "live_" + "51Ab12Cd34Ef56Gh78Ij90Kl";
const STRIPE_RESTRICTED_LIKE = "rk_" + "live_" + "51Ab12Cd34Ef56Gh78Ij90Kl";
const TELEGRAM_LIKE = "123456789" + ":" + "AAH" + "x9Kd2Lm8Pq4Rs7Tu1Vw5Xy3Za6Bc0Def";
const AWS_ID_LIKE = "AKIA" + "IOSFODNN7EXAMPLE";
const AWS_SECRET_LIKE = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY";

describe("the memory credential check", () => {
  it.each([
    ["a labelled password", "password: correcthorsebatterystaple"],
    ["a password in prose", "the wifi password is hunter2"],
    ["a labelled hex API key", `API key: ${HEX32}`],
    ["a Stripe secret key", `billing uses ${STRIPE_LIKE}`],
    ["a Stripe restricted key", `reports use ${STRIPE_RESTRICTED_LIKE}`],
    ["a Telegram bot token", `the bot token ${TELEGRAM_LIKE}`],
    ["an AWS key pair", `${AWS_ID_LIKE} / ${AWS_SECRET_LIKE}`],
    ["an AWS secret after its label", `aws secret access key is ${AWS_SECRET_LIKE}`],
    ["a PIN", "door pin: 4821"],
  ])("refuses %s", (_name, text) => {
    expect(containsSecret(text)).toBe(true);
  });

  it.each([
    ["a commit SHA", "deployed 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 to prod"],
    ["a UUID", "the workspace id is 550e8400-e29b-41d4-a716-446655440000"],
    ["a URL", "the dashboard is https://grafana.example.com/d/abc123?orgId=1"],
    ["a password manager", "uses 1Password as the password manager"],
    ["prose about a password", "the password is stored in the vault; password: see vault"],
    ["a rejected password", "the password was rejected twice"],
    ["a token budget", "token: 4096 per reply"],
    ["a masked value", "password: [redacted:secret]"],
    ["a reference", "API key: $OPENAI_API_KEY"],
  ])("lets %s through", (_name, text) => {
    expect(containsSecret(text)).toBe(false);
  });

  it("reads a key and its value together", () => {
    expect(containsSecretPair("pin", "4821")).toBe(true);
    expect(containsSecretPair("router_pw", "hunter2")).toBe(true);
    expect(containsSecretPair("api.key", HEX32)).toBe(true);
    expect(containsSecretPair("timezone", "Europe/Lisbon")).toBe(false);
    expect(containsSecretPair("favorite_number", "4821")).toBe(false);
    expect(containsSecretPair("password_manager", "1Password")).toBe(false);
  });

  it("refuses credential keys but not names that end in pat", () => {
    expect(isSecretKey("github_pat")).toBe(true);
    expect(isSecretKey("wifi password")).toBe(true);
    expect(isSecretKey("favorite_pat")).toBe(false);
    expect(isSecretKey("pat")).toBe(false);
  });
});

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

    it("rejects a pair that is a credential only together", () => {
      expect(() => store.set("pin", "4821")).toThrow(ProfileValidationError);
      expect(() => store.set("wifi", "password is hunter2")).toThrow(ProfileValidationError);
      expect(store.list()).toEqual([]);
      store.set("favorite_pat", "Pat Metheny");
      expect(store.list().map((f) => f.key)).toEqual(["favorite_pat"]);
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
