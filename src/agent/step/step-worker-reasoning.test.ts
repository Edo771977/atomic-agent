import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { executeStep } from "../step-executor.js";
import type { LlmStreamParams } from "./step-contract.js";
import { resolveStepGrammar } from "./step-inference.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { SlotManager } from "../../llm/slot-manager.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
  type ModelProfile,
} from "../../llm/model-profile.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { buildGrammar } from "../../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { BuiltPrompt } from "../../prompt/build-prompt.js";
import type { StepEvent } from "../step-events.js";

/**
 * A local fusion worker's think-block bound (`ctx.reasoningBudgetTokens`)
 * rides on the per-request grammar only: the prompt bytes, the base
 * grammar, the forced final step and `thinking: off` are as before.
 */
const grammarsDir = join(process.cwd(), "grammars");

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ["os.fs.read", "reply", "finish"]) {
    reg.register({
      name,
      description: name,
      readonly: true,
      async run() {
        return compressToolResult({ tool: name, status: "ok", output: name });
      },
    });
  }
  return reg;
}

interface StepRun {
  params: LlmStreamParams;
  baseGrammar: string;
  prompt: BuiltPrompt;
  /** `reasoningBoundTokens` on the step's `llm_completed`; `null` when absent. */
  reportedBound: number | null;
}

async function runStep(
  ctxExtra: Partial<Parameters<typeof executeStep>[0]>,
  baseBudgetTokens = 0,
  opts: {
    profile?: ModelProfile;
    toolTransport?: "grammar" | "native_tools";
    /** Stamped on the completion, as the fallback seam does for the link that served. */
    served?: Pick<CompletionResult, "servedTransport">;
    content?: string;
  } = {},
): Promise<StepRun> {
  const profile = opts.profile ?? QWEN_THINK_PROFILE;
  const grammar = await buildGrammar(profile, grammarsDir, {
    reasoningBudgetTokens: baseBudgetTokens,
  });
  const seen: LlmStreamParams[] = [];
  let prompt: BuiltPrompt | undefined;
  let reportedBound: number | null | undefined;
  await executeStep(
    {
      session: createEmptySessionState({ id: "s-worker-reasoning", workingDir: "/w" }),
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: {
        platform: "darwin", arch: "arm64", browserChannel: "chrome",
        workingDir: "/w", hasClipboard: false, hasWmctrl: false, hasNotifications: false,
      },
      skillCatalog: [],
      stepIndex: 0,
      signal: new AbortController().signal,
      userMessage: "x",
      ...ctxExtra,
    },
    {
      registry: registry(),
      slotManager: new SlotManager(2),
      llmComplete: async (params) => {
        seen.push(params);
        return {
          ...opts.served,
          content: opts.content ?? `</think>${JSON.stringify([{ tool: "reply", args: { text: "done" } }])}`,
          reasoningContent: "",
          stop: true,
          truncated: false,
          timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
          cacheHitTokens: 0,
          slotId: 0,
          modelId: "mock",
        };
      },
      onEvent: (event: StepEvent) => {
        if (event.type === "prompt_built") prompt ??= event.prompt;
        if (event.type === "llm_completed") reportedBound ??= event.reasoningBoundTokens ?? null;
      },
      grammar,
      profile,
      toolTransport: opts.toolTransport ?? "grammar",
      toolCallAdapter: null,
      supportsSlotAffinity: true,
    },
  );
  return { params: seen[0]!, baseGrammar: grammar, prompt: prompt!, reportedBound: reportedBound ?? null };
}

/** The head line of the think body in a grammar. */
function bodyHead(grammar: string): string | undefined {
  return grammar.split("\n").find((line) => line.startsWith("think-body ::= "));
}

