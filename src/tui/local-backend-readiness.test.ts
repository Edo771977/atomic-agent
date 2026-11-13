import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "../local-llm/index.js";
import {
  persistUserLocalLlmUrl,
  persistUserLocalModelsConfig,
} from "./persist-user-local-models-config.js";
import {
  isCloudTextProviderReady,
  isLocalBackendConfigured,
} from "./local-backend-readiness.js";

describe("isCloudTextProviderReady", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "startup-gate-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.OPENROUTER_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.OPENROUTER_API_KEY;
    resetConfigCache();
  });

  it("treats an active cloud text provider with an env key as ready", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openrouter/auto",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("treats an active keyless local preset entry as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama",
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("resolves suffixed preset entry ids to their local preset", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama-2",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama-2",
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("treats a subscription-cli entry as ready with no key and no base URL", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "claude-cli",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "claude-cli",
            kind: "subscription-cli",
            defaultChatModel: "sonnet",
            subscriptionCli: { cli: "claude" },
          },
        ],
      },
    });
    resetConfigCache();

    // Neither existing check can see this entry: there is no API key and
    // no loopback base URL. Without the CLI-auth branch the user would
    // land in the local-model wizard on every single start.
    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("still refuses a keyless remote entry that is not CLI-backed", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "remote-compat",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "remote-compat",
            kind: "openai-compatible",
            baseUrl: "https://api.example.invalid",
            defaultChatModel: "some-model",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });

  it("treats a remote entry whose key rides in a hand-set header as ready", () => {
    // The same key rule the fallback chain reads: a credential header is a
    // key the provider sends, so the entry is not "keyless".
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "remote-compat",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "remote-compat",
            kind: "openai-compatible",
            baseUrl: "https://api.example.invalid",
            defaultChatModel: "some-model",
            headers: { Authorization: "Bearer sk-test" },
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("treats a manual keyless entry with a loopback base URL as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "my-ollama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "my-ollama",
            kind: "openai-compatible",
            baseUrl: "http://127.0.0.1:11434",
            defaultChatModel: "qwen3.6",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("does not treat a keyless remote openai-compatible entry as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "groq",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "groq",
            kind: "openai-compatible",
            baseUrl: "https://api.groq.com/openai",
            defaultChatModel: "llama-3.3-70b-versatile",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });

  it("does not treat keyless Ollama Cloud as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "ollama-cloud",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "ollama-cloud",
            kind: "openai-compatible",
            baseUrl: "https://ollama.com",
            defaultChatModel: "qwen3.6:cloud",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });

  it("treats a keyless openai-compatible server on another computer on the network as ready (ATO-1066)", () => {
    // A server on another computer on this network needs no key of its
    // own (provider-key.ts `not-needed`), so an operator who made it the
    // active provider is routed at it and the startup gate returns early,
    // as it does for a keyed or loopback entry. Before ATO-1066 such an
    // entry counted as unready, the gate stayed open and the wizard's
    // "Remote llama.cpp" choice could re-route chat at local-llama.
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "lan-compat",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "lan-compat",
            kind: "openai-compatible",
            baseUrl: "http://192.168.1.50:8080/v1",
            defaultChatModel: "some-model",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(true);
  });

  it("does not treat an active cloud text provider without a key as ready", () => {
    const cfg = getConfig();
    const file = ensureUserConfigFileSync(cfg.paths.userConfigFile);
    writeUserConfigFileSync(cfg.paths.userConfigFile, {
      ...file,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: cfg.localModels.url },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openrouter/auto",
          },
        ],
      },
    });
    resetConfigCache();

    expect(isCloudTextProviderReady()).toBe(false);
  });
});

describe("isLocalBackendConfigured", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "startup-gate-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("says no on a fresh install nobody has configured", () => {
    expect(isLocalBackendConfigured()).toBe(false);
  });

  it("still says no in managed mode while no model has been pulled", () => {
    // Picking "Local models" writes the mode before any weights exist, so
    // there is no server yet that could be reported as unreachable.
    persistUserLocalModelsConfig({ mode: "managed" });

    expect(isLocalBackendConfigured()).toBe(false);
  });

  it("says yes in managed mode once a model is selected", () => {
    persistUserLocalModelsConfig({
      mode: "managed",
      managed: { modelId: "qwen-3.5-4b" },
    });

    expect(isLocalBackendConfigured()).toBe(true);
  });

  it("says yes once a managed model is selected, even in external mode", () => {
    persistUserLocalModelsConfig({ managed: { modelId: "qwen-3.5-4b" } });

    expect(getConfig().localModels.mode).toBe("external");
    expect(isLocalBackendConfigured()).toBe(true);
  });

  it("says yes once the user typed their own llama-server URL", () => {
    persistUserLocalLlmUrl("http://192.168.1.50:9090");

    expect(isLocalBackendConfigured()).toBe(true);
  });

  it("keeps saying no when the URL was rewritten to the shipped default", () => {
    persistUserLocalLlmUrl("http://192.168.1.50:9090");
    persistUserLocalLlmUrl("http://127.0.0.1:9931");

    expect(isLocalBackendConfigured()).toBe(false);
  });

  it("keeps saying no on an untouched install whose first run wrote the old 8080 default", () => {
    // Every first run writes the defaults to config.json, so installs from
    // before llama.cpp moved to 9931 carry 8080 without anyone choosing it.
    persistUserLocalLlmUrl("http://127.0.0.1:8080");

    expect(getConfig().localModels.url).toBe("http://127.0.0.1:8080");
    expect(isLocalBackendConfigured()).toBe(false);
  });

  it("does not count the embeddings daemon as a chat backend choice", () => {
    persistUserLocalModelsConfig({
      embeddings: { enabled: true, modelId: DEFAULT_EMBEDDING_MODEL_ID },
    });

    expect(isLocalBackendConfigured()).toBe(false);
  });
});
