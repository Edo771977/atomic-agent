import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop, type AgentLoopEvent } from "./agent-loop.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { LlmStreamParams } from "./step-executor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import { createFusionWorkerSession } from "../session/fusion-worker-session.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { replyTool } from "../tools/conversation/reply.js";
import { finishTool } from "../tools/finish.js";
import { buildToolViewTool } from "../tools/tool-view/tool-view.js";
import { buildToolSearchTool } from "../tools/tool-search/tool-search.js";
import { buildNotesStoreTool } from "../tools/memory/notes-store.js";
import { MemoryStore } from "../memory/memory-store.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { isWorkerVisibleTool, WORKER_TOOL_ROLE } from "../tools/fusion/worker-tool-policy.js";

function completion(content: string): CompletionResult {
  return {
    content, reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0, slotId: -1, modelId: "mock",
  };
}

describe("worker tool-filter dispatch authorization", () => {
  let workingDir: string;
  let store: MemoryStore;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-worker-policy-"));
    store = new MemoryStore({ dbFile: join(workingDir, "memory.sqlite"), maxEntries: 20 });
  });
  afterEach(() => {
    store.close();
    rmSync(workingDir, { recursive: true, force: true });
  });

  async function run(first: CompletionResult, grammar = false, toolFilter = isWorkerVisibleTool, over: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {}) {
    const registry = new ToolRegistry();
    registry.register(replyTool);
    registry.register(finishTool);
    registry.register(buildToolViewTool());
    registry.register(buildToolSearchTool({ catalog: () => ({ descriptors: DEFAULT_TOOL_DESCRIPTORS, deferred: new Set(["os.git.show"]) }) }));
    registry.register(buildNotesStoreTool({ store, maxContentChars: 10_000 }));
    const forbidden = vi.fn(async () => ({ tool: "tasks.schedule", status: "ok" as const, summary: "scheduled", details: {}, truncated: false }));
    registry.register({ name: "tasks.schedule", description: "schedule", readonly: false, run: forbidden });
    const invoked: string[] = [];
    for (const name of ["os.fs.write", "os.fs.read", "fusion.delegate"]) {
      registry.register({ name, description: name, readonly: name === "os.fs.read", run: async () => {
        invoked.push(name);
        return { tool: name, status: "ok", summary: name, details: {}, truncated: false };
      } });
    }
    const requests: LlmStreamParams[] = [];
    const events: AgentLoopEvent[] = [];
    const loop = new AgentLoop({
      registry, slotManager: new SlotManager(1), grammar: 'root ::= "ok"',
      toolTransport: grammar ? "grammar" : "native_tools",
      toolCallAdapter: grammar ? null : openAiToolCallAdapter,
      supportsSlotAffinity: false,
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: { platform: "win32", arch: "x64", browserChannel: "chrome", workingDir, hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      skillCatalog: [], onEvent: event => events.push(event), ...over,
      llmComplete: async request => {
        requests.push(request);
        return requests.length === 1 ? first : completion('[{"tool":"reply","args":{"text":"done"}}]');
      },
    });
    const worker = createFusionWorkerSession({ workingDir, meta: { parentSessionId: "s-parent", taskId: "review" } });
    const outcome = await loop.runTurn(worker, {
      userMessage: "Review only.", maxSteps: 3, ephemeral: true,
      toolRole: WORKER_TOOL_ROLE, toolFilter, signal: new AbortController().signal,
    });
    const executed = events.flatMap(event =>
      event.type === "llm_event" && event.event.type === "tool_call_executed" ? [event.event.result] : [],
    );
    return { outcome, requests, executed, forbidden, invoked, events };
  }

  it.each(["native", "text", "reasoning", "grammar"] as const)("refuses excluded memory writes recovered from %s", async mode => {
    const args = { content: "Worker content must never become durable memory." };
    const batch = JSON.stringify([{ tool: "memory.notes.store", args }]);
    const first = completion(mode === "text" || mode === "grammar" ? batch : "");
    if (mode === "reasoning") first.reasoningContent = batch;
    if (mode === "native") first.toolCalls = [{ id: "hidden", type: "function", function: { name: "memory__notes__store", arguments: JSON.stringify(args) } }];
    const { outcome, requests, executed } = await run(first, mode === "grammar");
    expect(requests[0]!.tools?.some(tool => (tool as { function?: { name?: string } }).function?.name === "memory__notes__store")).not.toBe(true);
    expect(store.getDatabaseHandleForEmbeddings().prepare("SELECT content FROM memories").all()).toEqual([]);
    expect(executed[0]).toMatchObject({ tool: "memory.notes.store", status: "error", details: { tool_filter: true } });
    expect(outcome.reason).toBe("reply");
    expect(requests).toHaveLength(2);
  });

  it.each(["tasks.schedule", "tasks__schedule", "tasks_schedule", "TASKS_SCHEDULE"])("refuses the canonical excluded tool after resolving %s", async tool => {
    const { forbidden, executed, outcome } = await run(completion(JSON.stringify([{ tool, args: { userMessage: "later" } }])));
    expect(forbidden).not.toHaveBeenCalled();
    expect(executed[0]).toMatchObject({ tool: "tasks.schedule", status: "error", details: { tool_filter: true } });
    expect(outcome.reason).toBe("reply");
  });

  it.each(["memory.notes.store", "tasks.schedule", "os.screen.click"])("refuses discovery of excluded %s", async name => {
    const { executed, outcome } = await run(completion(JSON.stringify([{ tool: "tool.view", args: { name } }])));
    expect(executed[0]).toMatchObject({ tool: "tool.view", status: "error" });
    expect(executed[0]?.details.toolLoaded).toBeUndefined();
    expect(outcome.session.loadedTools.some(tool => tool.name === name)).toBe(false);
    expect(outcome.reason).toBe("reply");
  });

  it("preserves discovery of allowed out-of-role tools", async () => {
    const { executed, outcome } = await run(completion('[{"tool":"tool.view","args":{"name":"os.git.show"}}]'));
    expect(executed[0]).toMatchObject({ tool: "tool.view", status: "ok", details: { toolLoaded: { name: "os.git.show" } } });
    expect(outcome.session.loadedTools.some(tool => tool.name === "os.git.show")).toBe(true);
  });

  it("preserves a worker finish for its own ephemeral session", async () => {
    const { outcome } = await run(completion('[{"tool":"finish","args":{"summary":"done"}}]'));
    expect(outcome.reason).toBe("finish");
  });

  it("enforces a custom turn filter independently of the worker exclusion list", async () => {
    const { executed } = await run(completion('[{"tool":"tool.view","args":{"name":"os.git.show"}}]'), false, name => name !== "os.git.show");
    expect(executed[0]).toMatchObject({ tool: "tool.view", status: "error" });
    expect(executed[0]?.details.toolLoaded).toBeUndefined();
  });

  it.each([
    { emitted: "fusion.delegate", canonical: "fusion.delegate", filter: isWorkerVisibleTool },
    { emitted: "FUSION_DELEGATE", canonical: "fusion.delegate", filter: isWorkerVisibleTool },
    { emitted: "os.fs.write", canonical: "os.fs.write", filter: (name: string) => name !== "os.fs.write" },
    { emitted: "os__fs__write", canonical: "os.fs.write", filter: (name: string) => name !== "os.fs.write" },
  ])("keeps an allowed read when $emitted would be refused before approval trim", async ({ emitted, canonical, filter }) => {
    const args = canonical === "fusion.delegate" ? { tasks: [{ id: "nested", instructions: "read" }] } : { path: "audit.txt", content: "hello" };
    const first = completion(JSON.stringify([{ tool: emitted, args }, { tool: "os.fs.read", args: { path: "audit.txt" } }]));
    const { invoked, executed, events, outcome } = await run(first, false, filter);
    expect(invoked).toEqual(["os.fs.read"]);
    expect(executed.find(r => r.tool === "os.fs.read")).toMatchObject({ status: "ok" });
    expect(events.flatMap(e => e.type === "llm_event" && e.event.type === "batch_trimmed" ? [e.event] : [])).toEqual([expect.objectContaining({ kept: "os.fs.read", refused: [canonical], dropped: [] })]);
    expect(outcome.reason).toBe("reply");
  });

  it("keeps an allowed gated batch unattended when every emitted call passes the filter", async () => {
    const first = completion('[{"tool":"os.fs.write","args":{"path":"audit.txt","content":"hello"}},{"tool":"os.fs.read","args":{"path":"audit.txt"}}]');
    const { invoked, events, outcome } = await run(first, false, name => name !== "tasks.schedule", { approvalPosture: { getLevel: () => 5 } });
    expect(invoked).toEqual(["os.fs.write", "os.fs.read"]);
    expect(events.some(e => e.type === "llm_event" && e.event.type === "batch_trimmed")).toBe(false);
    expect(outcome.reason).toBe("reply");
  });

  it("does not persist a schema excluded by a custom filter through tool.search", async () => {
    const { executed, outcome } = await run(completion('[{"tool":"tool.search","args":{"query":"os.git.show","limit":1}}]'), false, name => name !== "os.git.show");
    expect(executed[0]).toMatchObject({ tool: "tool.search", status: "ok" });
    expect(executed[0]!.details.results).not.toContain("os.git.show");
    expect(outcome.session.loadedTools.some(t => t.name === "os.git.show")).toBe(false);
  });

  it("still loads an eligible out-of-role schema through tool.search", async () => {
    const { executed, outcome } = await run(completion('[{"tool":"tool.search","args":{"query":"os.git.show","limit":1}}]'));
    expect(executed[0]).toMatchObject({ tool: "tool.search", status: "ok", details: { results: ["os.git.show"] } });
    expect(outcome.session.loadedTools.some(t => t.name === "os.git.show")).toBe(true);
  });
});
