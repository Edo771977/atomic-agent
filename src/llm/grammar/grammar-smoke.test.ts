import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { LlamaServerClient } from "../llama-server-client.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../model-profile.js";
import { NO_SERVER_TEMPLATE } from "../server-template-policy.js";
import { buildGrammar, buildGrammarForTools } from "./build-grammar.js";
import {
  GRAMMAR_SMOKE_INSTRUCTION,
  GRAMMAR_SMOKE_MAX_TOKENS,
  GRAMMAR_SMOKE_MISMATCH,
  GRAMMAR_SMOKE_THINK_TOKENS,
  buildGrammarSmokeRequest,
  judgeGrammarSmokeCompletion,
  runGrammarSmoke,
} from "./grammar-smoke.js";
import { hasReasoningPrelude, withReasoningBudget, withoutReasoningPrelude } from "./reasoning-prelude.js";

/**
 * A llama-server stand-in: `/completion` answers with the same body shape
 * as `eval/scripts/stub-llama-server.mjs` (content, stop, truncated,
 * timings), from whatever the case hands it. Every request body is kept.
 */
type Reply = (body: Record<string, unknown>, res: ServerResponse) => void;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    content,
    stop: true,
    truncated: false,
    tokens_cached: 0,
    slot_id: 0,
    model: "eval-stub",
    timings: { prompt_ms: 1, predicted_ms: 1, prompt_n: 60, predicted_n: 12 },
    ...extra,
  };
}

function answer(content: string, extra?: Record<string, unknown>): Reply {
  return (_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion(content, extra)));
  };
}

async function stubServer(reply: Reply) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      bodies.push(body);
      reply(body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const client = new LlamaServerClient({
    baseUrl: `http://127.0.0.1:${port}`,
    completionRetries: 0,
    requestTimeoutMs: 60_000,
  });
  return { bodies, complete: client.complete.bind(client) };
}

const OK_CALL = '[{"tool":"reply","args":{"text":"ok"}}]';

