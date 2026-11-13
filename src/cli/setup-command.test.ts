import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS, type UserConfigFile } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import { resolveRunMode } from "../llm/run-mode/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { listLocalModels } from "../local-llm/index.js";
import { setupCommand, type SetupCommandDeps } from "./setup-command.js";
import type { FusionDetectDeps } from "./setup-fusion-detect.js";

const SECRET = "sk-or-v1-THIS-MUST-NOT-PRINT";
const KEY_VARS = ["OPENROUTER_API_KEY", "AIMLAPI_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY"];
const MODEL = listLocalModels()[0]!.id;

describe("atomic-agent setup fusion", () => {
  let stateDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-setup-fusion-"));
    saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
    for (const k of KEY_VARS) delete process.env[k];
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function seed(opts: { openrouter?: boolean; key?: boolean; modelId?: string | null } = {}): void {
    const file: UserConfigFile = {
      ...USER_CONFIG_DEFAULTS,
      localModels: {
        ...USER_CONFIG_DEFAULTS.localModels,
      mode: "managed",
        managed: { ...USER_CONFIG_DEFAULTS.localModels.managed, modelId: opts.modelId === undefined ? MODEL : opts.modelId },
      },
      llm: {
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
          ...(opts.openrouter === false ? [] : [{ id: "openrouter", kind: "openrouter", defaultChatModel: "x/y" }]),
        ],
      },
    };
    writeUserConfigFileSync(getUserConfigPath(stateDir), file);
    if (opts.key !== false) writeFileSync(join(stateDir, ".env"), `OPENROUTER_API_KEY=${SECRET}\n`, { mode: 0o600 });
  }

  function harness(detect: Partial<FusionDetectDeps> = {}, extra: Partial<SetupCommandDeps> = {}) {
    let out = "";
    const deps: SetupCommandDeps = {
      write: (t) => { out += t; },
      stateDir,
      detect: {
        checkCli: async () => ({ state: "missing", fix: "install-claude" }),
        downloadedModelIds: () => [MODEL],
        recommendModelId: async () => MODEL,
        claudeCliDefaultModel: () => "cli-default",
        probeExternal: async () => false,
        ...detect,
      },
      confirm: async () => { throw new Error("must not ask"); },
      ...extra,
    };
    return { deps, out: () => out };
  }

  const raw = () => readFileSync(getUserConfigPath(stateDir), "utf8");
  const fileJson = () => JSON.parse(raw()) as { llm: Record<string, unknown> & { runMode?: { mode?: string; fusion?: Record<string, unknown> } } };

  it("--yes writes both legs and the preset through the real config path", async () => {
    seed();
    const h = harness();
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(0);
    const llm = fileJson().llm;
    expect(llm.activeTextProvider).toBe("openrouter");
    expect(llm.runMode).toEqual({
      mode: "fusion",
      fusion: { orchestratorProvider: "openrouter", workerProvider: "local-llama", autoReplan: 1, escalation: "advisor", turnBudgetUsd: 1 },
    });
    // The runtime reads it as fusion, not a degraded mode.
    resetConfigCache();
    const resolved = resolveRunMode(resolveLlmConfig(getConfig()), { managedModelId: MODEL });
    expect(resolved.effective).toBe("fusion");
    expect(resolved.escalation?.providerId).toBe("openrouter");
    expect(h.out()).toMatch(/turnBudgetUsd\s+\(unset\) → 1/);
    expect(h.out()).toMatch(/Fusion is on/);
  });

  it("never prints or writes the key into config.json", async () => {
    seed();
    const h = harness();
    await setupCommand(["fusion", "--yes"], h.deps);
    expect(h.out()).not.toContain(SECRET);
    expect(raw()).not.toContain(SECRET);
  });

  it("--dry-run prints the plan and writes nothing", async () => {
    seed();
    const before = raw();
    const h = harness();
    expect(await setupCommand(["fusion", "--dry-run"], h.deps)).toBe(0);
    expect(raw()).toBe(before);
    expect(h.out()).toMatch(/Will change:/);
    expect(h.out()).toMatch(/Dry run: nothing written/);
  });

  it("--dry-run on a fresh state dir does not create config.json", async () => {
    const h = harness({ checkCli: async () => ({ state: "ready", fix: null }) });
    // A fresh install points at an external server that is not running.
    expect(await setupCommand(["fusion", "--dry-run"], h.deps)).toBe(1);
    expect(h.out()).toMatch(/No local model server answers/);
    expect(existsSync(getUserConfigPath(stateDir))).toBe(false);
  });

  it("is idempotent: a second run says already set and writes nothing", async () => {
    seed();
    await setupCommand(["fusion", "--yes"], harness().deps);
    const after = raw();
    const h = harness();
    expect(await setupCommand(["fusion"], h.deps)).toBe(0);
    expect(h.out()).toMatch(/already set up/);
    expect(raw()).toBe(after);
  });

  it("asks before writing; a no writes nothing, a non-terminal asks for --yes", async () => {
    seed();
    const before = raw();
    const no = harness({}, { confirm: async () => false });
    expect(await setupCommand(["fusion"], no.deps)).toBe(1);
    expect(no.out()).toMatch(/Nothing written/);
    const pipe = harness({}, { confirm: async () => "no-tty" });
    expect(await setupCommand(["fusion"], pipe.deps)).toBe(1);
    expect(pipe.out()).toMatch(/re-run with --yes/);
    expect(raw()).toBe(before);
    const yes = harness({}, { confirm: async () => true });
    expect(await setupCommand(["fusion"], yes.deps)).toBe(0);
    expect(fileJson().llm.runMode?.mode).toBe("fusion");
  });

  it("no key, Claude Code signed in: adds a keyless Claude Code entry as orchestrator", async () => {
    seed({ openrouter: false, key: false });
    const h = harness({ checkCli: async () => ({ state: "ready", fix: null }) });
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(0);
    const llm = fileJson().llm as { activeTextProvider: string; providers: Array<Record<string, unknown>>; runMode: { fusion: Record<string, unknown> } };
    expect(llm.activeTextProvider).toBe("claude-cli");
    const entry = llm.providers.find((p) => p.id === "claude-cli")!;
    expect(entry).toMatchObject({ kind: "subscription-cli", subscriptionCli: { cli: "claude" } });
    expect(entry).not.toHaveProperty("apiKey");
    expect(llm.runMode.fusion).not.toHaveProperty("turnBudgetUsd");
    expect(llm.runMode.fusion).not.toHaveProperty("escalation");
    expect(h.out()).toMatch(/escalation stays off/);
  });

  it("refuses with the next step when no orchestrator can answer", async () => {
    seed({ key: false });
    const before = raw();
    const h = harness({ checkCli: async () => ({ state: "signed_out", fix: "claude   (then /login)" }) });
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(1);
    expect(h.out()).toMatch(/openrouter has no API key: put OPENROUTER_API_KEY=… in .*\.env/);
    expect(h.out()).toMatch(/not signed in; run: claude/);
    expect(raw()).toBe(before);
  });

  it("refuses with the download command when no local model is on disk", async () => {
    seed();
    const h = harness({ downloadedModelIds: () => [] });
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(1);
    expect(h.out()).toContain(`atomic-agent models pull ${MODEL} --background`);
    expect(h.out()).not.toContain(SECRET);
  });

  it("mentions --judge and --isolation, and a re-run with them adds just those", async () => {
    seed();
    const first = harness();
    await setupCommand(["fusion", "--yes"], first.deps);
    expect(first.out()).toMatch(/re-run with --judge/);
    expect(first.out()).toMatch(/re-run with --isolation/);
    const again = harness();
    expect(await setupCommand(["fusion", "--yes", "--judge", "--isolation"], again.deps)).toBe(0);
    expect(fileJson().llm.runMode?.fusion).toMatchObject({ judge: "on", isolation: "worktree", autoReplan: 1 });
    expect(again.out()).not.toMatch(/autoReplan\s+\(unset\)/);
    expect(again.out()).toMatch(/judge\s+\(unset\) → "on"/);
  });

  it("an invalid config.json names the file and exits 1 without writing", async () => {
    const path = getUserConfigPath(stateDir);
    writeFileSync(path, JSON.stringify({ version: 1, llm: { activeTextProvider: 5 } }));
    const before = raw();
    const h = harness();
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(1);
    expect(h.out()).toContain(path);
    expect(h.out()).toMatch(new RegExp(`Fix or move ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(raw()).toBe(before);
  });

  it("broken JSON in config.json is reported the same way", async () => {
    writeFileSync(getUserConfigPath(stateDir), "{ not json");
    const h = harness();
    expect(await setupCommand(["fusion", "--dry-run"], h.deps)).toBe(1);
    expect(h.out()).toMatch(/is not valid JSON/);
    expect(h.out()).toContain(`Fix or move ${getUserConfigPath(stateDir)}`);
  });

  it("names the file it wrote", async () => {
    seed();
    const h = harness();
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(0);
    expect(h.out()).toContain(`Fusion is on, in ${getConfig().paths.userConfigFile}.`);
  });

  it("keeps a fusion value a newer build wrote and says so", async () => {
    seed();
    const path = getUserConfigPath(stateDir);
    const disk = JSON.parse(raw()) as { llm: Record<string, unknown> };
    disk.llm.runMode = { fusion: { escalation: "future-mode" } };
    writeFileSync(path, JSON.stringify(disk));
    const h = harness();
    expect(await setupCommand(["fusion", "--yes"], h.deps)).toBe(0);
    expect(h.out()).toMatch(/llm\.runMode\.fusion\.escalation\s+"future-mode" kept \(set by a newer version\)/);
    expect(h.out()).not.toMatch(/escalation\s+\(unset\)/);
    expect(fileJson().llm.runMode?.fusion?.escalation).toBe("future-mode");
  });

  it("usage errors exit 2", async () => {
    expect(await setupCommand([], harness().deps)).toBe(2);
    expect(await setupCommand(["nope"], harness().deps)).toBe(2);
    expect(await setupCommand(["fusion", "--bogus"], harness().deps)).toBe(2);
  });
});
