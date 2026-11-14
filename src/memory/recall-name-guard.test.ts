import { describe, expect, it } from "vitest";

import type {
  GroundingConversation,
  GroundingConversationSource,
} from "./name-grounding.js";
import { createRecallNameGuard, noteUserMessagesTo } from "./recall-name-guard.js";

/** Stored conversations made of these user messages, one per conversation. */
function sourceOf(userTexts: string[]): {
  source: GroundingConversationSource;
  walks: () => number;
} {
  let walks = 0;
  const source: GroundingConversationSource = async function* walk() {
    walks += 1;
    let updatedAt = 1_000;
    for (const text of userTexts) {
      const conversation: GroundingConversation = { updatedAt, texts: [text] };
      updatedAt -= 1;
      yield conversation;
    }
  };
  return { source, walks: () => walks };
}

describe("createRecallNameGuard (ATO-321)", () => {
  it("lets rows that claim no name through without any check", () => {
    const { source, walks } = sourceOf(["hello"]);
    const guard = createRecallNameGuard({ source });
    expect(guard.allows("User prefers dark mode in the editor")).toBe(true);
    expect(walks()).toBe(0);
  });

  it("holds out a name nobody typed after the check", async () => {
    const guard = createRecallNameGuard({
      source: sourceOf(["fix the build please", "thanks"]).source,
    });
    const report = await guard.prefetch(["I am Alex and I like Rust"]);
    expect(report).toMatchObject({ names: 1, ungrounded: 1 });
    expect(guard.allows("I am Alex and I like Rust")).toBe(false);
    expect(guard.allows("The user is Alex.")).toBe(false);
  });

  it("lets a name the user did write through", async () => {
    const guard = createRecallNameGuard({
      source: sourceOf(["hi, my name is Sam", "run the tests"]).source,
    });
    await guard.prefetch(["The user is Sam."]);
    expect(guard.allows("The user is Sam.")).toBe(true);
  });

  it("holds an unchecked name out and checks it in the background", async () => {
    const guard = createRecallNameGuard({ source: sourceOf(["I'm Sam"]).source });
    expect(guard.allows("The user is Sam.")).toBe(false);
    // The background check settles on its own; prefetch reuses it.
    await guard.prefetch(["The user is Sam."]);
    expect(guard.allows("The user is Sam.")).toBe(true);
  });

  it("checks each name once", async () => {
    const { source, walks } = sourceOf(["nothing here"]);
    const guard = createRecallNameGuard({ source });
    await guard.prefetch(["I am Alex.", "The user is Alex.", "I am Alex."]);
    guard.allows("I am Alex.");
    guard.allows("i am alex.");
    expect(walks()).toBe(1);
  });

  it("holds the row out when the check throws", async () => {
    const failing: GroundingConversationSource = () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error("db closed")),
        };
      },
    });
    const guard = createRecallNameGuard({ source: failing });
    const report = await guard.prefetch(["The user is Alex."]);
    expect(report.failed).toBe(1);
    expect(guard.allows("The user is Alex.")).toBe(false);
  });

  it("covers Russian notes too", async () => {
    const guard = createRecallNameGuard({
      source: sourceOf(["сделай макет для блока", "спасибо"]).source,
    });
    await guard.prefetch(["Пользователь Анна любит короткие ответы"]);
    expect(guard.allows("Пользователь Анна любит короткие ответы")).toBe(false);
  });
  describe("a name the user types later in the same process", () => {
    it("lets a cached-ungrounded name through once a new user message carries it", async () => {
      const { source, walks } = sourceOf(["fix the build please"]);
      const guard = createRecallNameGuard({ source });
      await guard.prefetch(["The user is Alex."]);
      expect(guard.allows("The user is Alex.")).toBe(false);
      guard.noteUserMessage("hi, I'm Alex by the way");
      expect(guard.allows("The user is Alex.")).toBe(true);
      // Grounded from the message itself: no new walk of the store.
      expect(walks()).toBe(1);
    });

    it("keeps an ungrounded name out when the new message does not carry it", async () => {
      const guard = createRecallNameGuard({ source: sourceOf(["hello"]).source });
      await guard.prefetch(["The user is Alex."]);
      guard.noteUserMessage("run the tests again");
      expect(guard.allows("The user is Alex.")).toBe(false);
    });

    it("does not let a check that was already running overwrite the grounded verdict", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const slow: GroundingConversationSource = async function* walk() {
        await gate;
        yield { updatedAt: 1, texts: ["nothing here"] };
      };
      const guard = createRecallNameGuard({ source: slow });
      const pending = guard.prefetch(["The user is Alex."]);
      guard.noteUserMessage("my name is Alex");
      release();
      await pending;
      expect(guard.allows("The user is Alex.")).toBe(true);
    });

    it("retries a failed check after a new user message", async () => {
      let fail = true;
      const flaky: GroundingConversationSource = async function* walk() {
        if (fail) throw new Error("db busy");
        yield { updatedAt: 1, texts: ["I'm Sam"] };
      };
      const guard = createRecallNameGuard({ source: flaky });
      expect((await guard.prefetch(["The user is Sam."])).failed).toBe(1);
      fail = false;
      guard.noteUserMessage("run the tests");
      expect(guard.allows("The user is Sam.")).toBe(false);
      await guard.prefetch(["The user is Sam."]);
      expect(guard.allows("The user is Sam.")).toBe(true);
    });
  });
  describe("noteUserMessagesTo", () => {
    const signal = new AbortController().signal;
    const empty = { recalled: [], index: [] };

    it("hands the turn's own user message to the guard before recall, never an inner rewrite", async () => {
      const guard = createRecallNameGuard({ source: sourceOf(["hello"]).source });
      await guard.prefetch(["The user is Alex."]);
      const allowedInside: boolean[] = [];
      // Stands in for the rewriter: inner layers get model-written text.
      const provider = noteUserMessagesTo(guard, {
        buildMemoryContext: async () => {
          allowedInside.push(guard.allows("The user is Alex."));
          return empty;
        },
      });
      await provider.buildMemoryContext({ sessionId: "s", userMessage: "what was that?", signal });
      await provider.buildMemoryContext({ sessionId: "s", userMessage: null, signal });
      await provider.buildMemoryContext({ sessionId: "s", userMessage: "I'm Alex, hi", signal });
      expect(allowedInside).toEqual([false, false, true]);
    });

    it("keeps recall up when the guard throws", async () => {
      const provider = noteUserMessagesTo(
        { allows: () => true, noteUserMessage: () => { throw new Error("boom"); } },
        { buildMemoryContext: async () => empty },
      );
      await expect(
        provider.buildMemoryContext({ sessionId: "s", userMessage: "hi", signal }),
      ).resolves.toEqual(empty);
    });
  });
});
