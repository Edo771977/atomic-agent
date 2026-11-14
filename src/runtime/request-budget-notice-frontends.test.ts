import { describe, expect, it } from "vitest";
import { formatAgentEvent } from "../cli/run-agent.js";
import { buildStreamEventHook } from "../http/openai-chat-completions.js";
import { reduceTuiState } from "../tui/agent-event-reducer.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui/tui-state.js";

const notice = { type: "budget_notice", sessionId: "chat", providerId: "cloud", reason: "soft", text: "Daily spend limit: this provider uses an assumed output bound." } as const;

describe("budget notice frontend presentation", () => {
  it("prints a CLI diagnostic without treating it as an assistant reply", () => {
    expect(formatAgentEvent(notice as never)).toBe(`» ${notice.text}`);
  });

  it("adds a visible warning to its TUI chat and filters other sessions", () => {
    const state = createInitialTuiState({ sessionId: "chat", workingDir: "/fixture", llamaUrl: "", browserChannel: "chrome", browserHeadless: true,
      approvalLevel: 5, maxSteps: 10, completionMaxTokens: 2048, skillCount: 0, localBackendConfigured: false } as TuiSessionInfo);
    const local = reduceTuiState(state, { type: "agent_event", sessionId: "chat", event: notice as never });
    expect(local.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system", variant: "warn", text: notice.text })]));
    const other = reduceTuiState(state, { type: "agent_event", sessionId: "other", event: { ...notice, sessionId: "other" } as never });
    expect(other.messages).toEqual(state.messages);
  });

  it.each([false, true])("uses an extensions frame only when the HTTP client opts in (%s)", extensionsEnabled => {
    const frames: unknown[] = [];
    const writer = { closed: false, writeEvent: (name: string, payload: unknown) => { frames.push({ name, payload }); } };
    const env = { completionId: "cmpl", created: 0, session: { id: "chat" }, request: { model: "atomic-agent", extensionsEnabled } };
    buildStreamEventHook(writer as never, env as never)(notice as never);
    expect(frames).toEqual(extensionsEnabled ? [{ name: "budget_notice", payload: { object: "atomic.budget_notice", session_id: "chat", provider_id: "cloud", reason: "soft", notice: notice.text } }] : []);
  });
});
