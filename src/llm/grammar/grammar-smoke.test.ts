import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { LlamaServerClient } from "../llama-server-client.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../model-profile.js";
import { buildGrammar } from "./build-grammar.js";
import {
  GRAMMAR_SMOKE_INSTRUCTION,
  GRAMMAR_SMOKE_MAX_TOKENS,
  GRAMMAR_SMOKE_MISMATCH,
  buildGrammarSmokeRequest,
  judgeGrammarSmokeCompletion,
  runGrammarSmoke,
} from "./grammar-smoke.js";
import { hasReasoningPrelude } from "./reasoning-prelude.js";

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
  it("passes a reply call and sends the workers' thinking-off grammar, capped and uncached", async () => {
    const stub = await stubServer(answer(OK_CALL));
    const baseGrammar = await buildGrammar(QWEN_THINK_PROFILE);
    expect(hasReasoningPrelude(baseGrammar)).toBe(true);
    const verdict = await runGrammarSmoke({
      profile: QWEN_THINK_PROFILE,
      baseGrammar,
      serverTemplate: false,
      complete: stub.complete,
      partition: "local-llama",
    });
    expect(verdict).toEqual({ kind: "pass" });
    expect(stub.bodies).toHaveLength(1);
    const body = stub.bodies[0]!;
    expect(body.n_predict).toBe(GRAMMAR_SMOKE_MAX_TOKENS);
    expect(body.cache_prompt).toBe(false);
    expect(body.slot_id).toBe(-1);
    expect(typeof body.grammar).toBe("string");
    expect(hasReasoningPrelude(body.grammar as string)).toBe(false);
    expect(body.grammar as string).toMatch(/^root ::= tool-call-array$/m);
    // The Qwen template's own thinking-off marker ends the prompt.
    expect(body.prompt as string).toContain(GRAMMAR_SMOKE_INSTRUCTION);
    expect((body.prompt as string).endsWith("<think>\n\n</think>\n\n")).toBe(true);
  });

  it("fails a reply that does not parse, in the breaker's protocol-mismatch words", async () => {
    const stub = await stubServer(answer("Sure! Here is my reply: ok"));
    const verdict = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: false,
      complete: stub.complete,
    });
    expect(verdict.kind).toBe("fail");
    expect(verdict.kind === "fail" && verdict.error.startsWith(GRAMMAR_SMOKE_MISMATCH)).toBe(true);
  });

  it("fails when the server rejects the grammar", async () => {
    const stub = await stubServer((_body, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: "Failed to parse grammar" } }));
    });
    const verdict = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: false,
      complete: stub.complete,
    });
    expect(verdict).toMatchObject({ kind: "fail" });
    expect(verdict.kind === "fail" && verdict.error).toMatch(/rejected the tool-call grammar/);
  });

  it("is inconclusive on a timeout and on a reply cut at the cap", async () => {
    const silent = await stubServer(() => {});
    const timedOut = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: false,
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
        serverTemplate: false,
        complete: repaired.complete,
      }),
    ).toEqual({ kind: "pass" });
    const cut = await stubServer(answer("Let me think about this format check", { truncated: true }));
    const truncated = await runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: false,
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
        serverTemplate: false,
        complete: silent.complete,
        signal: before.signal,
      }),
    ).toMatchObject({ kind: "inconclusive", reason: "cancelled" });
    expect(silent.bodies).toHaveLength(0);

    const during = new AbortController();
    const running = runGrammarSmoke({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: grammar,
      serverTemplate: false,
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
      serverTemplate: false,
      complete: client.complete.bind(client),
    });
    expect(verdict).toMatchObject({ kind: "inconclusive", reason: "unreachable" });
  });
});

describe("buildGrammarSmokeRequest", () => {
  it("frames a Gemma prompt in its own turns and leaves the server template off", async () => {
    const request = buildGrammarSmokeRequest({
      profile: GEMMA4_THINK_PROFILE,
      baseGrammar: await buildGrammar(GEMMA4_THINK_PROFILE),
      serverTemplate: false,
    });
    expect(request.prompt.startsWith("<|turn>system\n")).toBe(true);
    expect(request.prompt.endsWith("<|turn>model\n")).toBe(true);
    expect(request.prompt).not.toContain("<|think|>");
    expect(request.chat).toBeUndefined();
    expect(hasReasoningPrelude(request.grammar!)).toBe(false);
  });

  it("asks the server's template with thinking off when the profile uses it", async () => {
    const request = buildGrammarSmokeRequest({
      profile: PLAIN_INSTRUCT_PROFILE,
      baseGrammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
      serverTemplate: true,
      partition: "lm",
    });
    expect(request.chat).toMatchObject({ enableThinking: false, user: GRAMMAR_SMOKE_INSTRUCTION });
    expect(request.sessionId).toBe("grammar-smoke:lm");
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
});
