import { describe, expect, it } from "vitest";

import {
  LOCAL_MODELS_CATALOG,
  isFusionWorkerRating,
  parseFusionWorkerFit,
  type LocalModelDef,
  type LocalModelId,
} from "./models-catalog.js";
import { GPU_AUTO_MAX_SLOTS } from "../server/context-growth.js";
import {
  MAX_AUTO_SLOTS,
  resolveWorkerSlots,
  workerSlotFootprint,
} from "../server/worker-slots.js";
import {
  recommendWorkerModel,
  recommendedModelFor,
  workerSlotKvGb,
  workerSlotsByMemory,
} from "./recommended-model.js";

function def(
  id: string,
  recommendedRamGb: number,
  extra?: Partial<LocalModelDef>,
): LocalModelDef {
  return {
    id: id as LocalModelId,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "https://example.invalid/model.gguf",
    fileSizeGb: recommendedRamGb / 2,
    sizeLabel: `${recommendedRamGb / 2} GB`,
    description: "test model",
    maxContextLength: 8192,
    contextLabel: "8K",
    minRamGb: recommendedRamGb - 2,
    recommendedRamGb,
    family: "qwen",
    supportsVision: false,
    ...extra,
  };
}

describe("recommendedModelFor (curated catalog)", () => {
  // The machine sizes people actually have. The answer is the best-ranked
  // well-known model that runs comfortably, not the biggest one that fits.
  it.each([
    [8, "qwen-3.5-4b"],
    [16, "qwen-3.5-9b"],
    [32, "gemma-4-26b-a4b"],
    [64, "qwen-3.6-35b-a3b"],
  ])("recommends a model for a %i GB machine", (ramGb, expected) => {
    expect(recommendedModelFor(ramGb)?.id).toBe(expected);
  });

  // A dense 27B answers far slower than a model with few active weights
  // (our own benchmark), so a 32 GB machine must not default to one.
  it("never recommends the biggest model or a dense 27B on a 32 GB machine", () => {
    expect(recommendedModelFor(32)?.id).not.toBe("nemotron-3.5-30b-a3b");
    expect(recommendedModelFor(32)?.id).not.toBe("qwen-3.8-27b");
  });

  it("ranks every few-active-weights model above a dense 27B+ it fits beside", () => {
    const ranked = LOCAL_MODELS_CATALOG.filter((m) => m.recommendRank !== undefined);
    const isMoe = (m: LocalModelDef): boolean => /-A\d+B\b/.test(m.name);
    const bigDense = ranked.filter((m) => !isMoe(m) && m.recommendedRamGb >= 24);
    expect(bigDense.length).toBeGreaterThan(0);
    for (const dense of bigDense) {
      for (const moe of ranked.filter(isMoe)) {
        if (moe.recommendedRamGb > dense.recommendedRamGb) continue;
        expect(moe.recommendRank!, `${moe.id} vs ${dense.id}`).toBeLessThan(
          dense.recommendRank!,
        );
      }
    }
  });

  it("only recommends a model the machine runs comfortably", () => {
    for (const ramGb of [8, 12, 16, 20, 24, 32, 48, 64, 128]) {
      const pick = recommendedModelFor(ramGb);
      expect(pick, `${ramGb} GB`).not.toBeNull();
      expect(pick!.recommendedRamGb).toBeLessThanOrEqual(ramGb);
    }
  });

  it("has nothing to recommend below the smallest model's comfort line", () => {
    expect(recommendedModelFor(4)).toBeNull();
  });

  it("respects a download ceiling", () => {
    const pick = recommendedModelFor(64, { maxDownloadGb: 8 });
    expect(pick?.id).toBe("qwen-3.5-9b");
    expect(pick!.fileSizeGb).toBeLessThanOrEqual(8);
  });

  it("never recommends the uncensored model on any host", () => {
    for (const ramGb of [1, 8, 16, 32, 64, 512]) {
      expect(recommendedModelFor(ramGb)?.uncensored).not.toBe(true);
    }
  });

  // The recommendation depends on the machine, so a static label would
  // contradict it on every other machine size: the catalog carries none.
  it("leaves the Recommended label to the rule, never to a static tag", () => {
    const tagged = LOCAL_MODELS_CATALOG.filter((m) => m.tag === "Recommended");
    expect(tagged.map((m) => m.id)).toEqual([]);
  });
});

