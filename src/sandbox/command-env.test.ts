import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildCommandEnv,
  isSecretEnvName,
  KNOWN_SECRET_ENV_VARS,
} from "./command-env.js";

const AGENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/op",
  LANG: "en_US.UTF-8",
  NVM_DIR: "/home/op/.nvm",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
  ATOMIC_AGENT_STATE_DIR: "/home/op/.atomic-agent",
  OPENAI_API_KEY: "leak-openai",
  EXA_API_KEY: "leak-exa",
  TELEGRAM_BOT_TOKEN: "leak-telegram",
  GITHUB_TOKEN: "leak-github",
  AWS_SECRET_ACCESS_KEY: "leak-aws",
  PGPASSWORD: "leak-pg",
  STRIPE_KEY: "leak-stripe",
};

describe("buildCommandEnv (ATO-347)", () => {
  it("keeps the working environment and drops keys, tokens and passwords", () => {
    expect(buildCommandEnv(AGENT_ENV)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
      NVM_DIR: "/home/op/.nvm",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
      ATOMIC_AGENT_STATE_DIR: "/home/op/.atomic-agent",
    });
  });

  it("lets a passthrough name through, and only that one", () => {
    const env = buildCommandEnv(AGENT_ENV, ["GITHUB_TOKEN"]);
    expect(env.GITHUB_TOKEN).toBe("leak-github");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
  });

  it("matches names and passthrough without regard to case", () => {
    const env = buildCommandEnv(
      { Path: "C:\\Windows", OpenAI_Api_Key: "leak", Gh_Token: "own" },
      ["GH_TOKEN"],
    );
    expect(env).toEqual({ Path: "C:\\Windows", Gh_Token: "own" });
  });

  it("does not modify the agent's own environment", () => {
    const base = { ...AGENT_ENV };
    buildCommandEnv(base);
    expect(base).toEqual(AGENT_ENV);
  });
});

describe("buildCommandEnv: git's GIT_CONFIG_* set", () => {
  const GIT_ENV: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.interactive",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: "Authorization: Bearer leak-header",
    GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_2: "git@github.com:",
  };

  it("keeps the count and its keys together, so git can still parse them", () => {
    // Regression: the KEY segment dropped every GIT_CONFIG_KEY_i and kept
    // the count, and every os.git.* call failed with "missing config key".
    const env = buildCommandEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    });
  });

  it("drops an entry that carries a credential and renumbers the rest", () => {
    const env = buildCommandEnv(GIT_ENV);
    expect(env).toEqual({
      PATH: process.env.PATH,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.interactive",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_1: "git@github.com:",
    });
    expect(JSON.stringify(env)).not.toContain("leak-header");
  });

  it("drops a credential helper and a URL with a password in it", () => {
    const env = buildCommandEnv({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://example.com.helper",
      GIT_CONFIG_VALUE_0: "!f() { echo password=leak; }; f",
      GIT_CONFIG_KEY_1: "url.https://bot:leak-pass@example.com/.insteadOf",
      GIT_CONFIG_VALUE_1: "https://example.com/",
    });
    expect(env).toEqual({ GIT_CONFIG_COUNT: "0" });
  });

  it("lets a credential entry through when its value is a passthrough name", () => {
    const env = buildCommandEnv(GIT_ENV, ["GIT_CONFIG_VALUE_1"]);
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_VALUE_1).toBe("Authorization: Bearer leak-header");
  });

  it("passes nothing of a set git would refuse anyway", () => {
    expect(buildCommandEnv({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1" })).toEqual({});
    expect(buildCommandEnv({ GIT_CONFIG_COUNT: "x", GIT_CONFIG_KEY_0: "a.b" })).toEqual({});
    expect(buildCommandEnv({ GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1" })).toEqual({});
  });

  it("reads the set without regard to case", () => {
    const env = buildCommandEnv({ Git_Config_Count: "1", git_config_key_0: "core.pager", Git_Config_Value_0: "cat" });
    expect(env).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" });
  });

  it("gives real git an environment it can run with", () => {
    const out = execFileSync("git", ["config", "--get", "url.https://github.com/.insteadof"], {
      env: buildCommandEnv(GIT_ENV),
      encoding: "utf8",
    });
    expect(out.trim()).toBe("git@github.com:");
  });
});

describe("isSecretEnvName", () => {
  it("flags every known provider and bot credential", () => {
    for (const name of KNOWN_SECRET_ENV_VARS) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("flags secret-looking names it has never seen", () => {
    for (const name of [
      "NPM_TOKEN",
      "MY_APIKEY",
      "DB_PASSWORD",
      "PGPASSWORD",
      "GPG_PASSPHRASE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "DEPLOY_PRIVATE_KEY",
      "LICENSE_KEY",
      "SIGNING_KEYS",
      "GITHUB_PAT",
      "GH_PAT",
      "SUPABASE_JWT",
      "NPM_CONFIG__AUTH",
      "BASIC_AUTH",
      "SESSION_COOKIE",
      "BW_SESSION",
      "OP_SESSION_my_team",
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it("leaves ordinary variables alone", () => {
    for (const name of [
      "PATH",
      "HOME",
      "SSH_AUTH_SOCK",
      "XAUTHORITY",
      "GNOME_KEYRING_CONTROL",
      "KEYMAP",
      "MONKEY_BUSINESS",
      "JAVA_HOME",
      "HTTPS_PROXY",
      "PASSWORD_STORE_DIR",
      "TOKENIZERS_PARALLELISM",
      "XDG_SESSION_TYPE",
      "DBUS_SESSION_BUS_ADDRESS",
      "PKG_CONFIG_PATH",
      "KEYBOARD_LAYOUT",
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});
