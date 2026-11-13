import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import { resolvePidFilePath, writeLaunchRecord } from "../../local-llm/index.js";
import { buildGrammar } from "../../llm/grammar/build-grammar.js";
import { QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import type { CompletionRequest, CompletionResult } from "../../llm/provider/completion-types.js";
import {
  createFusionFormatProbeFor,
  managedServerGeneration,
  type FusionFormatCheckDeps,
} from "./fusion-format-check.js";

function result(content: string): CompletionResult {
  return {
    content,
    stop: true,
    truncated: false,
    timing: { promptTokens: 60, predictedTokens: 12, promptMs: 1, predictedMs: 1 },
  } as CompletionResult;
}

async function probeFor(
  complete = vi.fn(async (_id: string, _r: CompletionRequest) => result('[{"tool":"reply","args":{"text":"ok"}}]')),
  over: Partial<FusionFormatCheckDeps> = {},
) {
  const main = getConfig().localModels.url;
  const grammar = await buildGrammar(QWEN_THINK_PROFILE);
  const make = createFusionFormatProbeFor({
    getConfig,
    providers: () => [
      { id: "local-llama", kind: "llama-server" },
      { id: "same-llama", kind: "llama-server", url: `${main}/` },
      { id: "second-llama", kind: "llama-server", url: "http://127.0.0.1:1" },
      { id: "openrouter", kind: "openrouter" },
    ],
    complete,
    getGrammar: () => grammar,
    getProfile: () => QWEN_THINK_PROFILE,
    getModelId: () => "worker-model",
    getServerGeneration: () => null,
    ...over,
  });
  return { make, complete, main };
}

describe("createFusionFormatProbeFor", () => {
  it("asks only a llama-server leg on the main local server", async () => {
    const { make } = await probeFor();
    expect(make("openrouter")).toBeUndefined();
    expect(make("second-llama")).toBeUndefined();
    expect(make("missing")).toBeUndefined();
    expect(make("local-llama")).toBeDefined();
    expect(make("same-llama")).toBeDefined();
  });

  it("keys the verdict by server, model, profile and launch, and sends through the leg's provider", async () => {
    const { make, complete, main } = await probeFor();
    const probe = make("local-llama")!;
    expect(probe.key).toBe(
      [main.replace(/\/+$/, ""), "worker-model", "qwen-think", "external"].join("\u0000"),
    );
    expect(make("same-llama")!.key).toBe(probe.key);
    const controller = new AbortController();
    expect(await probe.run(controller.signal)).toEqual({ kind: "pass" });
    expect(complete).toHaveBeenCalledOnce();
    const [providerId, request] = complete.mock.calls[0]!;
    expect(providerId).toBe("local-llama");
    expect(request.sessionId).toBe("grammar-smoke:local-llama");
    expect(request.maxTokens).toBe(48);
    expect(request.signal?.aborted).toBe(false);
  });

  it("asks afresh after a daemon restart, and keeps nothing for an unknown model", async () => {
    let generation: string | null = "4242@1000";
    let modelId: string | null = "worker-model";
    const { make } = await probeFor(undefined, {
      getServerGeneration: () => generation,
      getModelId: () => modelId,
    });
    const before = make("local-llama")!.key;
    expect(before).toContain("4242@1000");
    generation = "4243@2000";
    expect(make("local-llama")!.key).not.toBe(before);
    modelId = null;
    expect(make("local-llama")!.key).toBeNull();
  });
});

describe("managedServerGeneration", () => {
  it("reads the live daemon's launch record; none for an external server or a stale record", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "format-check-gen-"));
    try {
      const config = (mode: "managed" | "external") =>
        ({ localModels: { mode }, paths: { localModelsDataDir: dataDir } }) as unknown as AtomicAgentConfig;
      expect(managedServerGeneration(config("managed"))).toBeNull();
      writeFileSync(resolvePidFilePath(dataDir), String(process.pid));
      writeLaunchRecord(dataDir, {
        pid: process.pid,
        modelId: "m",
        contextSize: 8192,
        swaFull: false,
        prefixReuse: null,
        launchedAt: 1234,
      });
      expect(managedServerGeneration(config("managed"))).toBe(`${process.pid}@1234`);
      expect(managedServerGeneration(config("external"))).toBeNull();
      // A record left by another pid is not this daemon's.
      writeLaunchRecord(dataDir, {
        pid: process.pid + 1,
        modelId: "m",
        contextSize: 8192,
        swaFull: false,
        prefixReuse: null,
        launchedAt: 99,
      });
      expect(managedServerGeneration(config("managed"))).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