describe("recommendedModelFor (rules)", () => {
  it("prefers rank over size", () => {
    const catalog = [
      def("big-unranked", 32),
      def("mid-ranked-2", 16, { recommendRank: 2 }),
      def("small-ranked-1", 8, { recommendRank: 1 }),
    ];
    expect(recommendedModelFor(32, { catalog })?.id).toBe("small-ranked-1");
  });

  it("skips ranked entries the machine cannot run comfortably", () => {
    const catalog = [
      def("big-ranked-1", 32, { recommendRank: 1 }),
      def("small-ranked-2", 8, { recommendRank: 2 }),
    ];
    expect(recommendedModelFor(16, { catalog })?.id).toBe("small-ranked-2");
  });

  it("ignores a ranked uncensored entry and an unranked catalog", () => {
    const edgy = def("edgy", 8, { recommendRank: 1, uncensored: true });
    expect(recommendedModelFor(64, { catalog: [edgy] })).toBeNull();
    expect(recommendedModelFor(64, { catalog: [def("plain", 8)] })).toBeNull();
    expect(recommendedModelFor(64, { catalog: [] })).toBeNull();
  });
});

describe("catalog ranking and descriptions", () => {
  it("gives every curated entry a plain description", () => {
    for (const m of LOCAL_MODELS_CATALOG) {
      expect(m.description.trim(), m.id).not.toBe("");
      expect(m.description, m.id).not.toMatch(/mamba|imatrix|\bQAT\b/i);
    }
  });

  it("ranks only Qwen and Gemma entries, each rank used once", () => {
    const ranked = LOCAL_MODELS_CATALOG.filter((m) => m.recommendRank !== undefined);
    expect(ranked.length).toBeGreaterThan(0);
    const ranks = ranked.map((m) => m.recommendRank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const m of ranked) {
      expect(["qwen", "gemma"], m.id).toContain(m.family);
      expect(m.uncensored, m.id).not.toBe(true);
    }
  });
});

describe("fusion-worker ratings (catalog data)", () => {
  // Ratings exist only where the repo records evidence for that exact
  // model (see `LocalModelDef.fusionWorker`). A new rating needs its
  // evidence first, then a line here.
  it("rates only the models the repo has evidence for", () => {
    const rated = Object.fromEntries(
      LOCAL_MODELS_CATALOG.filter((m) => m.fusionWorker !== undefined).map((m) => [
        m.id,
        m.fusionWorker!.rating,
      ]),
    );
    expect(rated).toEqual({
      "gemma-4-12b": "ok",
      "gemma-4-31b": "poor",
      "qwen-3.6-35b-a3b": "good",
      "qwen-3.5-9b": "ok",
    });
  });

  it("gives every rating a well-formed value and a note naming its evidence", () => {
    for (const m of LOCAL_MODELS_CATALOG) {
      if (m.fusionWorker === undefined) continue;
      expect(parseFusionWorkerFit(m.fusionWorker), m.id).toEqual(m.fusionWorker);
      expect(m.fusionWorker.note, m.id).toMatch(/\.(md|ts)\b/);
    }
  });

  it("says what each rating's evidence is and is not", () => {
    for (const m of LOCAL_MODELS_CATALOG) {
      const note = m.fusionWorker?.note;
      if (note === undefined) continue;
      // A GAIA run measured the model alone, not as a fusion worker.
      if (note.includes("GAIA")) {
        expect(note, m.id).toMatch(/^single-agent GAIA L1, not a fusion-worker measurement: /);
      }
      // A field case predates the guard it produced; it says so, and its date.
      if (note.includes("guard.ts")) {
        expect(note, m.id).toMatch(/^pre-guard field incidents on \d{4}-\d{2}-\d{2}, guards added since/);
      }
      // `replaced-inputs.ts` names no model size: it is no model's evidence.
      expect(note, m.id).not.toContain("replaced-inputs");
    }
  });

  it("parses a rating and refuses anything else", () => {
    expect(parseFusionWorkerFit(undefined)).toBeUndefined();
    expect(parseFusionWorkerFit({ rating: "good", note: " measured " })).toEqual({
      rating: "good",
      note: "measured",
    });
    expect(isFusionWorkerRating("ok")).toBe(true);
    expect(isFusionWorkerRating("great")).toBe(false);
    expect(() => parseFusionWorkerFit({ rating: "great", note: "x" })).toThrow(/good\|ok\|poor/);
    expect(() => parseFusionWorkerFit({ rating: "ok", note: "  " })).toThrow(/note/);
    expect(() => parseFusionWorkerFit("good")).toThrow(/expected/);
    expect(() => parseFusionWorkerFit(null)).toThrow(/expected/);
  });
});

