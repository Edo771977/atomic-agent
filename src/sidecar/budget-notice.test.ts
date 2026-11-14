import { afterEach, expect, it, vi } from "vitest";
import * as bootstrap from "../runtime/bootstrap.js";
import * as configuration from "../config/index.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import { bootstrapSidecar } from "./main.js";

afterEach(() => vi.restoreAllMocks());

it("forwards budget advice only for the sidecar's active session", async () => {
  const config = configuration.loadConfig();
  config.llm = { activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto", providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://paid.invalid" }] };
  vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  let forward: ((event: AgentLoopEvent) => void) | undefined;
  vi.spyOn(bootstrap, "createAgentRuntime").mockImplementation(async options => {
    forward = event => options.handlers?.onAgentEvent?.(event, "chat");
    return { createSession: () => ({ id: "chat" }), shutdown: async () => {} } as unknown as bootstrap.AgentRuntime;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
  const names = ["data", "end", "error", "close"];
  const kept = names.map((name, i) => streams[i]!.listeners(name));
  const sidecar = await bootstrapSidecar();
  const emitted = vi.spyOn(sidecar.protocol, "emitEvent");
  const responded = vi.spyOn(sidecar.protocol, "respond");
  try {
    process.stdin.emit("data", JSON.stringify({ kind: "request", id: "start", type: "start_session", payload: { workingDir: process.cwd() } }) + "\n");
    await vi.waitFor(() => expect(responded).toHaveBeenCalledWith("start", { sessionId: "chat" }));
    const notice = { type: "budget_notice", sessionId: "chat", providerId: "cloud", reason: "soft", text: "Budget uses an assumed output bound." } as const;
    forward?.(notice);
    forward?.({ ...notice, sessionId: "other" });
    expect(emitted.mock.calls.filter(([name]) => name === "budget_notice")).toEqual([["budget_notice", notice]]);
  } finally {
    for (let i = 0; i < names.length; i++) {
      for (const listener of streams[i]!.listeners(names[i]!)) {
        if (!kept[i]!.includes(listener)) streams[i]!.removeListener(names[i]!, listener as () => void);
      }
    }
    await sidecar.shutdown();
  }
});
