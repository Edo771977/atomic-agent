import { describe, expect, it } from "vitest";

import { renderSnapshot, toRow } from "./generate-models-dev-snapshot.js";

// A trimmed copy of the models.dev api.json shape (ATO-647).
const api = {
  moonshotai: {
    id: "moonshotai",
    models: {
      "kimi-k3.1-pro": {
        id: "kimi-k3.1-pro",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_048_576, output: 1_048_576 },
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2 },
        release_date: "2026-10-23",
      },
      "kimi-image": {
        modalities: { input: ["text"], output: ["image"] },
        limit: { context: 8000, output: 0 },
        cost: { input: 1, output: 1 },
      },
      "kimi-unlisted": { limit: { context: 32_000, output: 4000 }, cost: { input: 0, output: 0 } },
    },
  },
  "some-other-provider": {
    models: { x: { limit: { context: 1, output: 1 }, cost: { input: 1, output: 1 } } },
  },
};

describe("toRow", () => {
  it("keeps limits and prices only", () => {
    expect(toRow(api.moonshotai.models["kimi-k3.1-pro"])).toEqual({
      context: 1_048_576,
      output: 1_048_576,
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
    });
  });

  it("drops models that do not produce text or have no context limit", () => {
    expect(toRow(api.moonshotai.models["kimi-image"])).toBeUndefined();
    expect(toRow({ cost: { input: 1, output: 1 } })).toBeUndefined();
  });

  it("carries models.dev's context_over_200k tier into longContext", () => {
    expect(toRow({
      limit: { context: 1_000_000, output: 64_000 },
      cost: {
        input: 3, output: 15, cache_read: 0.3, cache_write: 3.75,
        context_over_200k: { input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5 },
      },
    })).toEqual({
      context: 1_000_000,
      output: 64_000,
      cost: {
        input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
        longContext: { thresholdTokens: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
      },
    });
  });

  it("omits a zero cache rate so it prices at the input rate, not free", () => {
    expect(toRow({
      limit: { context: 1_000_000 },
      cost: {
        input: 1.4, output: 4.4, cache_read: 0, cache_write: 0,
        context_over_200k: { input: 2.8, output: 8.8, cache_read: 0, cache_write: 0 },
      },
    })).toEqual({
      context: 1_000_000,
      cost: { input: 1.4, output: 4.4, longContext: { thresholdTokens: 200_000, input: 2.8, output: 8.8 } },
    });
    expect(toRow({ limit: { context: 8000 }, cost: { input: 1, output: 2, context_over_200k: { input: 0, output: 0 } } }))
      .toEqual({ context: 8000, cost: { input: 1, output: 2 } });
  });

  it("treats a zero price as unknown, not free", () => {
    expect(toRow(api.moonshotai.models["kimi-unlisted"])).toEqual({ context: 32_000, output: 4000 });
  });
});

describe("renderSnapshot", () => {
  const source = renderSnapshot(api, "2026-11-12");

  it("keeps only the services our presets reach", () => {
    expect(source).toContain('"moonshotai": {');
    expect(source).not.toContain("some-other-provider");
    expect(source).not.toContain("kimi-image");
  });

  it("writes one stable line per model", () => {
    expect(source).toContain(
      '    "kimi-k3.1-pro": {"context":1048576,"output":1048576,"cost":{"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2}},',
    );
    expect(source).toContain('export const MODELS_DEV_SNAPSHOT_DATE = "2026-11-12";');
    expect(source).toContain("readonly longContext?: {");
  });
});