describe("recommendedModelFor (role worker)", () => {
  it("leaves the default role's answer unchanged", () => {
    for (const ramGb of [8, 16, 24, 32, 64]) {
      expect(recommendedModelFor(ramGb, { role: "default" })?.id).toBe(
        recommendedModelFor(ramGb)?.id,
      );
    }
  });

  it.each([
    // [ram, default pick, worker pick]
    [8, "qwen-3.5-4b", "qwen-3.5-4b"],
    [24, "gemma-4-26b-a4b", "qwen-3.5-9b"],
    [32, "gemma-4-26b-a4b", "qwen-3.5-9b"],
    [64, "qwen-3.6-35b-a3b", "qwen-3.6-35b-a3b"],
  ])("on %i GB: default %s, worker %s", (ramGb, byDefault, forWorkers) => {
    expect(recommendedModelFor(ramGb)?.id).toBe(byDefault);
    expect(recommendedModelFor(ramGb, { role: "worker" })?.id).toBe(forWorkers);
  });

  it("ranks good > ok > unrated > poor before rank", () => {
    const fit = (rating: "good" | "ok" | "poor") => ({ fusionWorker: { rating, note: "test.md" } });
    const poor = def("poor-1", 8, { recommendRank: 1, ...fit("poor") });
    const unrated = def("unrated-2", 8, { recommendRank: 2 });
    const ok = def("ok-3", 8, { recommendRank: 3, ...fit("ok") });
    const good = def("good-4", 8, { recommendRank: 4, ...fit("good") });
    const pick = (catalog: LocalModelDef[]) =>
      recommendedModelFor(64, { catalog, role: "worker" })?.id;
    expect(pick([poor, unrated, ok, good])).toBe("good-4");
    expect(pick([poor, unrated, ok])).toBe("ok-3");
    expect(pick([poor, unrated])).toBe("unrated-2");
    expect(pick([poor])).toBe("poor-1");
    // The default role ignores ratings.
    expect(recommendedModelFor(64, { catalog: [poor, good] })?.id).toBe("poor-1");
  });

  it("puts a model that holds every worker slot ahead of a better-ranked one that holds one", () => {
    const tight = def("tight-1", 20, { recommendRank: 1, fileSizeGb: 10 });
    const roomy = def("roomy-2", 16, { recommendRank: 2, fileSizeGb: 8 });
    const one = recommendWorkerModel(20, { catalog: [tight, roomy], parallel: 1 });
    expect(one?.model.id).toBe("tight-1");
    const two = recommendWorkerModel(20, { catalog: [tight, roomy], parallel: 2 });
    expect(two?.model.id).toBe("roomy-2");
    expect(two?.slots).toBe(2);
    expect(two?.needGb).toBeCloseTo(16 + workerSlotKvGb(roomy), 5);
  });

  it("says why, and how many slots fit when not all do", () => {
    const only = def("only-1", 20, { recommendRank: 1, fileSizeGb: 10 });
    const pick = recommendWorkerModel(21, { catalog: [only], parallel: 4 });
    expect(pick).toMatchObject({ slots: 1, slotsWanted: 4, fit: null });
    expect(pick!.why[0]).toContain("no fusion-worker rating");
    expect(pick!.why[1]).toMatch(/fits 1 of 4 worker slots in 21 GB/);
    expect(pick!.why[2]).toBe("catalog rank 1");
    const rated = recommendWorkerModel(64, { parallel: 2 });
    expect(rated!.why[0]).toMatch(/^rated good as a fusion worker: single-agent GAIA L1, not a fusion-worker measurement/);
    expect(rated!.why[1]).toMatch(/^fits 2 worker slots: needs about [\d.]+ GB of 64 GB RAM$/);
  });

  it("counts slots against the GPU budget too, not RAM alone", () => {
    // 64 GB RAM holds eight worker slots of a 22 GB model; a 32 GB card
    // holds the weights and about four slots' KV cache beside them.
    const big = def("big-1", 36, { recommendRank: 1, fileSizeGb: 22.4 });
    const perSlot = workerSlotKvGb(big);
    expect(workerSlotsByMemory(big, 64, null)).toBe(1 + Math.floor((64 - 36) / perSlot));
    const onCard = workerSlotsByMemory(big, 64, 32);
    expect(onCard).toBe(Math.floor((32 - 22.4) / perSlot));
    expect(onCard).toBeLessThan(workerSlotsByMemory(big, 64, null));
    const pinned = recommendWorkerModel(64, { catalog: [big], parallel: 8, gpuBudgetGb: 32 });
    expect(pinned).toMatchObject({ slots: onCard, slotsWanted: 8 });
    expect(pinned!.why[1]).toMatch(/fits \d of 8 worker slots in 64 GB RAM \/ 32 GB GPU/);
    // Never fewer than one: the model was found to fit the card already.
    expect(workerSlotsByMemory(big, 64, 20)).toBe(1);
  });

  it("sizes auto as the managed daemon does: memory fit, its slot ceilings, one on the CPU", () => {
    const small = def("small-1", 8, { recommendRank: 1, fileSizeGb: 2 });
    const held = workerSlotsByMemory(small, 128, null);
    expect(held).toBeGreaterThan(MAX_AUTO_SLOTS);
    const auto = (over: Parameters<typeof recommendWorkerModel>[1]) =>
      recommendWorkerModel(128, { catalog: [small], ...over });
    for (const [over, expected] of [
      [{}, MAX_AUTO_SLOTS],
      [{ parallel: "auto" as const }, MAX_AUTO_SLOTS],
      [{ dedicatedGpu: true, gpuBudgetGb: 80 }, GPU_AUTO_MAX_SLOTS],
      [{ cpuOnly: true }, 1],
    ] as const) {
      const pick = auto(over);
      const daemon = resolveWorkerSlots({
        contextSize: workerSlotsByMemory(small, 128, over.cpuOnly === true ? null : (over as { gpuBudgetGb?: number }).gpuBudgetGb) * workerSlotFootprint(),
        cpuOnly: over.cpuOnly === true,
        ...(over.dedicatedGpu === true ? { maxSlots: GPU_AUTO_MAX_SLOTS } : {}),
      });
      expect(pick?.slots, JSON.stringify(over)).toBe(expected);
      expect(pick?.slots).toBe(daemon);
      expect(pick?.slotsWanted).toBe(pick?.slots);
      expect(pick!.why[1]).toMatch(/^auto sizing gives \d worker slots? here/);
    }
  });

  it("treats a malformed rating as unrated and keeps the same eligibility rules", () => {
    const odd = def("odd-1", 8, {
      recommendRank: 1,
      fusionWorker: { rating: "great" as "good", note: "x" },
    });
    const edgy = def("edgy", 8, {
      recommendRank: 2,
      uncensored: true,
      fusionWorker: { rating: "good", note: "x.md" },
    });
    expect(recommendWorkerModel(64, { catalog: [odd, edgy] })?.fit).toBeNull();
    expect(recommendWorkerModel(64, { catalog: [edgy] })).toBeNull();
    expect(recommendWorkerModel(4)).toBeNull();
  });
});
