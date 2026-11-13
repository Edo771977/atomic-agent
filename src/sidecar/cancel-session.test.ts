import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as bootstrap from "../runtime/bootstrap.js";
import { bootstrapSidecar } from "./main.js";
import { getConfig, resetConfigCache } from "../config/index.js";
import { FakeBrowserBackend } from "../http/test-harness.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetConfigCache(); });

/**
 * `cancel` stops the running turn and drops what was queued behind it
 * (as the TUI's Esc does), but the session stays usable: a message sent
 * after the cancel runs.
 */
it("a cancel stops the running and queued turns without bricking the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-cancel-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  vi.stubEnv("ATOMIC_AGENT_GRAMMARS_DIR", join(process.cwd(), "grammars"));
  resetConfigCache();
  const config = getConfig();
  config.agent.compaction.auto = false;
  config.agent.nameSessions = false;
  config.memory.reflection.enabled = false;
  const completion = (content: string): CompletionResult => ({ content, reasoningContent: "", stop: true, truncated: false, timing: { promptTokens: 20, predictedTokens: 5, promptMs: 1, predictedMs: 1 }, slotId: 0, cacheHitTokens: 0, modelId: "test" });
  let calls = 0;
  const runtime = await bootstrap.createAgentRuntime({ workingDir: dir, approvalLevel: 5, overrides: {
    browserBackend: new FakeBrowserBackend(), skipLlamaHealthCheck: true,
    llamaComplete: async (p) => {
      if (/^(reflection|title|rewriter|compaction):/.test(p.sessionId)) return completion("ignored");
      calls += 1;
      if (calls === 1) {
        // The first turn hangs until it is cancelled.
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(new Error("aborted"));
          if (p.signal?.aborted) fail();
          p.signal?.addEventListener("abort", fail, { once: true });
        });
      }
      return completion('[{"tool":"reply","args":{"text":"done"}}]');
    },
  } });
  vi.spyOn(bootstrap, "createAgentRuntime").mockResolvedValue(runtime);
  vi.stubGlobal("fetch", async () => new Response('{"status":"ok"}'));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const kept = [process.stdin.listeners("data"), process.stdin.listeners("end"), process.stdout.listeners("error"), process.stdout.listeners("close")];
  const sidecar = await bootstrapSidecar();
  const responses = new Map<string, { ok: boolean; payload: unknown }>();
  vi.spyOn(sidecar.protocol, "respond").mockImplementation((id, payload, ok = true) => { responses.set(id, { ok, payload }); return { kind: "response", id: `response-${id}`, correlationId: id, ok, payload }; });
  const send = (id: string, type: string, payload: unknown) => {
    process.stdin.emit("data", JSON.stringify({ kind: "request", id, type, payload }) + "\n");
  };
  const response = async (id: string) => {
    await vi.waitFor(() => expect(responses.has(id)).toBe(true), { timeout: 5_000 });
    return responses.get(id)!;
  };
  try {
    send("start", "start_session", { workingDir: dir });
    const started = await response("start");
    expect(started.ok).toBe(true);
    const sessionId = (started.payload as { sessionId: string }).sessionId;

    send("running", "send_message", { sessionId, text: "first" });
    await vi.waitFor(() => expect(calls).toBe(1));
    send("queued", "send_message", { sessionId, text: "second" });
    send("cancel", "cancel", { sessionId });
    expect(await response("cancel")).toEqual({ ok: true, payload: { cancelled: true } });
    expect(await response("running")).toMatchObject({ ok: true, payload: { reason: "cancelled" } });
    expect((await response("queued")).ok).toBe(false);

    send("after", "send_message", { sessionId, text: "third" });
    expect(await response("after")).toMatchObject({ ok: true, payload: { reason: "reply" } });
  } finally {
    const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
    ["data", "end", "error", "close"].forEach((event, i) => {
      for (const listener of streams[i]!.listeners(event)) if (!kept[i]!.includes(listener)) streams[i]!.removeListener(event, listener as () => void);
    });
    await sidecar.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
