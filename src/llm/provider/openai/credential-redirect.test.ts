import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { fetchOpenAiCompatModels } from "./fetch-openai-compat-models.js";
import { OpenAiHttpError, openAiGetJson, openAiPostJson } from "./openai-http.js";

// On a cross-origin redirect fetch drops Authorization but forwards
// custom headers (x-api-key via apiKeyHeader), so a 302 could hand the
// key to any server, over plain http too. Requests that carry a key
// never follow a redirect.

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function redirectingPair(): Promise<{ from: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const target = await listen((req, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "m" }], choices: [] }));
  });
  const from = await listen((req, res) => {
    res.writeHead(302, { location: `${target}${req.url ?? "/"}` });
    res.end();
  });
  return { from, seen };
}

describe("requests carrying an API key do not follow redirects", () => {
  it("model listing refuses the redirect and names where it pointed", async () => {
    const { from, seen } = await redirectingPair();
    await expect(
      fetchOpenAiCompatModels(from, "SECRET", { apiKeyHeader: "x-api-key" }),
    ).rejects.toThrow(/http 302.*redirect/);
    expect(seen).toEqual([]);
  });

  it("chat requests refuse the redirect without retrying it", async () => {
    const { from, seen } = await redirectingPair();
    const deps = {
      baseUrl: from,
      apiKey: "SECRET",
      apiKeyHeader: "x-api-key",
      extraHeaders: {},
      requestTimeoutMs: 5_000,
      fetchImpl: fetch,
      label: "testprov",
    };
    const post = openAiPostJson(deps, "/v1/chat/completions", { model: "m" }, {});
    await expect(post).rejects.toBeInstanceOf(OpenAiHttpError);
    await expect(post).rejects.toMatchObject({ status: 302 });
    await expect(post).rejects.toThrow(/redirect/);
    await expect(openAiGetJson(deps, "/v1/models")).rejects.toThrow(/redirect/);
    expect(seen).toEqual([]);
  });
});
