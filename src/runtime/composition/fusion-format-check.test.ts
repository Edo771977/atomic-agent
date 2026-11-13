import { describe, expect, it, vi } from "vitest";

import { getConfig } from "../../config/index.js";
import { buildGrammar } from "../../llm/grammar/build-grammar.js";
import { QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import type { CompletionRequest, CompletionResult } from "../../llm/provider/completion-types.js";
import { createFusionFormatProbeFor } from "./fusion-format-check.js";

function result(content: string): CompletionResult {
  return {
    content,
    stop: true,
    truncated: false,
    timing: { promptTokens: 60, predictedTokens: 12, promptMs: 1, predictedMs: 1 },
  } as CompletionResult;
}

async function probeFor(complete = vi.fn(async (_id: string, _r: CompletionRequest) => result('[{"tool":"reply","args":{"text":"ok"}}]'))) {
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

  it("keys the verdict by server, model and profile, and sends through the leg's provider", async () => {
    const { make, complete, main } = await probeFor();
    const probe = make("local-llama")!;
    expect(probe.key).toBe([main.replace(/\/+$/, ""), "worker-model", "qwen-think"].join("\u0000"));
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
});
