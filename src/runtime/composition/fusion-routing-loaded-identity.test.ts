import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ProviderRegistry } from "../../llm/provider/registry/provider-registry.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import * as fusionTools from "../../tools/fusion/index.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/registry/provider-types.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { DeclaredInputsRegistry } from "../../tools/os/index.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import type { TaskOutcomeRecord } from "../../tools/fusion/outcome-log.js";
import { configuredFusionRoutingIdentity } from "./fusion-routing-identity.js";
import { registerRuntimeFusionAndReadScope } from "./runtime-tool-catalog.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetConfigCache(); });

describe("loaded provider identity at Fusion dispatch", () => {
  it("attributes the actual adapter model and endpoint only after a successful registry reload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fusion-loaded-identity-"));
    const wire: Array<{ url: string; model: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const body = JSON.parse(String(options?.body)) as { model: string };
      wire.push({ url: String(url), model: body.model });
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const config = getConfig();
      const live: LlmProviderConfigEntry = { id: "worker", kind: "openai-compatible", baseUrl: "https://old-endpoint.invalid/v1", defaultChatModel: "actual-a" };
      const original = { ...live };
      config.llm = { providers: [live], activeTextProvider: "worker", activeEmbeddingProvider: "worker", toolTransport: "auto" };
      const factoryContext = { config, logger, llamaClient: {} as never, getProfile: () => ({}) as never };
      const providers = await ProviderRegistry.fromConfig(config, factoryContext);
      const tools = new ToolRegistry();
      const approvals = new ApprovalGate({ emit: () => {}, level: 5 });
      const logged: TaskOutcomeRecord[] = [];
      let minted = 0;
      registerRuntimeFusionAndReadScope({ config, toolRegistry: tools, approvals, dangerous: { approvals, approvalRequired: false },
        declaredInputs: new DeclaredInputsRegistry(), resolveOriginalRequest: () => undefined,
        runTurn: async (session, _message, options) => {
          await providers.getProvider(options.providerId!)!.complete({ prompt: "fixture", maxOutputTokens: 10, signal: options.signal });
          return { session, reason: "reply", stepCount: 1 };
        },
        createEphemeralSession: (meta) => createEmptySessionState({ id: `s-w-loaded-${++minted}`, workingDir: cwd, metadata: { fusionWorker: { ...meta } } }),
        prepareLocalLink: async () => {}, emitAgentLoopEventFor: () => {},
        resolveCurrentRunMode: () => ({ stored: "fusion", effective: "fusion", workerProviderId: "worker", workerModel: "display-small",
          orchestratorProviderId: "strong", orchestratorModel: "display-big", primaryProviderId: "strong", workers: 1, workersPinned: true,
          workerMaxSteps: 2, workerTimeoutMs: 60_000, degraded: null }),
        providerRegistry: providers, llama: { measuredTokensPerSecond: () => null, fetchSlots: async () => ({ slots: [] }), probeHealth: async () => "answered" },
        slotManager: { poolSize: () => 2 }, workingDir: cwd, logger, outcomeLog: { append: (rows) => { for (const row of rows) if (row.type === "task") logged.push(row); } },
      });
      const execute = () => tools.get("fusion.delegate")!.run({ tasks: [{ id: "task", title: "Fixture", instructions: "work", model: "display-small" }],
        contract: { checks: [{ task: "task", kind: "command", cmd: process.execPath, args: ["-e", "process.exit(0)"] }] },
      }, { workingDir: cwd, sessionId: `parent-${minted}`, stepIndex: 0, signal: new AbortController().signal });

      expect((await execute()).status).toBe("ok");
      expect(logged.at(-1)).toMatchObject({ acceptance: "checks-passed", routingIdentity: configuredFusionRoutingIdentity(original) });

      // The file/cache changes first; merge deliberately does not replace a loaded id.
      for (const pending of [{ defaultChatModel: "actual-a", baseUrl: "https://new-endpoint.invalid/v1" },
        { defaultChatModel: "actual-b", baseUrl: "https://old-endpoint.invalid/v1" },
        { defaultChatModel: "actual-b", baseUrl: "https://new-endpoint.invalid/v1" }]) {
        Object.assign(live, pending);
        await providers.mergeProvidersFromConfig(config, factoryContext);
        expect((await execute()).status).toBe("ok");
        expect(wire.at(-1)).toEqual({ url: "https://old-endpoint.invalid/v1/chat/completions", model: "actual-a" });
        expect(logged.at(-1)?.routingIdentity).toBeUndefined();
      }

      // A failed factory must not publish the pending identity either.
      live.defaultChatModel = undefined;
      await expect(providers.replaceProviderFromConfig("worker", config, factoryContext)).rejects.toThrow(/defaultChatModel/);
      expect(providers.getLoadedEntrySnapshot("worker")).toMatchObject(original);
      live.defaultChatModel = "actual-b";
      await providers.replaceProviderFromConfig("worker", config, factoryContext);
      expect((await execute()).status).toBe("ok");
      expect(wire.at(-1)).toEqual({ url: "https://new-endpoint.invalid/v1/chat/completions", model: "actual-b" });
      expect(logged.at(-1)?.routingIdentity).toBe(configuredFusionRoutingIdentity(live));
      expect(logged.at(-1)?.routingIdentity).not.toBe(configuredFusionRoutingIdentity(original));

      // Caller mutations of either the input or a returned snapshot cannot rewrite loaded state.
      const loaded = { ...providers.getLoadedEntrySnapshot("worker") };
      live.defaultChatModel = "unloaded-c";
      live.baseUrl = "https://unloaded-endpoint.invalid/v1";
      const returned = providers.getLoadedEntrySnapshot("worker")!;
      Object.assign(returned, { defaultChatModel: "forged", baseUrl: "https://forged.invalid" });
      expect(providers.getLoadedEntrySnapshot("worker")).toEqual(loaded);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("uses the actual managed text client binding, including overrides and dynamic default endpoints", async () => {
    const config = getConfig();
    config.localModels.mode = "managed";
    config.localModels.managed.modelId = "known-managed";
    config.localModels.url = "http://old-local.invalid:8080";
    // entry.url binds vision; the text client can be bound elsewhere.
    const entry = { id: "worker", kind: "llama-server", url: "http://vision-only.invalid:8081" };
    config.llm = { providers: [entry], activeTextProvider: "worker", activeEmbeddingProvider: "worker", toolTransport: "auto" };
    const wire: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      wire.push(String(url));
      return new Response(JSON.stringify({ content: "done", stop: true, tokens_evaluated: 1, tokens_predicted: 1, model: "known-managed" }),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new LlamaServerClient({ baseUrl: config.localModels.url, fetchImpl });
    const context = { config, logger, llamaClient: client, getProfile: () => PLAIN_INSTRUCT_PROFILE, getModelId: () => "known-managed" };
    const providers = await ProviderRegistry.fromConfig(config, context);
    const builder = vi.spyOn(fusionTools, "buildFusionDelegateTool");
    const approvals = new ApprovalGate({ emit: () => {}, level: 5 });
    registerRuntimeFusionAndReadScope({ config, toolRegistry: new ToolRegistry(), approvals, dangerous: { approvals, approvalRequired: false },
      declaredInputs: new DeclaredInputsRegistry(), resolveOriginalRequest: () => undefined,
      runTurn: async () => { throw new Error("No worker inference expected"); },
      createEphemeralSession: (meta) => createEmptySessionState({ id: "s-w-local", workingDir: process.cwd(), metadata: { fusionWorker: meta } }),
      prepareLocalLink: async () => {}, emitAgentLoopEventFor: () => {}, resolveCurrentRunMode: () => ({ stored: "fusion", effective: "fusion",
        workerProviderId: "worker", workerModel: "display-local", orchestratorProviderId: "strong", orchestratorModel: "big", primaryProviderId: "strong",
        workers: 1, workersPinned: true, workerMaxSteps: 2, workerTimeoutMs: 60_000, degraded: null }),
      providerRegistry: providers, llama: { measuredTokensPerSecond: () => null, fetchSlots: async () => ({ slots: [] }), probeHealth: async () => "answered" },
      slotManager: { poolSize: () => 2 }, workingDir: process.cwd(), logger,
    });
    const identityFor = builder.mock.calls.at(-1)![0].resolveRoutingIdentity!;
    const expected = () => configuredFusionRoutingIdentity({ ...entry, url: config.localModels.url }, { mode: config.localModels.mode,
      url: config.localModels.url, configuredModelId: config.localModels.managed.modelId, liveModelId: "known-managed" });
    await providers.getProvider("worker")!.complete({ prompt: "fixture", maxOutputTokens: 10 });
    expect(wire.at(-1)).toBe("http://old-local.invalid:8080/completion");
    expect(identityFor("worker")).toBe(expected());
    expect(identityFor("worker")).toMatch(/^[a-f0-9]{64}$/);
    config.localModels.url = "http://new-local.invalid:8080";
    entry.url = config.localModels.url;
    await providers.getProvider("worker")!.complete({ prompt: "fixture", maxOutputTokens: 10 });
    expect(wire.at(-1)).toBe("http://old-local.invalid:8080/completion");
    expect(identityFor("worker")).toBeUndefined();
    await providers.replaceProviderFromConfig("worker", config, { ...context, llamaClient: new LlamaServerClient({ fetchImpl }) });
    await providers.getProvider("worker")!.complete({ prompt: "fixture", maxOutputTokens: 10 });
    expect(wire.at(-1)).toBe("http://new-local.invalid:8080/completion");
    expect(identityFor("worker")).toBe(expected());
    config.localModels.mode = "external";
    expect(identityFor("worker")).toBeUndefined();
  });
});