describe("runGrammarSmoke against a stub llama-server", () => {
  it("sends a worker step's thinking-on grammar with a short think bound, and reads the prefilled think", async () => {
    // What a grammar-served Qwen completion looks like: mid-think, since
    // the prompt prefilled the open tag; the bound forced the close.
    const stub = await stubServer(answer(`Reply ok.</think>\n${OK_CALL}`));
    const baseGrammar = await buildGrammar(QWEN_THINK_PROFILE);
    expect(hasReasoningPrelude(baseGrammar)).toBe(true);
    const tools = ["os.fs.read", "os.shell.run", "reply"];
    const verdict = await runGrammarSmoke({
      profile: QWEN_THINK_PROFILE,
      baseGrammar,
      serverTemplate: NO_SERVER_TEMPLATE,
      thinking: "auto",
      toolNames: tools,
      complete: stub.complete,
      partition: "local-llama",
    });
    expect(verdict).toEqual({ kind: "pass" });
    expect(stub.bodies).toHaveLength(1);
    const body = stub.bodies[0]!;
    expect(body.n_predict).toBe(GRAMMAR_SMOKE_MAX_TOKENS);
    expect(body.cache_prompt).toBe(false);
    const grammar = body.grammar as string;
    // The worker's grammar, prelude and tool set included, its think
    // bound tightened to the check's.
    expect(hasReasoningPrelude(grammar)).toBe(true);
    expect(grammar).toBe(
      buildGrammarForTools(withReasoningBudget(baseGrammar, GRAMMAR_SMOKE_THINK_TOKENS * 4), tools),
    );
    expect(grammar).toMatch(/^think-body ::= think-char\{0,64\}$/m);
    // The prompt ends on the open-tag prefill, as a worker step's does.
    expect(body.prompt as string).toContain(GRAMMAR_SMOKE_INSTRUCTION);
    expect((body.prompt as string).endsWith("<think>\n")).toBe(true);
  });

  it("follows thinking: off as the step does: no prelude, the template's disabled marker", async () => {
    const stub = await stubServer(answer(OK_CALL));
    const baseGrammar = await buildGrammar(QWEN_THINK_PROFILE);
    const verdict = await runGrammarSmoke({
      profile: QWEN_THINK_PROFILE,
      baseGrammar,
      serverTemplate: NO_SERVER_TEMPLATE,
      thinking: "off",
      complete: stub.complete,
    });
    expect(verdict).toEqual({ kind: "pass" });
    const body = stub.bodies[0]!;
    expect(body.grammar).toBe(buildGrammarForTools(withoutReasoningPrelude(baseGrammar), ["reply"]));
    expect(body.grammar as string).toMatch(/^root ::= tool-call-array$/m);
    expect((body.prompt as string).endsWith("<think>\n\n</think>\n\n")).toBe(true);
  });

  it("fails a reply that does not parse, in the breaker's protocol-mismatch words", async () => {
    const stub = await stubServer(answer("Sure! Here is my reply: ok"));
    const verdict = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: NO_SERVER_TEMPLATE,
      complete: stub.complete,
    });
    expect(verdict).toMatchObject({ kind: "fail", cause: "reply-unparsed" });
    expect(verdict.kind === "fail" && verdict.error.startsWith(GRAMMAR_SMOKE_MISMATCH)).toBe(true);
    expect(verdict.kind === "fail" && verdict.error).toMatch(/the reply under the workers' grammar did not parse/);
  });

  it("fails when the server rejects the grammar", async () => {
    const stub = await stubServer((_body, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: "Failed to parse grammar" } }));
    });
    const verdict = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: NO_SERVER_TEMPLATE,
      complete: stub.complete,
    });
    expect(verdict).toMatchObject({ kind: "fail", cause: "grammar-rejected" });
    expect(verdict.kind === "fail" && verdict.error).toMatch(/the local server rejected the workers' grammar/);
  });

  it("is inconclusive, not a failure, on a 4xx that does not name the grammar and on a 5xx", async () => {
    for (const [status, message] of [
      [400, "context size exceeded"],
      [500, "failed to parse grammar"],
    ] as const) {
      const stub = await stubServer((_body, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: status, message } }));
      });
      const verdict = await runGrammarSmoke({
        profile: PLAIN_INSTRUCT_PROFILE,
        baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
        serverTemplate: NO_SERVER_TEMPLATE,
        complete: stub.complete,
      });
      expect(verdict.kind, `${status} ${message}`).toBe("inconclusive");
    }
  });

  it("is inconclusive on a timeout and on a reply cut at the cap", async () => {
    const silent = await stubServer(() => {});
    const timedOut = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: NO_SERVER_TEMPLATE,
      complete: silent.complete,
      timeoutMs: 150,
    });
    expect(timedOut).toMatchObject({ kind: "inconclusive", reason: "timeout" });

    // A cut call that JSON repair can close still passes, as on a step;
    // only one that cannot be read and ran into the cap has no verdict.
    const repaired = await stubServer(answer('[{"tool":"reply","args":{"text":"ok ok ok', { truncated: true }));
    expect(
      await runGrammarSmoke({
        profile: PLAIN_INSTRUCT_PROFILE,
        baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
        serverTemplate: NO_SERVER_TEMPLATE,
        complete: repaired.complete,
      }),
    ).toEqual({ kind: "pass" });
    const cut = await stubServer(answer("Let me think about this format check", { truncated: true }));
    const truncated = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: NO_SERVER_TEMPLATE,
      complete: cut.complete,
    });
    expect(truncated).toMatchObject({ kind: "inconclusive", reason: "truncated" });
  });

  it("respects cancellation, before and during the request", async () => {
    const silent = await stubServer(() => {});
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const before = new AbortController();
    before.abort();
    expect(
      await runGrammarSmoke({
        profile: PLAIN_INSTRUCT_PROFILE,
        baseGrammar: grammar,
        serverTemplate: NO_SERVER_TEMPLATE,
        complete: silent.complete,
        signal: before.signal,
      }),
    ).toMatchObject({ kind: "inconclusive", reason: "cancelled" });
    expect(silent.bodies).toHaveLength(0);

    const during = new AbortController();
    const running = runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: grammar,
      serverTemplate: NO_SERVER_TEMPLATE,
      complete: silent.complete,
      signal: during.signal,
    });
    setTimeout(() => during.abort(), 50);
    expect(await running).toMatchObject({ kind: "inconclusive", reason: "cancelled" });
  });

  it("is inconclusive when nothing answers at all", async () => {
    const client = new LlamaServerClient({ baseUrl: "http://127.0.0.1:1", completionRetries: 0 });
    const verdict = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: NO_SERVER_TEMPLATE,
      complete: client.complete.bind(client),
    });
    expect(verdict).toMatchObject({ kind: "inconclusive", reason: "unreachable" });
  });
});