describe("a local fusion worker's reasoning bound on the per-request grammar", () => {
  it("bounds a worker step that the base grammar leaves unbounded", async () => {
    const plain = await runStep({});
    expect(bodyHead(plain.params.grammar)).toBe("think-body ::= think-fragment*");
    expect(plain.params.grammar).toBe(plain.baseGrammar);

    const worker = await runStep({ reasoningBudgetTokens: 1_536 });
    // 1,536 tokens × 4 = 6,144 characters, chained under llama.cpp's
    // 1,999-repeat limit.
    expect(bodyHead(worker.params.grammar)).toBe(
      "think-body ::= think-char{0,1998} | think-char{1999} think-body-2",
    );
    expect(worker.params.grammar).toContain("think-body-4 ::= think-char{0,147}");
    expect(worker.params.grammar).toContain("think-char ::= [^<]");
    // The base grammar is the same one; only the request differs.
    expect(worker.baseGrammar).toBe(plain.baseGrammar);
  });

  it("leaves the prompt bytes, stable prefix included, unchanged", async () => {
    const plain = await runStep({});
    const worker = await runStep({ reasoningBudgetTokens: 512 });
    expect(worker.params.prompt).toBe(plain.params.prompt);
    expect(worker.prompt.stablePrefix).toBe(plain.prompt.stablePrefix);
    expect(worker.prompt.stablePrefix).not.toContain("think-char");
  });

  it("replaces a configured base bound with the worker's own", async () => {
    const worker = await runStep({ reasoningBudgetTokens: 256 }, 4_000);
    expect(bodyHead(worker.params.grammar)).toBe("think-body ::= think-char{0,1024}");
    expect(worker.params.grammar).not.toMatch(/^think-body-\d+ ::= /m);
  });

  it("keeps the forced final step unbounded", async () => {
    const worker = await runStep({ reasoningBudgetTokens: 512, terminalOnly: true });
    expect(bodyHead(worker.params.grammar)).toBe("think-body ::= think-fragment*");
    const bounded = await runStep({ reasoningBudgetTokens: 512, terminalOnly: true }, 1_000);
    expect(bodyHead(bounded.params.grammar)).toBe("think-body ::= think-char*");
  });

  it("keeps thinking: off's plain root", async () => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE, grammarsDir);
    const deps = { registry: registry(), grammar };
    const off = resolveStepGrammar({ reasoningBudgetTokens: 512 }, deps, [], true);
    expect(off).toBe(resolveStepGrammar({}, deps, [], true));
    expect(off).toMatch(/^root ::= tool-call-array$/m);
    expect(resolveStepGrammar({ reasoningBudgetTokens: 512 }, deps, [], false))
      .toMatch(/^root ::= think-prelude tool-call-array$/m);
  });
});

describe("a Gemma channel grammar through the step", () => {
  const GEMMA_REPLY = `<|channel>thought\nok<channel|>${JSON.stringify([{ tool: "reply", args: { text: "done" } }])}`;
  const channelHead = (grammar: string) =>
    grammar.split("\n").find((line) => line.startsWith("channel-body ::= "));

  it("bounds the channel body, keeps the forced opener, and leaves the prompt alone", async () => {
    const opts = { profile: GEMMA4_THINK_PROFILE, content: GEMMA_REPLY };
    const plain = await runStep({}, 0, opts);
    expect(plain.params.grammar).toBe(plain.baseGrammar);
    expect(plain.reportedBound).toBeNull();

    const worker = await runStep({ reasoningBudgetTokens: 1_536 }, 0, opts);
    expect(worker.params.grammar).toMatch(/^root ::= channel-prelude tool-call-array$/m);
    expect(worker.params.grammar).toContain('channel-prelude ::= "<|channel>thought\\n" channel-body');
    expect(channelHead(worker.params.grammar)).toBe(
      "channel-body ::= channel-char{0,1998} | channel-char{1999} channel-body-2",
    );
    expect(worker.params.grammar).toContain("channel-body-4 ::= channel-char{0,147}");
    expect(worker.params.grammar).toMatch(/^channel-char ::= /m);
    expect(worker.params.prompt).toBe(plain.params.prompt);
    expect(worker.reportedBound).toBe(1_536);

    const final = await runStep({ reasoningBudgetTokens: 1_536, terminalOnly: true }, 0, opts);
    expect(channelHead(final.params.grammar)).toBe(channelHead(plain.baseGrammar));
    expect(final.reportedBound).toBeNull();
  });
});

describe("the step reports the worker bound only when the served request carried it", () => {
  const PLAIN_REPLY = JSON.stringify([{ tool: "reply", args: { text: "done" } }]);

  it("reports the bound a think-prelude grammar link applied", async () => {
    expect((await runStep({ reasoningBudgetTokens: 1_536 })).reportedBound).toBe(1_536);
  });

  it("reports nothing without a turn bound, on the forced final step, or at 0 (unbounded)", async () => {
    expect((await runStep({})).reportedBound).toBeNull();
    expect((await runStep({ reasoningBudgetTokens: 512, terminalOnly: true })).reportedBound).toBeNull();
    expect((await runStep({ reasoningBudgetTokens: 0 })).reportedBound).toBeNull();
  });

  it("reports nothing on a plain-instruct profile, whose grammar has no think prelude", async () => {
    const run = await runStep({ reasoningBudgetTokens: 1_536 }, 0, {
      profile: PLAIN_INSTRUCT_PROFILE,
      content: PLAIN_REPLY,
    });
    expect(run.params.grammar).toBe(run.baseGrammar);
    expect(run.reportedBound).toBeNull();
  });

  it("reports nothing when a native-tools link served, primary or fallback", async () => {
    const native = await runStep({ reasoningBudgetTokens: 1_536 }, 0, {
      toolTransport: "native_tools",
      content: PLAIN_REPLY,
    });
    expect(native.reportedBound).toBeNull();
    const fellToCloud = await runStep({ reasoningBudgetTokens: 1_536 }, 0, {
      served: { servedTransport: "native_tools" },
      content: PLAIN_REPLY,
    });
    expect(fellToCloud.reportedBound).toBeNull();
  });
});
