import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "./config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "./config-file.js";
import { USER_CONFIG_DEFAULTS } from "./config-schema.js";
import { applyFusionSetupInConfig } from "./fusion-setup-commands.js";

describe("applyFusionSetupInConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-fusion-setup-cfg-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }],
        runMode: { fusion: { workers: 3 } },
      },
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  const raw = () => readFileSync(getUserConfigPath(stateDir), "utf8");

  it("adds the entry, pins the legs and merges over the stored block in one write", () => {
    applyFusionSetupInConfig({
      addProvider: { id: "claude-cli", kind: "subscription-cli", subscriptionCli: { cli: "claude" } },
      activeTextProvider: "claude-cli",
      fusion: { orchestratorProvider: "claude-cli", workerProvider: "local-llama", autoReplan: 1 },
    });
    const llm = (JSON.parse(raw()) as { llm: Record<string, unknown> }).llm as {
      activeTextProvider: string;
      providers: Array<{ id: string; modelMode?: string }>;
      runMode: unknown;
    };
    expect(llm.activeTextProvider).toBe("claude-cli");
    expect(llm.providers.map((p) => p.id)).toEqual(["local-llama", "claude-cli"]);
    expect(llm.providers[1]!.modelMode).toBeDefined();
    expect(llm.runMode).toEqual({
      mode: "fusion",
      fusion: { workers: 3, orchestratorProvider: "claude-cli", workerProvider: "local-llama", autoReplan: 1 },
    });
  });

  it("refuses a leg that names no configured provider and leaves the file as it was", () => {
    const before = raw();
    expect(() =>
      applyFusionSetupInConfig({
        activeTextProvider: "local-llama",
        fusion: { orchestratorProvider: "nowhere", workerProvider: "local-llama" },
      }),
    ).toThrow(/unknown provider id/);
    expect(raw()).toBe(before);
  });
});