describe("buildGrammarSmokeRequest", () => {
  it("frames a Gemma prompt as a worker's: its turns, its think token, the prelude with its open sentinel", async () => {
    for (const thinking of ["auto", "off"] as const) {
      const request = buildGrammarSmokeRequest({
        profile: GEMMA4_THINK_PROFILE,
        baseGrammar: await buildGrammar(GEMMA4_THINK_PROFILE),
        serverTemplate: NO_SERVER_TEMPLATE,
        thinking,
      });
      expect(request.prompt.startsWith("<|turn>system\n<|think|>\n")).toBe(true);
      expect(request.prompt.endsWith("<|turn>model\n")).toBe(true);
      expect(request.chat).toBeUndefined();
      // `off` cannot be honoured on Gemma's built prompt, as on a step.
      expect(hasReasoningPrelude(request.grammar!)).toBe(true);
      expect(request.grammar).toContain('"<|channel>thought\\n"');
    }
  });

  it("asks the server's template with the step's own thinking switch", async () => {
    const plain = buildGrammarSmokeRequest({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: { useServerTemplate: true, enableThinking: undefined },
      partition: "lm",
    });
    expect(plain.chat).toMatchObject({ user: GRAMMAR_SMOKE_INSTRUCTION });
    expect(plain.chat).not.toHaveProperty("enableThinking");
    expect(plain.sessionId).toBe("grammar-smoke:lm");
    const off = buildGrammarSmokeRequest({
      profile: QWEN_THINK_PROFILE,
      baseGrammar: await buildGrammar(QWEN_THINK_PROFILE),
      serverTemplate: { useServerTemplate: true, enableThinking: false },
      thinking: "off",
    });
    expect(off.chat).toMatchObject({ enableThinking: false });
    // The step keeps the prelude on the template path; so does the check.
    expect(hasReasoningPrelude(off.grammar!)).toBe(true);
  });

  it("goes to the slot it is given, else lets the server pick (-1)", async () => {
    const input = {
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: NO_SERVER_TEMPLATE,
    };
    expect(buildGrammarSmokeRequest(input).slotId).toBe(-1);
    expect(buildGrammarSmokeRequest({ ...input, slotId: 2 })).toMatchObject({ slotId: 2, cachePrompt: false });
  });

  it("admits the worker's tools, and reply even when it is not named", async () => {
    const baseGrammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const request = buildGrammarSmokeRequest({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar,
      serverTemplate: NO_SERVER_TEMPLATE,
      toolNames: ["os.fs.read"],
    });
    expect(request.grammar).toBe(buildGrammarForTools(baseGrammar, ["os.fs.read", "reply"]));
  });
});

describe("judgeGrammarSmokeCompletion", () => {
  it("reads the profile's reasoning tags like the step parser does", () => {
    const content = `<think>fine</think>${OK_CALL}`;
    expect(
      judgeGrammarSmokeCompletion({ content, truncated: false }, QWEN_THINK_PROFILE),
    ).toEqual({ kind: "pass" });
    expect(
      judgeGrammarSmokeCompletion({ content: "", truncated: false }, QWEN_THINK_PROFILE).kind,
    ).toBe("fail");
  });

  it("re-adds the prefilled open tag only where the prompt carried it", () => {
    const midThink = `checking</think>\n${OK_CALL}`;
    expect(judgeGrammarSmokeCompletion({ content: midThink, truncated: false }, QWEN_THINK_PROFILE)).toEqual({
      kind: "pass",
    });
    // Gemma emits its own open sentinel: nothing is added.
    expect(
      judgeGrammarSmokeCompletion(
        { content: `<|channel>thought\nok<channel|>${OK_CALL}`, truncated: false },
        GEMMA4_THINK_PROFILE,
      ),
    ).toEqual({ kind: "pass" });
    // Thinking off: the completion starts on the call.
    expect(
      judgeGrammarSmokeCompletion({ content: OK_CALL, truncated: false }, QWEN_THINK_PROFILE, { thinkingOff: true }),
    ).toEqual({ kind: "pass" });
  });

  it("never fails a reply that did not finish on its own", () => {
    const cut = "a think that ran on";
    for (const end of [
      { truncated: true },
      { truncated: false, finishReason: "length" },
      { truncated: false, stopType: "limit" },
      { truncated: false, stopType: "word" },
    ] as const) {
      expect(
        judgeGrammarSmokeCompletion({ content: cut, ...end }, QWEN_THINK_PROFILE).kind,
        JSON.stringify(end),
      ).toBe("inconclusive");
    }
    expect(
      judgeGrammarSmokeCompletion({ content: cut, truncated: false, stopType: "eos" }, QWEN_THINK_PROFILE),
    ).toMatchObject({ kind: "fail", cause: "reply-unparsed" });
  });
});
